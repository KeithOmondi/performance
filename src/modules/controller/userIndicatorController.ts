import { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { sendMail } from "../../utils/sendMail";
import {
  submissionReceivedTemplate,
  adminReviewNeededTemplate,
  submissionRejectedTemplate,
} from "../../utils/mailTemplates";
import { IUser } from "../../types/user.types";
import axios from "axios";
import {
  deleteFromCloudinary,
  uploadMultipleToCloudinary,
} from "../../config/cloudinary";
import { PoolClient } from "pg";
import crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIVILEGED_ROLES = ["admin", "superadmin", "examiner"] as const;
const MAX_ACHIEVED_VALUE = 999999999.99;
const MAX_NOTES_LENGTH = 5000;
const MAX_DESCRIPTION_LENGTH = 500;
const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
  "video/mp4",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ─── Types ────────────────────────────────────────────────────────────────────

interface Submission {
  id: string;
  review_status: string;
  resubmission_count: number;
  admin_comment?: string;
  quarter: number;
  year: number;
}

interface IndicatorWithActivity {
  reporting_cycle: string;
  status: string;
  activityDescription?: string;
  activity?: { description?: string };
  instructions?: string;
  unit?: string;
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAuthUser(req: Request): IUser {
  return (req as Request & { user: IUser }).user;
}

async function getUserTeamIds(userId: string): Promise<string[]> {
  const res = await pool.query(
    "SELECT team_id FROM team_members WHERE user_id = $1",
    [userId],
  );
  return res.rows.map((r: { team_id: string }) => r.team_id);
}

function quarterToInt(raw: string | number): number {
  const s = String(raw).trim();
  if (s === "0" || s.toLowerCase() === "annual") return 0;
  const n = parseInt(s.replace(/^Q/i, ""), 10);
  if (isNaN(n))
    throw new AppError(`Invalid quarter format: "${raw}". Please use Q1, Q2, Q3, Q4, or "Annual".`, 400);
  if (n < 1 || n > 4)
    throw new AppError(`Quarter must be between 1 and 4. Received: ${n}`, 400);
  return n;
}

function quarterDisplay(q: number, year: number): string {
  return q === 0 ? `Annual ${year}` : `Q${q} ${year}`;
}

function ownershipClause(
  baseParams: unknown[],
  userId: string,
  teamIds: string[],
  tableAlias = "i",
): { clause: string; params: unknown[] } {
  const params = [...baseParams, userId];
  const userIdx = params.length;

  let clause = `(${tableAlias}.assignee_id = $${userIdx} AND ${tableAlias}.assignee_model = 'User'`;

  if (teamIds.length > 0) {
    params.push(teamIds);
    const teamIdx = params.length;
    clause += ` OR (${tableAlias}.assignee_id = ANY($${teamIdx}::uuid[]) AND ${tableAlias}.assignee_model = 'Team')`;
  }

  clause += ")";
  return { clause, params };
}

async function assertIndicatorOwnership(
  client: PoolClient,
  indicator: Record<string, unknown>,
  userId: string,
  teamIds: string[],
): Promise<void> {
  const { assignee_id, assignee_model } = indicator;

  if (assignee_model === "User") {
    if (assignee_id !== userId)
      throw new AppError("You don't have permission to access this indicator. It is assigned to another user.", 403);
    return;
  }

  if (assignee_model === "Team") {
    if (teamIds.includes(assignee_id as string)) return;
    const memberCheck = await client.query(
      `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
      [assignee_id, userId],
    );
    if (memberCheck.rowCount === 0)
      throw new AppError(
        "You don't have permission to access this indicator. You are not a member of the assigned team.",
        403,
      );
    return;
  }

  throw new AppError("Unable to verify your permission for this indicator. Please contact support.", 403);
}

function validateSubmissionInput(
  notes: unknown,
  achievedValue: unknown,
): { notes: string | null; achievedValue: number | null } {
  const notesStr = typeof notes === "string" && notes.trim().length > 0 ? notes.trim() : null;
  
  let achievedNum: number | null = null;
  if (achievedValue !== undefined && achievedValue !== null && achievedValue !== "") {
    const numValue = Number(achievedValue);
    if (!isNaN(numValue) && numValue >= 0 && numValue <= MAX_ACHIEVED_VALUE) {
      achievedNum = numValue;
    }
  }
  
  return { notes: notesStr, achievedValue: achievedNum };
}

function validateFiles(files: Express.Multer.File[]): void {
  for (const file of files) {
    if (!ALLOWED_FILE_TYPES.includes(file.mimetype))
      throw new AppError(
        `File "${file.originalname}" is not supported. Allowed types: ${ALLOWED_FILE_TYPES.join(", ")}`,
        400,
      );
    if (file.size > MAX_FILE_SIZE)
      throw new AppError(
        `File "${file.originalname}" exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB size limit. Please compress or split your file.`,
        400,
      );
  }
}

function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function checkIdempotency(client: PoolClient, key: string): Promise<boolean> {
  if (!key) return false;
  const result = await client.query(
    "SELECT 1 FROM idempotency_records WHERE key = $1 AND expires_at > NOW()",
    [key],
  );
  return result.rows.length > 0;
}

async function storeIdempotencyKey(client: PoolClient, key: string): Promise<void> {
  if (!key) return;
  await client.query(
    `INSERT INTO idempotency_records (key, expires_at)
     VALUES ($1, NOW() + INTERVAL '24 hours')
     ON CONFLICT (key) DO NOTHING`,
    [key],
  );
}

async function uploadDocumentsWithRetry(
  files: Express.Multer.File[],
  descriptions: string | string[],
  maxRetries = 3,
): Promise<
  Array<{
    url: string;
    public_id: string;
    file_type: "image" | "video" | "raw";
    file_name: string;
    description: string;
  }>
> {
  console.log(`📁 [uploadDocumentsWithRetry] Starting upload of ${files.length} files`);
  
  let lastError: Error | null = null;

  // Ensure descriptions is an array
  let descriptionsArray: string[] = [];
  if (descriptions) {
    if (Array.isArray(descriptions)) {
      descriptionsArray = descriptions;
    } else if (typeof descriptions === 'string') {
      descriptionsArray = [descriptions];
    }
  }
  
  // Pad descriptions array if needed
  while (descriptionsArray.length < files.length) {
    descriptionsArray.push('');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📁 [uploadDocumentsWithRetry] Attempt ${attempt} of ${maxRetries}`);
      
      const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
      
      console.log(`✅ [uploadDocumentsWithRetry] Uploaded ${uploads.length} files successfully`);

      return uploads.map((upload, i) => ({
        url: upload.secure_url,
        public_id: upload.public_id,
        file_type: resolveFileType(upload.resource_type, files[i].mimetype),
        file_name: files[i].originalname,
        description: (descriptionsArray[i] ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
      }));
    } catch (error) {
      lastError = error as Error;
      console.error(`❌ [uploadDocumentsWithRetry] Attempt ${attempt} failed:`, lastError.message);
      if (attempt < maxRetries) {
        const delay = 1000 * attempt;
        console.log(`⏳ [uploadDocumentsWithRetry] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new AppError(
    `Unable to upload your documents after ${maxRetries} attempts. Please try again later. Error: ${lastError?.message}`,
    500,
  );
}

function resolveFileType(
  resourceType: string,
  mimetype: string,
): "image" | "video" | "raw" {
  if (resourceType === "video") return "video";
  if (mimetype === "application/pdf") return "raw";
  return "image";
}

// ─── Base query ───────────────────────────────────────────────────────────────

const USER_INDICATOR_BASE_QUERY = `
  SELECT DISTINCT ON (i.id)
    i.*,
    u.name                                        AS "assigneeName",
    ab.name                                       AS "assignedByName",
    sp.perspective,

    (SELECT json_build_object('title', title)
       FROM strategic_objectives WHERE id = i.objective_id) AS objective,
    (SELECT json_build_object('description', description)
       FROM strategic_activities  WHERE id = i.activity_id) AS activity,

    COALESCE(
      (
        SELECT json_object_agg(quarter_key, quarter_submissions)
        FROM (
          SELECT
            CONCAT(
              CASE WHEN s.quarter = 0 THEN 'Annual' ELSE 'Q' || s.quarter::text END,
              '_', s.year
            ) AS quarter_key,

            json_agg(
              json_build_object(
                'id',                s.id,
                'quarter',           s.quarter,
                'year',              s.year,
                'notes',             s.notes,
                'achievedValue',     s.achieved_value,
                'reviewStatus',      s.review_status,
                'adminComment',      s.admin_comment,
                'resubmissionCount', s.resubmission_count,
                'submittedAt',       s.submitted_at,
                'submittedBy',       s.submitted_by,
                'isReviewed',        s.is_reviewed,
                'documents', (
                  SELECT COALESCE(
                    json_agg(
                      json_build_object(
                        'id',              d.id,
                        'evidenceUrl',     d.evidence_url,
                        'fileType',        d.file_type,
                        'fileName',        d.file_name,
                        'description',     d.description,
                        'status',          d.status,
                        'rejectionReason', d.rejection_reason
                      )
                      ORDER BY d.uploaded_at DESC
                    ),
                    '[]'::json
                  )
                  FROM submission_documents d
                  WHERE d.submission_id = s.id AND d.deleted_at IS NULL
                )
              ) ORDER BY s.submitted_at DESC
            ) AS quarter_submissions

          FROM submissions s
          WHERE s.indicator_id = i.id
          GROUP BY
            CASE WHEN s.quarter = 0 THEN 'Annual' ELSE 'Q' || s.quarter::text END,
            s.year
        ) grouped
      ),
      '{}'
    ) AS submissions

  FROM indicators i
  LEFT JOIN users u    ON i.assignee_id = u.id  AND i.assignee_model = 'User'
  LEFT JOIN teams t    ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
  LEFT JOIN users ab   ON i.assigned_by = ab.id
  LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
`;

// ─── Helper to get submission with documents ──────────────────────────────────

async function getSubmissionWithDocuments(
  client: PoolClient,
  submissionId: string,
): Promise<any> {
  const { rows } = await client.query(
    `SELECT s.*, 
            json_agg(
              json_build_object(
                'id', d.id,
                'evidenceUrl', d.evidence_url,
                'evidencePublicId', d.evidence_public_id,
                'fileType', d.file_type,
                'fileName', d.file_name,
                'description', d.description,
                'status', d.status,
                'rejectionReason', d.rejection_reason,
                'uploadedAt', d.uploaded_at
              )
            ) FILTER (WHERE d.id IS NOT NULL) AS documents
     FROM submissions s
     LEFT JOIN submission_documents d ON d.submission_id = s.id AND d.deleted_at IS NULL
     WHERE s.id = $1
     GROUP BY s.id`,
    [submissionId],
  );
  return rows[0] || null;
}

// ─── Controller ───────────────────────────────────────────────────────────────

interface IUserIndicatorController {
  getMyIndicators: RequestHandler;
  getIndicatorDetails: RequestHandler;
  submitProgress: RequestHandler;
  resubmitProgress: RequestHandler;
  addDocuments: RequestHandler;
  updateSubmission: RequestHandler;
  deletePendingDocument: RequestHandler;
  getRejectedSubmissions: RequestHandler;
  updateDocumentDescription: RequestHandler;
  streamFile: RequestHandler;
  updateDocumentDescriptions: RequestHandler;
  deleteDocument: RequestHandler;
  _sendAlerts: (
    user: IUser,
    indicator: Record<string, unknown>,
    quarter: number,
    year: number,
    achievedValue: number | null,
    actionType: "submitted" | "resubmitted" | "rejected",
    rejectionReason?: string,
    rejectedBy?: "Admin" | "Super Admin",
  ) => Promise<void>;
}

export const UserIndicatorController: IUserIndicatorController = {
  getMyIndicators: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause, params } = ownershipClause([], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY} WHERE ${clause} ORDER BY i.id, i.updated_at DESC`,
      params,
    );

    res.status(200).json({ 
      success: true, 
      message: `Found ${rows.length} indicator(s) assigned to you.`,
      results: rows.length, 
      data: rows 
    });
  }),

  getIndicatorDetails: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause, params } = ownershipClause([req.params.id], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY} WHERE i.id = $1 AND ${clause} ORDER BY i.id LIMIT 1`,
      params,
    );

    if (rows.length === 0)
      throw new AppError("Indicator not found or you don't have permission to view it.", 404);

    res.status(200).json({ success: true, data: rows[0] });
  }),

  /**
   * ✅ SUBMIT PROGRESS - First-time submission with improved logging and verification
   */
  submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { quarter, year, achievedValue, notes, descriptions, idempotencyKey } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];
    const user = getAuthUser(req);

    console.log(`📝 [submitProgress] START for indicator ${id}`, {
      quarter,
      year,
      achievedValue,
      notes: notes ? notes.substring(0, 50) : null,
      filesCount: files.length,
    });

    if (!quarter || !year) {
      throw new AppError("Both quarter and year are required for submission.", 400);
    }

    const validated = validateSubmissionInput(notes, achievedValue);
    console.log(`📝 [submitProgress] Validated input:`, {
      notes: validated.notes ? validated.notes.substring(0, 50) : null,
      achievedValue: validated.achievedValue,
    });

    if (files.length > 0) {
      console.log(`📁 [submitProgress] Validating ${files.length} files`);
      validateFiles(files);
    }

    const quarterNum = parseInt(String(quarter), 10);
    const yearNum = parseInt(String(year), 10);

    if (isNaN(quarterNum) || isNaN(yearNum)) {
      throw new AppError("Please provide valid quarter (1-4) and year numbers.", 400);
    }

    const { rows: indicatorRows } = await pool.query(
      `SELECT i.*, sa.description AS "activityDescription"
       FROM indicators i
       LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
       WHERE i.id = $1`,
      [id],
    );

    if (!indicatorRows[0]) {
      throw new AppError("Indicator not found.", 404);
    }

    const indicator = indicatorRows[0] as IndicatorWithActivity;
    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        res.status(200).json({ 
          success: true, 
          message: "This submission has already been processed.", 
          idempotent: true 
        });
        return;
      }

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const reportingCycle = indicator.reporting_cycle as string;
      if (reportingCycle === "Annual" && quarterNum !== 0) {
        throw new AppError("Annual indicators must use quarter 'Annual' or 0.", 400);
      }
      if (reportingCycle !== "Annual" && (quarterNum < 1 || quarterNum > 4)) {
        throw new AppError(`Invalid quarter. Use Q1-Q4. Received: Q${quarterNum}`, 400);
      }

      // Check for existing submissions
      const existingSubmissions = await client.query(
        `SELECT id, review_status FROM submissions
         WHERE indicator_id = $1 AND quarter = $2 AND year = $3
         FOR UPDATE`,
        [id, quarterNum, yearNum],
      );

      console.log(`📝 [submitProgress] Existing submissions:`, existingSubmissions.rows.length);

      if (existingSubmissions.rows.length > 0) {
        const existing = existingSubmissions.rows[0] as { review_status: string };
        if (existing.review_status === "Pending") {
          throw new AppError(
            `A pending submission already exists for ${quarterDisplay(quarterNum, yearNum)}. Use "Add Documents" to add more evidence.`,
            409,
          );
        }
        if (existing.review_status === "Accepted") {
          throw new AppError(
            `${quarterDisplay(quarterNum, yearNum)} has already been accepted and cannot be modified.`,
            409,
          );
        }
        if (existing.review_status === "Rejected") {
          throw new AppError(
            `A rejected submission exists for ${quarterDisplay(quarterNum, yearNum)}. Use the "Resubmit" endpoint instead.`,
            409,
          );
        }
      }

      // Create new submission
      const { rows: inserted } = await client.query(
        `INSERT INTO submissions
           (indicator_id, quarter, year, achieved_value, notes,
            review_status, submitted_by, resubmission_count, is_reviewed)
         VALUES ($1, $2, $3, $4, $5, 'Pending', $6, 0, false)
         RETURNING id`,
        [id, quarterNum, yearNum, validated.achievedValue, validated.notes, user.id],
      );

      const submissionId = (inserted[0] as { id: string }).id;
      console.log(`✅ [submitProgress] Created submission ID: ${submissionId}`);

      // Upload documents with descriptions
      if (files.length > 0) {
        console.log(`📁 [submitProgress] Uploading ${files.length} files...`);
        
        try {
          const uploadedDocs = await uploadDocumentsWithRetry(files, descriptions || []);
          console.log(`✅ [submitProgress] Uploaded ${uploadedDocs.length} documents`);

          for (const doc of uploadedDocs) {
            await client.query(
              `INSERT INTO submission_documents
                 (submission_id, evidence_url, evidence_public_id,
                  file_type, file_name, description, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
              [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
            );
          }
          console.log(`✅ [submitProgress] Saved ${uploadedDocs.length} documents to DB`);
        } catch (uploadError) {
          console.error(`❌ [submitProgress] Upload failed:`, uploadError);
          throw new AppError(
            `Failed to upload documents: ${(uploadError as Error).message}`,
            500
          );
        }
      }

      // Update indicator status if not already completed
      if (indicator.status !== "Completed") {
        await client.query(
          `UPDATE indicators SET status = 'Awaiting Admin Approval', updated_at = NOW() WHERE id = $1`,
          [id],
        );
      }

      // Verify the submission was saved correctly
      const verifyResult = await client.query(
        `SELECT id, quarter, year, review_status FROM submissions WHERE id = $1`,
        [submissionId],
      );
      console.log(`✅ [submitProgress] Verification:`, verifyResult.rows[0]);

      // Verify documents were saved
      const docVerify = await client.query(
        `SELECT COUNT(*) FROM submission_documents WHERE submission_id = $1 AND deleted_at IS NULL`,
        [submissionId],
      );
      console.log(`✅ [submitProgress] Documents in DB:`, docVerify.rows[0].count);

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [submitProgress] COMPLETE for ${quarterDisplay(quarterNum, yearNum)}`);

      // Send alerts
      UserIndicatorController._sendAlerts(
        user, indicator, quarterNum, yearNum,
        validated.achievedValue, "submitted",
      ).catch((err: Error) => console.error("[submitProgress] Mail Error:", err));

      // Get full submission data for response
      const fullSubmission = await getSubmissionWithDocuments(client, submissionId);

      res.status(201).json({
        success: true,
        message: `Your submission for ${quarterDisplay(quarterNum, yearNum)} has been received and is pending admin review.`,
        data: { 
          submissionId, 
          quarter: quarterNum, 
          year: yearNum,
          submission: fullSubmission
        },
      });
    } catch (error) {
      console.error(`❌ [submitProgress] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  /**
   * ✅ RESUBMIT PROGRESS - For rejected submissions with improved logging
   */
  resubmitProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id: indicatorId } = req.params;
    const { notes, achievedValue, descriptions, idempotencyKey, quarter, year } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];
    const user = getAuthUser(req);

    console.log(`📝 [resubmitProgress] START for indicator ${indicatorId}`, {
      quarter,
      year,
      achievedValue,
      filesCount: files.length,
    });

    if (!quarter || !year) {
      throw new AppError("Quarter and year are required for resubmission.", 400);
    }

    const validated = validateSubmissionInput(notes, achievedValue);
    if (files.length > 0) validateFiles(files);

    const quarterNum = quarterToInt(quarter);
    const yearNum = parseInt(String(year), 10);

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        res.status(200).json({ 
          success: true, 
          message: "This resubmission has already been processed.", 
          idempotent: true 
        });
        return;
      }

      const indRes = await client.query("SELECT * FROM indicators WHERE id = $1 FOR UPDATE", [indicatorId]);
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      
      const indicator = indRes.rows[0] as IndicatorWithActivity;
      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const rejectedSubmission = await client.query(
        `SELECT id, review_status, resubmission_count, admin_comment
         FROM submissions
         WHERE indicator_id = $1 AND quarter = $2 AND year = $3 AND review_status = 'Rejected'
         ORDER BY submitted_at DESC
         LIMIT 1
         FOR UPDATE`,
        [indicatorId, quarterNum, yearNum],
      );

      if (rejectedSubmission.rows.length === 0) {
        throw new AppError(
          `No rejected submission found for ${quarterDisplay(quarterNum, yearNum)}. Only rejected submissions can be resubmitted.`,
          404,
        );
      }

      const latestSubmission = rejectedSubmission.rows[0] as Submission;
      const newResubmissionCount = latestSubmission.resubmission_count + 1;

      // Update the rejected row
      const { rows: updated } = await client.query(
        `UPDATE submissions
         SET achieved_value            = $1,
             notes                     = $2,
             review_status             = 'Pending',
             submitted_by              = $3,
             resubmission_count        = $4,
             resubmitted_from_rejection = true,
             is_reviewed               = false,
             admin_comment             = NULL,
             submitted_at              = NOW()
         WHERE id = $5
         RETURNING id`,
        [validated.achievedValue, validated.notes, user.id,
         newResubmissionCount, latestSubmission.id],
      );

      const newSubmissionId = (updated[0] as { id: string }).id;
      console.log(`✅ [resubmitProgress] Updated submission ID: ${newSubmissionId}`);

      if (files.length > 0) {
        console.log(`📁 [resubmitProgress] Uploading ${files.length} files...`);
        
        try {
          const uploadedDocs = await uploadDocumentsWithRetry(files, descriptions || []);
          console.log(`✅ [resubmitProgress] Uploaded ${uploadedDocs.length} documents`);

          for (const doc of uploadedDocs) {
            await client.query(
              `INSERT INTO submission_documents
                 (submission_id, evidence_url, evidence_public_id,
                  file_type, file_name, description, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
              [newSubmissionId, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
            );
          }
        } catch (uploadError) {
          console.error(`❌ [resubmitProgress] Upload failed:`, uploadError);
          throw new AppError(
            `Failed to upload documents: ${(uploadError as Error).message}`,
            500
          );
        }
      }

      if (indicator.status !== "Completed") {
        await client.query(
          `UPDATE indicators SET status = 'Awaiting Admin Approval', updated_at = NOW() WHERE id = $1`,
          [indicatorId],
        );
      }

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [resubmitProgress] COMPLETE for ${quarterDisplay(quarterNum, yearNum)}`);

      UserIndicatorController._sendAlerts(
        user, indicator, quarterNum, yearNum, validated.achievedValue, "resubmitted",
      ).catch((err: Error) => console.error("[resubmitProgress] Mail Error:", err));

      // Get full submission data for response
      const fullSubmission = await getSubmissionWithDocuments(client, newSubmissionId);

      res.status(200).json({
        success: true,
        message: `Your resubmission for ${quarterDisplay(quarterNum, yearNum)} has been sent for review.`,
        data: { 
          submissionId: newSubmissionId, 
          resubmissionCount: newResubmissionCount,
          submission: fullSubmission
        },
      });
    } catch (error) {
      console.error(`❌ [resubmitProgress] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  /**
   * ✅ ADD DOCUMENTS - For pending submissions with improved logging
   */
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { id } = req.params;
    const { quarter, descriptions, idempotencyKey } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];

    console.log(`📝 [addDocuments] START for indicator ${id}`, {
      quarter,
      filesCount: files.length,
    });

    if (!files.length) throw new AppError("Please select at least one file to upload.", 400);
    validateFiles(files);

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        res.status(200).json({ 
          success: true, 
          message: "This request was already processed.", 
          idempotent: true 
        });
        return;
      }

      const indRes = await client.query("SELECT * FROM indicators WHERE id = $1 FOR UPDATE", [id]);
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      
      const indicator = indRes.rows[0] as IndicatorWithActivity;
      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const targetQ = indicator.reporting_cycle === "Annual" ? 0 : quarterToInt(quarter ?? indicator.active_quarter);
      const currentYear = new Date().getFullYear();

      const pendingSubmission = await client.query(
        `SELECT id, review_status 
         FROM submissions
         WHERE indicator_id = $1 AND quarter = $2 AND year = $3 AND review_status = 'Pending'
         ORDER BY submitted_at DESC
         LIMIT 1
         FOR UPDATE`,
        [id, targetQ, currentYear],
      );

      if (pendingSubmission.rows.length === 0) {
        throw new AppError(
          `No pending submission found for ${quarterDisplay(targetQ, currentYear)}. Documents can only be added to pending submissions.`,
          404,
        );
      }

      const submission = pendingSubmission.rows[0] as { id: string; review_status: string };
      console.log(`📁 [addDocuments] Found pending submission: ${submission.id}`);

      try {
        const uploadedDocs = await uploadDocumentsWithRetry(files, descriptions || []);
        console.log(`✅ [addDocuments] Uploaded ${uploadedDocs.length} documents`);

        for (const doc of uploadedDocs) {
          await client.query(
            `INSERT INTO submission_documents
               (submission_id, evidence_url, evidence_public_id,
                file_type, file_name, description, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'Pending')`,
            [submission.id, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
          );
        }
      } catch (uploadError) {
        console.error(`❌ [addDocuments] Upload failed:`, uploadError);
        throw new AppError(
          `Failed to upload documents: ${(uploadError as Error).message}`,
          500
        );
      }

      // Verify documents were saved
      const docVerify = await client.query(
        `SELECT COUNT(*) FROM submission_documents WHERE submission_id = $1 AND deleted_at IS NULL`,
        [submission.id],
      );
      console.log(`✅ [addDocuments] Documents in DB:`, docVerify.rows[0].count);

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [addDocuments] Added ${files.length} document(s) to pending submission`);

      // Get full submission data for response
      const fullSubmission = await getSubmissionWithDocuments(client, submission.id);

      res.status(200).json({
        success: true,
        message: `${files.length} document(s) successfully added to your pending submission.`,
        data: { 
          submissionId: submission.id, 
          documentsAdded: files.length,
          submission: fullSubmission
        },
      });
    } catch (error) {
      console.error(`❌ [addDocuments] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  /**
   * ✅ UPDATE SUBMISSION - Smart router with improved handling
   */
  updateSubmission: asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { quarter, year } = req.body;
    
    console.log(`📝 [updateSubmission] START for indicator ${id}`, { quarter, year });
    
    const quarterNum = quarterToInt(quarter);
    const yearNum = parseInt(String(year), 10);
    
    const submissionCheck = await pool.query(
      `SELECT review_status FROM submissions 
       WHERE indicator_id = $1 AND quarter = $2 AND year = $3
       ORDER BY submitted_at DESC LIMIT 1`,
      [id, quarterNum, yearNum],
    );
    
    if (submissionCheck.rows.length === 0) {
      console.log(`📝 [updateSubmission] No submission found, routing to submitProgress`);
      await UserIndicatorController.submitProgress(req, res, next);
      return;
    }
    
    const status = submissionCheck.rows[0].review_status;
    console.log(`📝 [updateSubmission] Found submission with status: ${status}`);
    
    if (status === "Rejected") {
      console.log(`📝 [updateSubmission] Routing to resubmitProgress`);
      await UserIndicatorController.resubmitProgress(req, res, next);
      return;
    }
    
    if (status === "Pending") {
      console.log(`📝 [updateSubmission] Routing to addDocuments`);
      await UserIndicatorController.addDocuments(req, res, next);
      return;
    }
    
    throw new AppError(`Cannot update submission with status: ${status}`, 400);
  }),

  deletePendingDocument: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { docId } = req.params;

    console.log(`🗑️ [deletePendingDocument] START — docId: ${docId} | user: ${user.id}`);

    const teamIds = await getUserTeamIds(user.id);
    console.log(`👥 [deletePendingDocument] teamIds for user ${user.id}:`, teamIds);

    const ownershipFilter = teamIds.length > 0
      ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
           OR i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')`
      : `AND i.assignee_id = $2 AND i.assignee_model = 'User'`;

    const checkParams: unknown[] = teamIds.length > 0 ? [docId, user.id, teamIds] : [docId, user.id];

    const { rows } = await pool.query(
      `SELECT d.id, d.evidence_public_id, d.file_name, d.status AS doc_status, 
              s.review_status, s.quarter, s.year
       FROM submission_documents d
       JOIN submissions s ON d.submission_id = s.id
       JOIN indicators i ON s.indicator_id = i.id
       WHERE d.id = $1 AND d.deleted_at IS NULL ${ownershipFilter}`,
      checkParams,
    );

    if (rows.length === 0) {
      throw new AppError("Document not found or you don't have permission to delete it.", 404);
    }

    const doc = rows[0] as {
      evidence_public_id: string;
      file_name: string;
      doc_status: string;
      review_status: string;
      quarter: number;
      year: number;
    };

    if (doc.review_status !== "Pending" && doc.doc_status !== "Rejected") {
      throw new AppError(
        `Cannot delete this document because the submission is ${doc.review_status}. Documents can only be deleted when the submission is pending review or when specifically rejected by an admin.`,
        400,
      );
    }

    await pool.query(
      `UPDATE submission_documents 
       SET deleted_at = NOW(), deleted_by = $1
       WHERE id = $2`,
      [user.id, docId],
    );

    if (doc.evidence_public_id) {
      deleteFromCloudinary(doc.evidence_public_id).catch((err: Error) =>
        console.error("[deletePendingDocument] Cloudinary cleanup failed:", err),
      );
    }

    const quarterDisplayText = doc.quarter === 0 ? "Annual" : `Q${doc.quarter}`;
    res.status(200).json({
      success: true,
      message: `Document "${doc.file_name}" has been removed from your ${quarterDisplayText} ${doc.year} submission.`,
    });
  }),

  getRejectedSubmissions: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause: ownership, params } = ownershipClause([], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY}
       WHERE ${ownership}
         AND EXISTS (
           SELECT 1 FROM submissions s
           WHERE s.indicator_id = i.id 
           AND s.review_status = 'Rejected'
           AND s.submitted_at > NOW() - INTERVAL '90 days'
         )
       ORDER BY i.id, i.updated_at DESC`,
      params,
    );

    if (rows.length === 0) {
      res.status(200).json({ 
        success: true, 
        message: "No rejected submissions found in the last 90 days.",
        results: 0, 
        data: [] 
      });
      return;
    }

    const indicatorIds = (rows as Array<{ id: string }>).map((r) => r.id);

    const { rows: rejectedRows } = await pool.query(
      `SELECT
         s.indicator_id,
         s.quarter,
         s.year,
         s.admin_comment,
         s.submitted_at,
         CONCAT(
           CASE WHEN s.quarter = 0 THEN 'Annual' ELSE 'Q' || s.quarter::text END,
           '_', s.year
         ) AS quarter_key
       FROM submissions s
       WHERE s.indicator_id = ANY($1) 
         AND s.review_status = 'Rejected'
       ORDER BY s.submitted_at DESC`,
      [indicatorIds],
    );

    const rejectedMap = new Map<string, Array<{ quarter_key: string; admin_comment: string; year: number; quarter: number }>>();
    for (const row of rejectedRows as Array<{
      indicator_id: string;
      quarter_key: string;
      admin_comment: string;
      year: number;
      quarter: number;
    }>) {
      if (!rejectedMap.has(row.indicator_id)) rejectedMap.set(row.indicator_id, []);
      rejectedMap.get(row.indicator_id)!.push({
        quarter_key: row.quarter_key,
        admin_comment: row.admin_comment,
        year: row.year,
        quarter: row.quarter,
      });
    }

    const enriched = (rows as Array<{ id: string }>).map((row) => ({
      ...row,
      rejectedSubmissions: rejectedMap.get(row.id) ?? [],
    }));

    res.status(200).json({ 
      success: true, 
      message: `Found ${enriched.length} indicator(s) with rejected submissions.`,
      results: enriched.length, 
      data: enriched 
    });
  }),

  updateDocumentDescription: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { docId } = req.params;
    const { description, idempotencyKey } = req.body;

    console.log(`📝 [updateDocumentDescription] START for doc ${docId}`);

    if (description === undefined) {
      throw new AppError("Please provide a description for the document.", 400);
    }
    if (typeof description !== "string") {
      throw new AppError("Description must be text.", 400);
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new AppError(`Description is too long. Maximum ${MAX_DESCRIPTION_LENGTH} characters allowed.`, 400);
    }

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        res.status(200).json({
          success: true,
          message: "This request was already processed. Duplicate ignored.",
          idempotent: true,
        });
        return;
      }

      const docResult = await client.query(
        `SELECT d.id, d.submission_id, d.file_name, d.description AS old_description,
                s.review_status, s.indicator_id, s.quarter, s.year
         FROM submission_documents d
         JOIN submissions s ON d.submission_id = s.id
         WHERE d.id = $1 AND d.deleted_at IS NULL
         FOR UPDATE`,
        [docId],
      );

      if (docResult.rows.length === 0) {
        throw new AppError("Document not found or has been deleted.", 404);
      }

      const document = docResult.rows[0] as {
        id: string;
        submission_id: string;
        file_name: string;
        old_description: string;
        review_status: string;
        indicator_id: string;
        quarter: number;
        year: number;
      };

      const indResult = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [document.indicator_id],
      );
      if (indResult.rows.length === 0) {
        throw new AppError("Associated indicator not found.", 404);
      }

      await assertIndicatorOwnership(client, indResult.rows[0] as Record<string, unknown>, user.id, teamIds);

      if (document.review_status === "Accepted") {
        throw new AppError(
          `Cannot modify documents for ${quarterDisplay(document.quarter, document.year)} because it has already been accepted and finalized.`,
          400,
        );
      }

      const updateResult = await client.query(
        `UPDATE submission_documents
         SET description = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, evidence_url, file_name, description, status, uploaded_at`,
        [description, docId],
      );

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [updateDocumentDescription] Updated document ${docId}`);

      res.status(200).json({
        success: true,
        message: `Description for "${document.file_name}" has been updated successfully.`,
        data: {
          document: updateResult.rows[0],
          previousDescription: document.old_description || "No previous description",
        },
      });
    } catch (error) {
      console.error(`❌ [updateDocumentDescription] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const url = decodeURIComponent(req.query.url as string);

    if (!url || !url.startsWith("https://res.cloudinary.com/")) {
      throw new AppError("Invalid file URL provided.", 400);
    }

    const match = url.match(/^https:\/\/res\.cloudinary\.com\/([^/]+)\//);
    if (!match || match[1] !== process.env.CLOUDINARY_CLOUD_NAME) {
      throw new AppError("Unable to verify file source. Access denied.", 403);
    }

    const hasPrivilege = PRIVILEGED_ROLES.includes(user.role as "admin" | "superadmin" | "examiner");
    let isAuthorized = false;

    if (hasPrivilege) {
      const { rows } = await pool.query(
        `SELECT id FROM submission_documents WHERE evidence_url = $1 AND deleted_at IS NULL LIMIT 1`,
        [url],
      );
      isAuthorized = rows.length > 0;
    } else {
      const teamIds = await getUserTeamIds(user.id);
      const ownershipFilter = teamIds.length > 0
        ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
             OR i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')`
        : `AND i.assignee_id = $2 AND i.assignee_model = 'User'`;

      const checkParams = teamIds.length > 0 ? [url, user.id, teamIds] : [url, user.id];

      const { rows } = await pool.query(
        `SELECT d.id
         FROM submission_documents d
         JOIN submissions s ON d.submission_id = s.id
         JOIN indicators i ON s.indicator_id = i.id
         WHERE d.evidence_url = $1 AND d.deleted_at IS NULL ${ownershipFilter}
         LIMIT 1`,
        checkParams,
      );
      isAuthorized = rows.length > 0;
    }

    if (!isAuthorized) {
      throw new AppError("You don't have permission to access this file.", 403);
    }

    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      timeout: 30000,
      maxContentLength: 100 * 1024 * 1024,
    });

    res.setHeader("Content-Type", response.headers["content-type"] ?? "application/octet-stream");
    response.data.pipe(res);
  }),

  updateDocumentDescriptions: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { submissionId } = req.params;
    const { documents, idempotencyKey } = req.body;

    console.log(`📝 [updateDocumentDescriptions] START for submission ${submissionId}`);

    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      throw new AppError("Documents array is required with at least one document.", 400);
    }

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        res.status(200).json({
          success: true,
          message: "This request was already processed. Duplicate ignored.",
          idempotent: true,
        });
        return;
      }

      const subResult = await client.query(
        `SELECT s.id, s.review_status, s.indicator_id
         FROM submissions s
         JOIN indicators i ON s.indicator_id = i.id
         WHERE s.id = $1
         FOR UPDATE`,
        [submissionId],
      );

      if (subResult.rows.length === 0) {
        throw new AppError("Submission not found.", 404);
      }

      const submission = subResult.rows[0] as {
        id: string;
        review_status: string;
        indicator_id: string;
      };

      const indResult = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [submission.indicator_id],
      );
      if (indResult.rows.length === 0) {
        throw new AppError("Indicator not found.", 404);
      }

      await assertIndicatorOwnership(client, indResult.rows[0] as Record<string, unknown>, user.id, teamIds);

      if (submission.review_status === "Accepted") {
        throw new AppError("Cannot modify documents for an accepted submission.", 400);
      }

      const updatedDocuments = [];
      for (const doc of documents) {
        if (!doc.documentId) {
          throw new AppError("Each document must have a documentId.", 400);
        }

        const updateResult = await client.query(
          `UPDATE submission_documents
           SET description = $1,
               updated_at = NOW()
           WHERE id = $2 AND submission_id = $3 AND deleted_at IS NULL
           RETURNING id, evidence_url, file_name, description, status`,
          [doc.description || "", doc.documentId, submission.id],
        );

        if (updateResult.rows.length > 0) {
          updatedDocuments.push(updateResult.rows[0]);
        }
      }

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [updateDocumentDescriptions] Updated ${updatedDocuments.length} documents`);

      // Get full submission data for response
      const fullSubmission = await getSubmissionWithDocuments(client, submission.id);

      res.status(200).json({
        success: true,
        message: `${updatedDocuments.length} document(s) updated successfully.`,
        data: { 
          submissionId: submission.id, 
          updatedDocuments,
          submission: fullSubmission
        },
      });
    } catch (error) {
      console.error(`❌ [updateDocumentDescriptions] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  deleteDocument: asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const user = getAuthUser(req);
    const { docId } = req.params;

    console.log(`🗑️ [deleteDocument] START — docId: ${docId} | user: ${user.id}`);

    const teamIds = await getUserTeamIds(user.id);

    const ownershipFilter = teamIds.length > 0
      ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
         OR i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')`
      : `AND i.assignee_id = $2 AND i.assignee_model = 'User'`;

    const checkParams: unknown[] = teamIds.length > 0 ? [docId, user.id, teamIds] : [docId, user.id];

    const { rows } = await pool.query(
      `SELECT d.id, d.evidence_public_id, d.file_name, d.status AS doc_status, 
              s.review_status, s.quarter, s.year
       FROM submission_documents d
       JOIN submissions s ON d.submission_id = s.id
       JOIN indicators i ON s.indicator_id = i.id
       WHERE d.id = $1 AND d.deleted_at IS NULL ${ownershipFilter}`,
      checkParams,
    );

    if (rows.length === 0) {
      throw new AppError("Document not found or you don't have permission to delete it.", 404);
    }

    const doc = rows[0] as {
      evidence_public_id: string;
      file_name: string;
      doc_status: string;
      review_status: string;
      quarter: number;
      year: number;
    };

    if (doc.review_status !== "Pending" && doc.doc_status !== "Rejected") {
      throw new AppError(
        `Cannot delete this document because the submission is ${doc.review_status}. Documents can only be deleted when the submission is pending review or when specifically rejected by an admin.`,
        400,
      );
    }

    await pool.query(
      `UPDATE submission_documents 
       SET deleted_at = NOW(), deleted_by = $1
       WHERE id = $2`,
      [user.id, docId],
    );

    if (doc.evidence_public_id) {
      deleteFromCloudinary(doc.evidence_public_id).catch((err: Error) =>
        console.error("[deleteDocument] Cloudinary cleanup failed:", err),
      );
    }

    const quarterDisplayText = doc.quarter === 0 ? "Annual" : `Q${doc.quarter}`;
    res.status(200).json({
      success: true,
      message: `Document "${doc.file_name}" has been removed from your ${quarterDisplayText} ${doc.year} submission.`,
    });
  }),

  _sendAlerts: async (
    user: IUser,
    indicator: Record<string, unknown>,
    quarter: number,
    year: number,
    achievedValue: number | null,
    actionType: "submitted" | "resubmitted" | "rejected" = "submitted",
    rejectionReason?: string,
    rejectedBy?: "Admin" | "Super Admin",
  ): Promise<void> => {
    const cycle = (indicator.reporting_cycle as string) ?? "Quarterly";
    const label = quarter === 0 ? "Annual" : `Q${quarter}`;
    const periodDisplay = `${label} ${year}`;

    const activityDescription =
      (indicator.activityDescription as string) ||
      (indicator.activity as { description?: string } | undefined)?.description ||
      (indicator.instructions as string) ||
      "Performance Indicator";

    const unit = (indicator.unit as string) || "%";

    if (actionType === "rejected") {
      await sendMail({
        to: user.email,
        subject: `Submission Update: ${periodDisplay} Requires Attention`,
        html: submissionRejectedTemplate(
          user.name,
          activityDescription,
          cycle,
          quarter,
          year,
          rejectedBy || "Admin",
          rejectionReason || "Your submission requires corrections. Please review the admin comments in the system for specific details.",
        ),
      }).catch((err: Error) => {
        console.error("[_sendAlerts] Failed to send rejection notification:", err);
      });
      return;
    }

    await sendMail({
      to: user.email,
      subject: `Filing Confirmation: ${periodDisplay}`,
      html: submissionReceivedTemplate(
        user.name,
        activityDescription,
        cycle,
        quarter,
        year,
        achievedValue ?? 0,
        unit,
      ),
    }).catch((err: Error) => {
      console.error("[_sendAlerts] Failed to send user confirmation:", err);
    });

    const admins = await pool.query(
      `SELECT email, name FROM users WHERE role IN ('admin', 'superadmin') AND is_active = true`,
    );

    if (admins.rows.length > 0) {
      await Promise.all(
        (admins.rows as Array<{ email: string; name: string }>).map((admin) =>
          sendMail({
            to: admin.email,
            subject: `Filing Awaiting Review: ${periodDisplay}`,
            html: adminReviewNeededTemplate(
              admin.name,
              user.name,
              activityDescription,
              cycle,
              quarter,
              year,
              achievedValue ?? 0,
              unit,
            ),
          }).catch((err: Error) =>
            console.error(`[_sendAlerts] Failed to notify admin ${admin.email}:`, err),
          ),
        ),
      );
    }
  },
};