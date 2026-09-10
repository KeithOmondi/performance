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
  achieved_value: number | null;   // ✅ added — needed for safe fallback on resubmit
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

// ─── Document Status Types ────────────────────────────────────────────────────

type DocumentStatus = 
  | 'Pending'        // Waiting for admin review
  | 'Approved'       // Admin approved
  | 'Rejected'       // Admin rejected - needs resubmission
  | 'Resubmitted'    // User resubmitted after rejection - waiting for review
  | 'Additional';    // Added after submission was already approved

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

  let clause = `(
    (${tableAlias}.assignee_id = $${userIdx} AND ${tableAlias}.assignee_model = 'User')
  `;

  if (teamIds.length > 0) {
    params.push(teamIds);
    const teamIdx = params.length;
    clause += ` OR (${tableAlias}.assignee_id = ANY($${teamIdx}::uuid[]) AND ${tableAlias}.assignee_model = 'Team')`;
  }

  clause += ` OR EXISTS (
    SELECT 1 FROM indicator_assignees ia
    WHERE ia.indicator_id = ${tableAlias}.id
      AND ia.user_id = $${userIdx}
  )`;

  clause += ")";
  return { clause, params };
}

async function assertIndicatorOwnership(
  client: PoolClient,
  indicator: Record<string, unknown>,
  userId: string,
  teamIds: string[],
): Promise<void> {
  const { assignee_id, assignee_model, id } = indicator;

  if (assignee_model === "User") {
    if (assignee_id === userId) return;
  } else if (assignee_model === "Team") {
    if (teamIds.includes(assignee_id as string)) return;
    const memberCheck = await client.query(
      `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
      [assignee_id, userId],
    );
    if ((memberCheck.rowCount ?? 0) > 0) return;
  }

  const assigneeCheck = await client.query(
    `SELECT 1 FROM indicator_assignees WHERE indicator_id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId],
  );
  if ((assigneeCheck.rowCount ?? 0) > 0) return;

  throw new AppError(
    "You don't have permission to access this indicator.",
    403,
  );
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
        `File "${file.originalname}" exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB size limit.`,
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

  let descriptionsArray: string[] = [];
  if (descriptions) {
    if (Array.isArray(descriptions)) {
      descriptionsArray = descriptions;
    } else if (typeof descriptions === 'string') {
      descriptionsArray = [descriptions];
    }
  }
  
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

// ─── Document Helpers ─────────────────────────────────────────────────────────

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

async function getRejectedDocuments(
  client: PoolClient,
  submissionId: string,
): Promise<any[]> {
  const result = await client.query(
    `SELECT id, file_name, description, rejection_reason, status, uploaded_at
     FROM submission_documents
     WHERE submission_id = $1 
       AND status = 'Rejected' 
       AND deleted_at IS NULL
     ORDER BY uploaded_at DESC`,
    [submissionId],
  );
  return result.rows;
}

async function checkAllDocumentsApproved(
  client: PoolClient,
  submissionId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'Approved') as approved
     FROM submission_documents
     WHERE submission_id = $1 AND deleted_at IS NULL`,
    [submissionId],
  );
  
  const total = parseInt(result.rows[0]?.total || '0');
  const approved = parseInt(result.rows[0]?.approved || '0');
  
  return total > 0 && total === approved;
}

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
                    json_agg(doc_row.doc_json ORDER BY doc_row.uploaded_at DESC),
                    '[]'::json
                  )
                  FROM (
                    /* Own uploaded documents */
                    SELECT
                      json_build_object(
                        'id',              d.id,
                        'evidenceUrl',     d.evidence_url,
                        'fileType',        d.file_type,
                        'fileName',        d.file_name,
                        'description',     d.description,
                        'status',          d.status,
                        'rejectionReason', d.rejection_reason,
                        'source',          'own'
                      ) AS doc_json,
                      d.uploaded_at
                    FROM submission_documents d
                    WHERE d.submission_id = s.id AND d.deleted_at IS NULL

                    UNION ALL

                    /* Linked spot-check library documents */
                    SELECT
                      json_build_object(
                        'id',              l.id,
                        'evidenceUrl',     l.evidence_url,
                        'fileType',        l.file_type,
                        'fileName',        l.file_name,
                        'description',     l.description,
                        'status',          'Approved',
                        'rejectionReason', NULL,
                        'source',          'spot-check',
                        'linkedAt',        l.linked_at
                      ) AS doc_json,
                      l.linked_at AS uploaded_at
                    FROM submission_spot_check_links l
                    WHERE l.submission_id = s.id
                  ) doc_row
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

// ─── Controller Interface ─────────────────────────────────────────────────────

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
  resubmitDocuments: RequestHandler;
  updateDocumentStatus: RequestHandler;
  getRejectedDocuments: RequestHandler;
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

// ─── Controller ───────────────────────────────────────────────────────────────

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
   * ✅ SUBMIT PROGRESS - First-time submission with document-level workflow
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

    if (files.length > 0) {
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

      if (existingSubmissions.rows.length > 0) {
        const existing = existingSubmissions.rows[0] as { review_status: string };

        switch (existing.review_status) {
          case "Accepted": {
            // If already accepted, we should route to addDocuments
            await client.query("ROLLBACK");
            client.release();
            req.body.quarter = quarter;
            req.body.year = year;
            return UserIndicatorController.addDocuments(req, res, undefined as any);
          }
          case "Pending":
            throw new AppError(
              `A pending submission already exists for ${quarterDisplay(quarterNum, yearNum)}.`,
              409,
            );
          case "Rejected":
            throw new AppError(
              `A rejected submission exists for ${quarterDisplay(quarterNum, yearNum)}. Use the "Resubmit" endpoint.`,
              409,
            );
          case "Correction Needed":
            throw new AppError(
              `This submission needs correction for ${quarterDisplay(quarterNum, yearNum)}. Use the "Resubmit" endpoint.`,
              409,
            );
          case "Verified":
            throw new AppError(
              `This submission for ${quarterDisplay(quarterNum, yearNum)} has already been verified.`,
              409,
            );
          case "Partially Approved":
            throw new AppError(
              `This submission for ${quarterDisplay(quarterNum, yearNum)} has been partially approved.`,
              409,
            );
          default:
            throw new AppError(
              `A submission for ${quarterDisplay(quarterNum, yearNum)} already exists with status "${existing.review_status}".`,
              409,
            );
        }
      }

      // ✅ DB requires achieved_value NOT NULL. When the user submits evidence only
      // (e.g., spot-check links) without typing a value, default to 0 — this
      // represents "no numeric achievement claimed."
      const safeAchievedValue = validated.achievedValue ?? 0;

      // Create the submission
      const { rows: inserted } = await client.query(
        `INSERT INTO submissions
           (indicator_id, quarter, year, achieved_value, notes,
            review_status, submitted_by, resubmission_count, is_reviewed)
         VALUES ($1, $2, $3, $4, $5, 'Pending', $6, 0, false)
         RETURNING id`,
        [id, quarterNum, yearNum, safeAchievedValue, validated.notes, user.id],
      );

      const submissionId = (inserted[0] as { id: string }).id;
      console.log(`✅ [submitProgress] Created submission ID: ${submissionId}`);

      // Upload documents
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

      if (indicator.status !== "Completed") {
        await client.query(
          `UPDATE indicators SET status = 'Awaiting Admin Approval', updated_at = NOW() WHERE id = $1`,
          [id],
        );
      }

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [submitProgress] COMPLETE for ${quarterDisplay(quarterNum, yearNum)}`);

      UserIndicatorController._sendAlerts(
        user, indicator, quarterNum, yearNum,
        validated.achievedValue, "submitted",
      ).catch((err: Error) => console.error("[submitProgress] Mail Error:", err));

      const fullSubmission = await getSubmissionWithDocuments(client, submissionId);

      res.status(201).json({
        success: true,
        message: `Your submission for ${quarterDisplay(quarterNum, yearNum)} has been received and is pending admin review.`,
        submissionId,                                 // ✅ hoisted for the modal
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
   * ✅ RESUBMIT PROGRESS - Resubmit entire rejected submission (legacy)
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

      // ✅ Include achieved_value so we can preserve it when the user
      // resubmits without typing a new value.
      const previousSubmission = await client.query(
        `SELECT id, review_status, resubmission_count, admin_comment, achieved_value
         FROM submissions
         WHERE indicator_id = $1 AND quarter = $2 AND year = $3
         AND review_status IN ('Rejected', 'Correction Needed')
         ORDER BY submitted_at DESC
         LIMIT 1
         FOR UPDATE`,
        [indicatorId, quarterNum, yearNum],
      );

      if (previousSubmission.rows.length === 0) {
        throw new AppError(
          `No rejected or correction-needed submission found for ${quarterDisplay(quarterNum, yearNum)}.`,
          404,
        );
      }

      const latestSubmission = previousSubmission.rows[0] as Submission;
      const newResubmissionCount = latestSubmission.resubmission_count + 1;

      // ✅ Preserve the previous value when the user doesn't supply one;
      // default to 0 as a final safety net (achieved_value is NOT NULL).
      const safeAchievedValue =
        validated.achievedValue ??
        (latestSubmission.achieved_value != null
          ? Number(latestSubmission.achieved_value)
          : 0);

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
        [safeAchievedValue, validated.notes, user.id,
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

      const fullSubmission = await getSubmissionWithDocuments(client, newSubmissionId);

      res.status(200).json({
        success: true,
        message: `Your resubmission for ${quarterDisplay(quarterNum, yearNum)} has been sent for review.`,
        submissionId: newSubmissionId,                // ✅ hoisted
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
   * ✅ ADD DOCUMENTS - Add documents to any submission
   * ✅ FIX: ALL documents go through approval process, regardless of submission status
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

      const existingSubmission = await client.query(
        `SELECT id, review_status 
         FROM submissions
         WHERE indicator_id = $1 AND quarter = $2 AND year = $3
         ORDER BY submitted_at DESC
         LIMIT 1
         FOR UPDATE`,
        [id, targetQ, currentYear],
      );

      if (existingSubmission.rows.length === 0) {
        throw new AppError(
          `No submission found for ${quarterDisplay(targetQ, currentYear)}. Please submit first.`,
          404,
        );
      }

      const submission = existingSubmission.rows[0] as { id: string; review_status: string };
      console.log(`📁 [addDocuments] Found submission: ${submission.id} with status: ${submission.review_status}`);

      // ✅ FIX: ALL documents go through approval process, regardless of submission status
      // Documents are always set to 'Pending' so they must be reviewed by admin
      const docStatus = 'Pending';

      // If the submission is already 'Accepted', we need to change its status back to 'Pending'
      if (submission.review_status === 'Accepted') {
        await client.query(
          `UPDATE submissions
           SET review_status = 'Pending',
               is_reviewed = false,
               admin_comment = COALESCE(admin_comment, 'Additional documents submitted for review.'),
               updated_at = NOW()
           WHERE id = $1`,
          [submission.id],
        );
        
        // Update indicator status to 'Awaiting Admin Approval'
        if (indicator.status === "Completed") {
          await client.query(
            `UPDATE indicators 
             SET status = 'Awaiting Admin Approval',
                 updated_at = NOW()
             WHERE id = $1`,
            [id],
          );
        }
        
        console.log(`📝 [addDocuments] Submission ${submission.id} moved back to 'Pending' for review of new documents.`);
      }

      try {
        const uploadedDocs = await uploadDocumentsWithRetry(files, descriptions || []);
        console.log(`✅ [addDocuments] Uploaded ${uploadedDocs.length} documents`);

        for (const doc of uploadedDocs) {
          await client.query(
            `INSERT INTO submission_documents
               (submission_id, evidence_url, evidence_public_id,
                file_type, file_name, description, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [submission.id, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description, docStatus],
          );
        }
        
        console.log(`📝 [addDocuments] Added ${files.length} document(s) with status '${docStatus}' to submission ${submission.id}`);
        
      } catch (uploadError) {
        console.error(`❌ [addDocuments] Upload failed:`, uploadError);
        throw new AppError(
          `Failed to upload documents: ${(uploadError as Error).message}`,
          500
        );
      }

      // Check if there are any rejected documents in the submission
      const rejectedDocs = await getRejectedDocuments(client, submission.id);
      
      // If there are rejected documents, update submission status to 'Correction Needed'
      if (rejectedDocs.length > 0) {
        await client.query(
          `UPDATE submissions
           SET review_status = 'Correction Needed',
               admin_comment = COALESCE(admin_comment, 'Some documents require corrections. Please resubmit the rejected documents.'),
               updated_at = NOW()
           WHERE id = $1`,
          [submission.id],
        );
        console.log(`📝 [addDocuments] Submission ${submission.id} has rejected documents, set to 'Correction Needed'.`);
      }

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [addDocuments] Added ${files.length} document(s) to submission`);

      const fullSubmission = await getSubmissionWithDocuments(client, submission.id);

      res.status(200).json({
        success: true,
        message: `${files.length} document(s) successfully added to your submission. They are pending admin review.`,
        submissionId: submission.id,                 // ✅ hoisted
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
   * ✅ UPDATE SUBMISSION - Smart router with document-level support
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
    
    if (status === "Rejected" || status === "Correction Needed") {
      console.log(`📝 [updateSubmission] Routing to resubmitProgress`);
      await UserIndicatorController.resubmitProgress(req, res, next);
      return;
    }
    
    if (status === "Pending" || status === "Accepted") {
      console.log(`📝 [updateSubmission] Routing to addDocuments`);
      await UserIndicatorController.addDocuments(req, res, next);
      return;
    }
    
    console.log(`📝 [updateSubmission] Unknown status: ${status}, routing to addDocuments as fallback`);
    await UserIndicatorController.addDocuments(req, res, next);
  }),

  /**
   * ✅ DELETE PENDING DOCUMENT - Delete a document from a pending submission
   */
  deletePendingDocument: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { docId } = req.params;

    console.log(`🗑️ [deletePendingDocument] START — docId: ${docId} | user: ${user.id}`);

    const teamIds = await getUserTeamIds(user.id);

    const ownershipCondition = `
      AND (
        (i.assignee_id = $2 AND i.assignee_model = 'User')
        OR (i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')
        OR EXISTS (
          SELECT 1 FROM indicator_assignees ia
          WHERE ia.indicator_id = i.id AND ia.user_id = $2
        )
      )
    `;

    const checkParams: unknown[] = [docId, user.id, teamIds.length > 0 ? teamIds : null];

    const { rows } = await pool.query(
      `SELECT d.id, d.evidence_public_id, d.file_name, d.status AS doc_status, 
              s.review_status, s.quarter, s.year
       FROM submission_documents d
       JOIN submissions s ON d.submission_id = s.id
       JOIN indicators i ON s.indicator_id = i.id
       WHERE d.id = $1 AND d.deleted_at IS NULL ${ownershipCondition}`,
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

    // Allow deletion if document is Pending, Rejected, Resubmitted, or Additional
    if (doc.doc_status === 'Approved') {
      throw new AppError("Cannot delete an approved document.", 400);
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

  /**
   * ✅ GET REJECTED SUBMISSIONS - Get all indicators with rejected submissions
   */
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

  /**
   * ✅ UPDATE DOCUMENT DESCRIPTION - Update a single document's description
   */
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

  /**
   * ✅ STREAM FILE - Stream a file from Cloudinary
   */
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
      `SELECT 1 FROM submission_documents WHERE evidence_url = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 1 FROM submission_spot_check_links WHERE evidence_url = $1
       LIMIT 1`,
      [url],
    );
    isAuthorized = rows.length > 0;
  } else {
    const teamIds = await getUserTeamIds(user.id);
    const ownershipFilter = `
      AND (
        (i.assignee_id = $2 AND i.assignee_model = 'User')
        OR (i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')
        OR EXISTS (
          SELECT 1 FROM indicator_assignees ia
          WHERE ia.indicator_id = i.id AND ia.user_id = $2
        )
      )
    `;
    const checkParams = [url, user.id, teamIds];

    const { rows } = await pool.query(
      `SELECT d.id
       FROM submission_documents d
       JOIN submissions s ON d.submission_id = s.id
       JOIN indicators i ON s.indicator_id = i.id
       WHERE d.evidence_url = $1 AND d.deleted_at IS NULL ${ownershipFilter}

       UNION ALL

       SELECT l.id
       FROM submission_spot_check_links l
       JOIN submissions s ON s.id = l.submission_id
       JOIN indicators i ON s.indicator_id = i.id
       WHERE l.evidence_url = $1 ${ownershipFilter}

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

  /**
   * ✅ UPDATE DOCUMENT DESCRIPTIONS - Bulk update document descriptions
   */
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

      const fullSubmission = await getSubmissionWithDocuments(client, submission.id);

      res.status(200).json({
        success: true,
        message: `${updatedDocuments.length} document(s) updated successfully.`,
        submissionId: submission.id,                 // ✅ hoisted
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

  /**
   * ✅ DELETE DOCUMENT - Delete a document (legacy)
   */
  deleteDocument: asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const user = getAuthUser(req);
    const { docId } = req.params;

    console.log(`🗑️ [deleteDocument] START — docId: ${docId} | user: ${user.id}`);

    const teamIds = await getUserTeamIds(user.id);

    const ownershipFilter = `
      AND (
        (i.assignee_id = $2 AND i.assignee_model = 'User')
        OR (i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')
        OR EXISTS (
          SELECT 1 FROM indicator_assignees ia
          WHERE ia.indicator_id = i.id AND ia.user_id = $2
        )
      )
    `;

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

    // Allow deletion if document is Pending, Rejected, Resubmitted, or Additional
    if (doc.doc_status === 'Approved') {
      throw new AppError("Cannot delete an approved document.", 400);
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

  /**
   * ✅ RESUBMIT DOCUMENTS - Resubmit only specific rejected documents
   */
  resubmitDocuments: asyncHandler(async (req: Request, res: Response) => {
    const { submissionId } = req.params;
    const { documentIds, notes, achievedValue, descriptions, idempotencyKey } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];
    const user = getAuthUser(req);

    console.log(`📝 [resubmitDocuments] START for submission ${submissionId}`, {
      documentIds: documentIds ? documentIds.length : 0,
      filesCount: files.length,
    });

    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
      throw new AppError("Please provide documentIds array of rejected documents to resubmit.", 400);
    }

    const validated = validateSubmissionInput(notes, achievedValue);
    if (files.length > 0) validateFiles(files);

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

      const subResult = await client.query(
        `SELECT s.*, i.id as indicator_id, i.status as indicator_status
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
        indicator_id: string;
        indicator_status: string;
        review_status: string;
        resubmission_count: number;
        quarter: number;
        year: number;
      };

      const indResult = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [submission.indicator_id],
      );
      
      const teamIds = await getUserTeamIds(user.id);
      await assertIndicatorOwnership(client, indResult.rows[0] as Record<string, unknown>, user.id, teamIds);

      const docCheck = await client.query(
        `SELECT id, file_name, status 
         FROM submission_documents
         WHERE submission_id = $1 AND id = ANY($2) AND status = 'Rejected' AND deleted_at IS NULL`,
        [submission.id, documentIds],
      );

      if (docCheck.rows.length !== documentIds.length) {
        const foundIds = docCheck.rows.map((r: any) => r.id);
        const notFound = documentIds.filter((id: string) => !foundIds.includes(id));
        throw new AppError(
          `Documents ${notFound.join(', ')} are not rejected or don't belong to this submission.`,
          400,
        );
      }

      console.log(`📝 [resubmitDocuments] Resubmitting ${docCheck.rows.length} document(s)`);

      await client.query(
        `UPDATE submission_documents
         SET status = 'Resubmitted',
             rejection_reason = NULL,
             updated_at = NOW()
         WHERE id = ANY($1) AND submission_id = $2`,
        [documentIds, submission.id],
      );

      if (files.length > 0) {
        console.log(`📁 [resubmitDocuments] Uploading ${files.length} files...`);
        
        try {
          const uploadedDocs = await uploadDocumentsWithRetry(files, descriptions || []);
          console.log(`✅ [resubmitDocuments] Uploaded ${uploadedDocs.length} documents`);

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
          console.error(`❌ [resubmitDocuments] Upload failed:`, uploadError);
          throw new AppError(
            `Failed to upload documents: ${(uploadError as Error).message}`,
            500
          );
        }
      }

      if (validated.notes || validated.achievedValue !== null) {
        // COALESCE keeps the existing value when $2 is null, so no
        // coercion to 0 is needed here. achieved_value stays NOT NULL.
        await client.query(
          `UPDATE submissions
           SET notes = COALESCE($1, notes),
               achieved_value = COALESCE($2, achieved_value),
               resubmission_count = resubmission_count + 1,
               resubmitted_from_rejection = true,
               updated_at = NOW()
           WHERE id = $3`,
          [validated.notes, validated.achievedValue, submission.id],
        );
      }

      if (submission.indicator_status !== "Completed") {
        await client.query(
          `UPDATE indicators SET status = 'Awaiting Admin Approval', updated_at = NOW() WHERE id = $1`,
          [submission.indicator_id],
        );
      }

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      console.log(`✅ [resubmitDocuments] COMPLETE for submission ${submissionId}`);

      const fullSubmission = await getSubmissionWithDocuments(client, submission.id);

      res.status(200).json({
        success: true,
        message: `${docCheck.rows.length} document(s) resubmitted for review.`,
        submissionId: submission.id,                 // ✅ hoisted
        data: { 
          submissionId: submission.id, 
          resubmittedDocuments: documentIds,
          submission: fullSubmission
        },
      });
    } catch (error) {
      console.error(`❌ [resubmitDocuments] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  /**
   * ✅ UPDATE DOCUMENT STATUS - Admin/Super Admin approve or reject individual documents
   * ✅ FIX: Properly handle documents added to accepted submissions
   */
  updateDocumentStatus: asyncHandler(async (req: Request, res: Response) => {
    const { docId } = req.params;
    const { status, rejectionReason } = req.body;
    const user = getAuthUser(req);

    console.log(`📝 [updateDocumentStatus] START for doc ${docId}`, { status, rejectionReason });

    if (!['admin', 'superadmin'].includes(user.role)) {
      throw new AppError("Only admins can update document status.", 403);
    }

    if (!status || !['Approved', 'Rejected'].includes(status)) {
      throw new AppError("Status must be either 'Approved' or 'Rejected'.", 400);
    }

    if (status === 'Rejected' && (!rejectionReason || !rejectionReason.trim())) {
      throw new AppError("Rejection reason is required when rejecting a document.", 400);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const docResult = await client.query(
        `SELECT d.*, s.indicator_id, s.quarter, s.year, s.id as submission_id,
                i.status as indicator_status, i.reporting_cycle
         FROM submission_documents d
         JOIN submissions s ON d.submission_id = s.id
         JOIN indicators i ON s.indicator_id = i.id
         WHERE d.id = $1 AND d.deleted_at IS NULL
         FOR UPDATE`,
        [docId],
      );

      if (docResult.rows.length === 0) {
        throw new AppError("Document not found.", 404);
      }

      const doc = docResult.rows[0] as {
        id: string;
        submission_id: string;
        indicator_id: string;
        indicator_status: string;
        status: string;
        file_name: string;
        quarter: number;
        year: number;
        reporting_cycle: string;
      };

      // Check if this is an "Additional" document or pending document
      const isAdditionalOrPending = doc.status === 'Additional' || doc.status === 'Pending';

      await client.query(
        `UPDATE submission_documents
         SET status = $1,
             rejection_reason = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [status, status === 'Rejected' ? rejectionReason.trim() : null, docId],
      );

      // Check if all documents in this submission are now Approved
      const allApproved = await checkAllDocumentsApproved(client, doc.submission_id);
      const rejectedDocs = await getRejectedDocuments(client, doc.submission_id);

      // Determine submission status based on document statuses
      let newSubmissionStatus: string;
      
      if (allApproved) {
        // All documents are approved - submission is complete
        newSubmissionStatus = 'Accepted';
      } else if (rejectedDocs.length > 0) {
        // There are rejected documents
        newSubmissionStatus = 'Correction Needed';
      } else {
        // Some documents are still pending
        newSubmissionStatus = 'Pending';
      }

      await client.query(
        `UPDATE submissions
         SET review_status = $1,
             is_reviewed = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newSubmissionStatus, allApproved, doc.submission_id],
      );

      // Update indicator status
      let newIndicatorStatus: string;
      if (allApproved) {
        newIndicatorStatus = 'Completed';
      } else if (rejectedDocs.length > 0) {
        newIndicatorStatus = 'Correction Needed';
      } else {
        newIndicatorStatus = 'Awaiting Admin Approval';
      }

      await client.query(
        `UPDATE indicators
         SET status = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [newIndicatorStatus, doc.indicator_id],
      );

      await client.query("COMMIT");

      console.log(`✅ [updateDocumentStatus] Document ${docId} updated to ${status}`);
      console.log(`📝 [updateDocumentStatus] Submission status: ${newSubmissionStatus}`);
      console.log(`📝 [updateDocumentStatus] Indicator status: ${newIndicatorStatus}`);

      const fullSubmission = await getSubmissionWithDocuments(client, doc.submission_id);

      res.status(200).json({
        success: true,
        message: `Document "${doc.file_name}" has been ${status.toLowerCase()}.`,
        submissionId: doc.submission_id,             // ✅ hoisted
        data: {
          documentId: docId,
          status,
          rejectionReason: status === 'Rejected' ? rejectionReason.trim() : null,
          submission: fullSubmission,
          allDocumentsApproved: allApproved,
          submissionStatus: newSubmissionStatus,
          indicatorStatus: newIndicatorStatus,
        },
      });
    } catch (error) {
      console.error(`❌ [updateDocumentStatus] ERROR:`, error);
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  /**
   * ✅ GET REJECTED DOCUMENTS - Get all rejected documents for a submission
   */
  getRejectedDocuments: asyncHandler(async (req: Request, res: Response) => {
    const { submissionId } = req.params as { submissionId: string };
    const user = getAuthUser(req);

    console.log(`📝 [getRejectedDocuments] START for submission ${submissionId}`);

    const client = await pool.connect();

    try {
      const subResult = await client.query(
        `SELECT s.*, i.id as indicator_id
         FROM submissions s
         JOIN indicators i ON s.indicator_id = i.id
         WHERE s.id = $1`,
        [submissionId],
      );

      if (subResult.rows.length === 0) {
        throw new AppError("Submission not found.", 404);
      }

      const teamIds = await getUserTeamIds(user.id);
      await assertIndicatorOwnership(client, subResult.rows[0] as Record<string, unknown>, user.id, teamIds);

      const rejectedDocs = await getRejectedDocuments(client, submissionId);

      console.log(`✅ [getRejectedDocuments] Found ${rejectedDocs.length} rejected documents`);

      res.status(200).json({
        success: true,
        data: rejectedDocs,
      });
    } catch (error) {
      console.error(`❌ [getRejectedDocuments] ERROR:`, error);
      throw error;
    } finally {
      client.release();
    }
  }),

  /**
   * ✅ SEND ALERTS - Send email notifications
   */
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
        subject: `Document Rejection: ${periodDisplay}`,
        html: submissionRejectedTemplate(
          user.name,
          activityDescription,
          cycle,
          quarter,
          year,
          rejectedBy || "Admin",
          rejectionReason || "One or more documents in your submission require corrections.",
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