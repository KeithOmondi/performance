import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { sendMail } from "../../utils/sendMail";
import {
  submissionReceivedTemplate,
  adminReviewNeededTemplate,
} from "../../utils/mailTemplates";
import { IUser } from "../../types/user.types";
import axios from "axios";
import {
  deleteFromCloudinary,
  uploadMultipleToCloudinary,
} from "../../config/cloudinary";
import { IndicatorService } from "../user/Indicator.model";
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

/**
 * Converts any quarter representation to the INTEGER stored in the DB.
 *
 *   "Q1" | "1" | 1   → 1
 *   "Q4" | "4" | 4   → 4
 *   "annual" | 0     → 0  (sentinel for annual)
 */
function quarterToInt(raw: string | number): number {
  const s = String(raw).trim();
  if (s === "0" || s.toLowerCase() === "annual") return 0;
  const n = parseInt(s.replace(/^Q/i, ""), 10);
  if (isNaN(n))
    throw new AppError(`Invalid quarter format: ${raw}. Use Q1–Q4 or Annual`, 400);
  if (n < 1 || n > 4)
    throw new AppError(`Quarter must be between 1 and 4, got: ${n}`, 400);
  return n;
}

/**
 * Resolves the target quarter for a submission.
 *
 * Priority:
 *  1. Annual indicators always return 0.
 *  2. If the request body includes a `quarter` value, use it —
 *     this allows submitting Q2 while Q1 is still pending review.
 *  3. Fall back to the indicator's active_quarter from the DB.
 */
function resolveTargetQuarter(
  indicator: Record<string, unknown>,
  bodyQuarter?: string | number,
): number {
  if (indicator.reporting_cycle === "Annual") return 0;
  if (bodyQuarter !== undefined && bodyQuarter !== null && bodyQuarter !== "") {
    return quarterToInt(bodyQuarter);
  }
  return quarterToInt(indicator.active_quarter as string | number);
}

/** Maps a DB integer quarter to a human-readable label for errors/logs. */
function quarterLabel(q: number): string {
  return q === 0 ? "the annual period" : `Q${q}`;
}

/**
 * Builds a parameterised ownership WHERE clause covering both User and
 * Team assignees. The uuid[] cast prevents type-mismatch errors when the
 * assignee_id column is of type uuid.
 */
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
      throw new AppError("Access denied: you are not assigned to this indicator.", 403);
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
        "Access denied: you are not a member of the team assigned to this indicator.",
        403,
      );
    return;
  }

  throw new AppError("Access denied: unrecognised assignee type.", 403);
}

function validateSubmissionInput(
  notes: unknown,
  achievedValue: unknown,
): { notes: string; achievedValue: number } {
  const notesStr = typeof notes === "string" ? notes : "";
  if (!notesStr.trim()) throw new AppError("Notes are required.", 400);

  const trimmedNotes = notesStr.trim();
  if (trimmedNotes.length > MAX_NOTES_LENGTH)
    throw new AppError(`Notes cannot exceed ${MAX_NOTES_LENGTH} characters.`, 400);

  if (achievedValue === undefined || achievedValue === null)
    throw new AppError("Achieved value is required.", 400);

  const numValue = Number(achievedValue);
  if (isNaN(numValue))
    throw new AppError("Achieved value must be a valid number.", 400);
  if (numValue < 0)
    throw new AppError("Achieved value cannot be negative.", 400);
  if (numValue > MAX_ACHIEVED_VALUE)
    throw new AppError(`Achieved value cannot exceed ${MAX_ACHIEVED_VALUE}.`, 400);
  if (
    String(achievedValue).includes(".") &&
    String(achievedValue).split(".")[1].length > 2
  )
    throw new AppError("Achieved value can have at most 2 decimal places.", 400);

  return { notes: trimmedNotes, achievedValue: numValue };
}

function validateFiles(files: Express.Multer.File[]): void {
  for (const file of files) {
    if (!ALLOWED_FILE_TYPES.includes(file.mimetype))
      throw new AppError(
        `File type ${file.mimetype} not allowed. Allowed: ${ALLOWED_FILE_TYPES.join(", ")}`,
        400,
      );
    if (file.size > MAX_FILE_SIZE)
      throw new AppError(
        `File ${file.originalname} exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB limit.`,
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

/**
 * Locks the submissions row for the given quarter and validates the expected
 * state for `submit` (must not exist) or `resubmit` (must exist).
 * The FOR UPDATE lock guards against race conditions.
 */
async function validateIndicatorSubmissionState(
  client: PoolClient,
  indicatorId: string,
  targetQuarter: number,
  action: "submit" | "resubmit",
): Promise<{ exists: boolean; submissionId?: string; reviewStatus?: string }> {
  const result = await client.query(
    `SELECT id, review_status
     FROM submissions
     WHERE indicator_id = $1 AND quarter = $2
     FOR UPDATE`,
    [indicatorId, targetQuarter],
  );

  const exists = result.rows.length > 0;

  if (action === "submit" && exists)
    throw new AppError(
      `A submission already exists for ${quarterLabel(targetQuarter)}. Use resubmit instead.`,
      409,
    );

  if (action === "resubmit" && !exists)
    throw new AppError(
      `No existing submission found for ${quarterLabel(targetQuarter)}. Use submit instead.`,
      404,
    );

  return {
    exists,
    submissionId: exists ? (result.rows[0].id as string) : undefined,
    reviewStatus: exists ? (result.rows[0].review_status as string) : undefined,
  };
}

async function uploadDocumentsWithRetry(
  files: Express.Multer.File[],
  descriptions: string[],
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
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
      const descArr = Array.isArray(descriptions)
        ? descriptions
        : descriptions
          ? [descriptions]
          : [];

      return uploads.map((upload, i) => ({
        url: upload.secure_url,
        public_id: upload.public_id,
        file_type: resolveFileType(upload.resource_type, files[i].mimetype),
        file_name: files[i].originalname,
        description: (descArr[i] ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
      }));
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries)
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw new AppError(
    `Failed to upload documents after ${maxRetries} attempts: ${lastError?.message}`,
    500,
  );
}

async function cleanupOldDocuments(publicIds: string[]): Promise<void> {
  await Promise.all(
    publicIds.map((pid) =>
      deleteFromCloudinary(pid).catch((e) =>
        console.error("[Document Cleanup] Cloudinary deletion failed:", {
          publicId: pid,
          error: (e as Error).message,
        }),
      ),
    ),
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

/**
 * Submissions are grouped into quarterly folders:
 *   { "Q1_2025": [...], "Q2_2025": [...], "Annual_2025": [...] }
 *
 * The `quarter` column is an INTEGER: 0 = Annual, 1–4 = Q1–Q4.
 */
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
                  WHERE d.submission_id = s.id
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

// ─── Controller ───────────────────────────────────────────────────────────────

export const UserIndicatorController = {

  // ── 1. List my indicators ─────────────────────────────────────────────────
  getMyIndicators: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause, params } = ownershipClause([], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY} WHERE ${clause} ORDER BY i.id, i.updated_at DESC`,
      params,
    );

    res.status(200).json({ success: true, results: rows.length, data: rows });
  }),

  // ── 2. Get single indicator (ownership-gated) ─────────────────────────────
  getIndicatorDetails: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause, params } = ownershipClause([req.params.id], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY} WHERE i.id = $1 AND ${clause} ORDER BY i.id LIMIT 1`,
      params,
    );

    if (rows.length === 0)
      throw new AppError("Access denied or record missing.", 404);

    res.status(200).json({ success: true, data: rows[0] });
  }),

  // ── 3. Submit progress (first-time for a given quarter) ───────────────────
  //
  // Sending `quarter` in the body lets users submit Q2 while Q1 is still
  // pending review — the body value always takes priority over active_quarter.
  submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, descriptions, idempotencyKey, quarter } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId) throw new AppError("Indicator ID is required.", 400);

    const validated = validateSubmissionInput(notes, achievedValue);
    validateFiles(files);

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();
    let submissionId: string | null = null;

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        return res.status(200).json({
          success: true,
          message: "Duplicate request ignored",
          idempotent: true,
        });
      }

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0] as Record<string, unknown>;

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      if (indicator.status === "Completed")
        throw new AppError("Cannot submit: this indicator has been marked as completed.", 409);

      // Body quarter takes priority over active_quarter — allows submitting Q2
      // independently while Q1 is still pending review.
      const targetQuarter = resolveTargetQuarter(indicator, quarter);

      // Guard only against THIS quarter being locked — other quarters are irrelevant.
      const existingQuarterSub = await client.query(
        `SELECT review_status FROM submissions
         WHERE indicator_id = $1 AND quarter = $2
         LIMIT 1`,
        [indicatorId, targetQuarter],
      );
      const quarterStatus = existingQuarterSub.rows[0]?.review_status as string | undefined;

      if (quarterStatus === "Pending")
        throw new AppError(
          `${quarterLabel(targetQuarter)} already has a submission awaiting review. Use resubmit instead.`,
          409,
        );

      if (quarterStatus === "Accepted")
        throw new AppError(
          `${quarterLabel(targetQuarter)} has already been accepted and cannot be resubmitted.`,
          409,
        );

      // Row-level lock guards against concurrent duplicate submissions.
      await validateIndicatorSubmissionState(client, indicatorId, targetQuarter, "submit");

      let newDocs: Awaited<ReturnType<typeof uploadDocumentsWithRetry>> = [];
      if (files.length > 0)
        newDocs = await uploadDocumentsWithRetry(files, descriptions || []);

      const newSub = await client.query(
        `INSERT INTO submissions
           (indicator_id, quarter, year, notes, achieved_value, review_status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'Pending', $6)
         RETURNING id`,
        [
          indicatorId,
          targetQuarter,
          new Date().getFullYear(),
          validated.notes,
          validated.achievedValue,
          requestId,
        ],
      );
      submissionId = newSub.rows[0].id as string;

      if (newDocs.length > 0) {
        await Promise.all(
          newDocs.map((doc) =>
            client.query(
              `INSERT INTO submission_documents
                 (submission_id, evidence_url, evidence_public_id, file_type, file_name, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
            ),
          ),
        );
      }

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Submitted', $2, 'user', $3)`,
        [indicatorId, `Filing for ${quarterLabel(targetQuarter)}`, user.id],
      );

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      // Fire-and-forget — do not block the response.
      Promise.all([
        IndicatorService.syncIndicatorState(indicatorId).catch((e) =>
          console.error("[submitProgress] syncIndicatorState failed:", e),
        ),
        UserIndicatorController._sendAlerts(user, indicator, targetQuarter).catch((e) =>
          console.error("[submitProgress] Mail Error:", e),
        ),
      ]);

      res.status(201).json({
        success: true,
        message: "Filing submitted successfully.",
        submissionId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 4. Resubmit progress (existing submission only) ───────────────────────
  //
  // Sending `quarter` in the body lets users target a specific quarter
  // for resubmission, independent of the indicator's active_quarter.
  resubmitProgress: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, descriptions, idempotencyKey, quarter } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId) throw new AppError("Indicator ID is required.", 400);

    const validated = validateSubmissionInput(notes, achievedValue);
    validateFiles(files);

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();
    let submissionId: string | null = null;
    let oldPublicIds: string[] = [];

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        return res.status(200).json({
          success: true,
          message: "Duplicate request ignored",
          idempotent: true,
        });
      }

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0] as Record<string, unknown>;

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      if (indicator.status === "Completed")
        throw new AppError("Cannot resubmit: this indicator has been marked as completed.", 409);

      // Body quarter takes priority — allows targeting a specific quarter.
      const targetQuarter = resolveTargetQuarter(indicator, quarter);

      // Guard against resubmitting an accepted quarter.
      const existingQuarterSub = await client.query(
        `SELECT review_status FROM submissions
         WHERE indicator_id = $1 AND quarter = $2
         LIMIT 1`,
        [indicatorId, targetQuarter],
      );
      const quarterStatus = existingQuarterSub.rows[0]?.review_status as string | undefined;

      if (quarterStatus === "Accepted")
        throw new AppError(
          `${quarterLabel(targetQuarter)} has already been accepted and cannot be resubmitted.`,
          409,
        );

      // Row-level lock — confirms the submission exists and locks the row.
      const { submissionId: existingId } = await validateIndicatorSubmissionState(
        client,
        indicatorId,
        targetQuarter,
        "resubmit",
      );
      submissionId = existingId!;

      await client.query(
        `UPDATE submissions
         SET notes              = $1,
             achieved_value     = $2,
             review_status      = 'Pending',
             is_reviewed        = false,
             submitted_at       = NOW(),
             resubmission_count = resubmission_count + 1,
             idempotency_key    = $3
         WHERE id = $4`,
        [validated.notes, validated.achievedValue, requestId, submissionId],
      );

      const deletedDocs = await client.query(
        `DELETE FROM submission_documents
         WHERE submission_id = $1
         RETURNING evidence_public_id`,
        [submissionId],
      );
      oldPublicIds = (deletedDocs.rows as Array<{ evidence_public_id: string }>)
        .map((r) => r.evidence_public_id)
        .filter(Boolean);

      let newDocs: Awaited<ReturnType<typeof uploadDocumentsWithRetry>> = [];
      if (files.length > 0)
        newDocs = await uploadDocumentsWithRetry(files, descriptions || []);

      if (newDocs.length > 0) {
        await Promise.all(
          newDocs.map((doc) =>
            client.query(
              `INSERT INTO submission_documents
                 (submission_id, evidence_url, evidence_public_id, file_type, file_name, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
            ),
          ),
        );
      }

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Resubmitted', $2, 'user', $3)`,
        [indicatorId, `Resubmission for ${quarterLabel(targetQuarter)}`, user.id],
      );

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      // Cleanup old Cloudinary assets after a successful commit.
      if (oldPublicIds.length > 0)
        cleanupOldDocuments(oldPublicIds).catch((e) =>
          console.error("[resubmitProgress] Document cleanup failed:", e),
        );

      // Fire-and-forget — do not block the response.
      Promise.all([
        IndicatorService.syncIndicatorState(indicatorId).catch((e) =>
          console.error("[resubmitProgress] syncIndicatorState failed:", e),
        ),
        UserIndicatorController._sendAlerts(user, indicator, targetQuarter).catch((e) =>
          console.error("[resubmitProgress] Mail Error:", e),
        ),
      ]);

      res.status(200).json({
        success: true,
        message: "Resubmission processed successfully.",
        submissionId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 5. Update a rejected submission ───────────────────────────────────────
  updateSubmission: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, quarter, descriptions, idempotencyKey } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId) throw new AppError("Indicator ID is required.", 400);
    if (!quarter) throw new AppError("Quarter is required.", 400);

    const validated = validateSubmissionInput(notes, achievedValue);
    validateFiles(files);

    const targetQuarter = quarterToInt(quarter);
    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();
    let submissionId: string | null = null;
    let oldPublicIds: string[] = [];

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        return res.status(200).json({
          success: true,
          message: "Duplicate request ignored",
          idempotent: true,
        });
      }

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0] as Record<string, unknown>;

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      // Only update submissions that are currently Rejected.
      const result = await client.query(
        `UPDATE submissions
         SET notes              = $1,
             achieved_value     = $2,
             review_status      = 'Pending',
             is_reviewed        = false,
             submitted_at       = NOW(),
             resubmission_count = resubmission_count + 1,
             idempotency_key    = $3
         WHERE indicator_id = $4
           AND quarter       = $5
           AND review_status = 'Rejected'
         RETURNING id`,
        [validated.notes, validated.achievedValue, requestId, indicatorId, targetQuarter],
      );

      if (result.rowCount === 0)
        throw new AppError("No rejected submission found to update for this quarter.", 404);

      submissionId = (result.rows[0] as { id: string }).id;

      if (files.length > 0) {
        const deletedDocs = await client.query(
          `DELETE FROM submission_documents
           WHERE submission_id = $1
           RETURNING evidence_public_id`,
          [submissionId],
        );
        oldPublicIds = (deletedDocs.rows as Array<{ evidence_public_id: string }>)
          .map((r) => r.evidence_public_id)
          .filter(Boolean);

        const newDocs = await uploadDocumentsWithRetry(files, descriptions || []);
        await Promise.all(
          newDocs.map((doc) =>
            client.query(
              `INSERT INTO submission_documents
                 (submission_id, evidence_url, evidence_public_id, file_type, file_name, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
            ),
          ),
        );
      }

      await client.query(
        `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Resubmitted', $2, 'user', $3)`,
        [indicatorId, `Correction resubmitted for ${quarterLabel(targetQuarter)}`, user.id],
      );

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      if (oldPublicIds.length > 0)
        cleanupOldDocuments(oldPublicIds).catch((e) =>
          console.error("[updateSubmission] Document cleanup failed:", e),
        );

      IndicatorService.syncIndicatorState(indicatorId).catch((e) =>
        console.error("[updateSubmission] syncIndicatorState failed:", e),
      );

      res.status(200).json({
        success: true,
        message: "Submission updated and resent for review.",
        submissionId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 6. Add documents to an existing submission ────────────────────────────
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { id } = req.params;
    const { quarter, descriptions, idempotencyKey } = req.body;
    const files = (req.files ?? []) as Express.Multer.File[];

    if (!files.length) throw new AppError("No files provided.", 400);
    validateFiles(files);

    const teamIds = await getUserTeamIds(user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const requestId = idempotencyKey || generateIdempotencyKey();
      if (await checkIdempotency(client, requestId)) {
        await client.query("ROLLBACK");
        return res.status(200).json({
          success: true,
          message: "Duplicate request ignored",
          idempotent: true,
        });
      }

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0] as Record<string, unknown>;

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const targetQ =
        indicator.reporting_cycle === "Annual"
          ? 0
          : quarterToInt(quarter ?? (indicator.active_quarter as string | number));

      const subRes = await client.query(
        `SELECT id, review_status FROM submissions
         WHERE indicator_id = $1 AND quarter = $2
         FOR UPDATE`,
        [id, targetQ],
      );
      const submission = subRes.rows[0] as { id: string; review_status: string } | undefined;

      if (!submission)
        throw new AppError(`No submission found for ${quarterLabel(targetQ)}.`, 404);

      if (submission.review_status === "Accepted")
        throw new AppError("Certified records are locked and cannot be modified.", 400);

      const newDocs = await uploadDocumentsWithRetry(files, descriptions || []);
      const results = await Promise.all(
        newDocs.map((doc) =>
          client.query(
            `INSERT INTO submission_documents
               (submission_id, evidence_url, evidence_public_id, file_type, file_name, description)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [submission.id, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description],
          ),
        ),
      );

      await storeIdempotencyKey(client, requestId);
      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: `${files.length} document(s) attached successfully.`,
        documents: results.map((r) => r.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 7. Delete a rejected document ─────────────────────────────────────────
  deleteDocument: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { docId } = req.params;
    const teamIds = await getUserTeamIds(user.id);

    const ownershipFilter =
      teamIds.length > 0
        ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
             OR i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')`
        : `AND i.assignee_id = $2 AND i.assignee_model = 'User'`;

    const checkParams: unknown[] =
      teamIds.length > 0 ? [docId, user.id, teamIds] : [docId, user.id];

    const { rows } = await pool.query(
      `SELECT d.id, d.evidence_public_id, d.status AS doc_status, s.review_status
       FROM submission_documents d
       JOIN submissions s ON d.submission_id = s.id
       JOIN indicators i  ON s.indicator_id  = i.id
       WHERE d.id = $1 ${ownershipFilter}`,
      checkParams,
    );

    if (rows.length === 0)
      throw new AppError("Document not found or access denied.", 404);

    const doc = rows[0] as { evidence_public_id: string; doc_status: string };
    if (doc.doc_status !== "Rejected")
      throw new AppError("Only rejected documents can be deleted.", 400);

    await pool.query("DELETE FROM submission_documents WHERE id = $1", [docId]);

    if (doc.evidence_public_id)
      deleteFromCloudinary(doc.evidence_public_id).catch((e) =>
        console.error("[deleteDocument] Cloudinary cleanup failed:", e),
      );

    res.status(200).json({ success: true, message: "Rejected document removed." });
  }),

  // ── 8. Stream a Cloudinary file through the server ────────────────────────
  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const url = decodeURIComponent(req.query.url as string);

    if (!url || !url.startsWith("https://res.cloudinary.com/"))
      throw new AppError("Invalid source URL.", 400);

    const match = url.match(/^https:\/\/res\.cloudinary\.com\/([^/]+)\//);
    if (!match || match[1] !== process.env.CLOUDINARY_CLOUD_NAME)
      throw new AppError("Access denied: Invalid Cloudinary source.", 403);

    const hasPrivilege = PRIVILEGED_ROLES.includes(
      user.role as (typeof PRIVILEGED_ROLES)[number],
    );
    let isAuthorized = false;

    if (hasPrivilege) {
      const { rows } = await pool.query(
        `SELECT id FROM submission_documents WHERE evidence_url = $1 LIMIT 1`,
        [url],
      );
      isAuthorized = rows.length > 0;
    } else {
      const teamIds = await getUserTeamIds(user.id);
      const ownershipFilter =
        teamIds.length > 0
          ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
               OR i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')`
          : `AND i.assignee_id = $2 AND i.assignee_model = 'User'`;

      const checkParams =
        teamIds.length > 0 ? [url, user.id, teamIds] : [url, user.id];

      const { rows } = await pool.query(
        `SELECT d.id
         FROM submission_documents d
         JOIN submissions s ON d.submission_id = s.id
         JOIN indicators i  ON s.indicator_id  = i.id
         WHERE d.evidence_url = $1 ${ownershipFilter}
         LIMIT 1`,
        checkParams,
      );
      isAuthorized = rows.length > 0;
    }

    if (!isAuthorized) throw new AppError("Access denied.", 403);

    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      timeout: 30_000,
      maxContentLength: 100 * 1024 * 1024,
    });

    res.setHeader(
      "Content-Type",
      response.headers["content-type"] ?? "application/octet-stream",
    );
    response.data.pipe(res);
  }),

  // ── 9. List indicators with rejected submissions ───────────────────────────
  getRejectedSubmissions: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause: ownership, params } = ownershipClause([], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY}
       WHERE ${ownership}
         AND EXISTS (
           SELECT 1 FROM submissions s
           WHERE s.indicator_id = i.id AND s.review_status = 'Rejected'
         )
       ORDER BY i.id, i.updated_at DESC`,
      params,
    );

    if (rows.length === 0)
      return res.status(200).json({ success: true, results: 0, data: [] });

    const indicatorIds = (rows as Array<{ id: string }>).map((r) => r.id);

    const { rows: rejectedRows } = await pool.query(
      `SELECT
         s.indicator_id,
         CONCAT(
           CASE WHEN s.quarter = 0 THEN 'Annual' ELSE 'Q' || s.quarter::text END,
           '_', s.year
         ) AS quarter_key
       FROM submissions s
       WHERE s.indicator_id = ANY($1) AND s.review_status = 'Rejected'
       GROUP BY s.indicator_id, quarter_key`,
      [indicatorIds],
    );

    const rejectedMap = new Map<string, string[]>();
    for (const { indicator_id, quarter_key } of rejectedRows as Array<{
      indicator_id: string;
      quarter_key: string;
    }>) {
      if (!rejectedMap.has(indicator_id)) rejectedMap.set(indicator_id, []);
      rejectedMap.get(indicator_id)!.push(quarter_key);
    }

    const enriched = (rows as Array<{ id: string }>).map((row) => ({
      ...row,
      rejectedQuarters: rejectedMap.get(row.id) ?? [],
    }));

    res.status(200).json({ success: true, results: enriched.length, data: enriched });
  }),

  // ── Internal: send email alerts after a submission ────────────────────────
  _sendAlerts: async (
    user: IUser,
    indicator: Record<string, unknown>,
    quarter: number,
  ): Promise<void> => {
    const year = new Date().getFullYear();
    const cycle = (indicator.reporting_cycle as string) ?? "Quarterly";
    const label = quarter === 0 ? "Annual" : `Q${quarter}`;

    await sendMail({
      to: user.email,
      subject: `Filing Confirmation: ${label}`,
      html: submissionReceivedTemplate(
        user.name,
        (indicator.instructions as string) ?? "Indicator",
        cycle,
        quarter,
        year,
      ),
    }).catch((e) => {
      console.error("[_sendAlerts] Failed to send user confirmation:", e);
      throw e;
    });

    const admins = await pool.query(
      `SELECT email, name FROM users WHERE role = 'admin' AND is_active = true`,
    );

    if (admins.rows.length > 0) {
      await Promise.all(
        (admins.rows as Array<{ email: string; name: string }>).map((admin) =>
          sendMail({
            to: admin.email,
            subject: "Filing Awaiting Review",
            html: adminReviewNeededTemplate(
              admin.name,
              user.name,
              (indicator.instructions as string) ?? "Indicator",
              cycle,
              quarter,
              year,
            ),
          }).catch((e) =>
            console.error(`[_sendAlerts] Failed to notify admin ${admin.email}:`, e),
          ),
        ),
      );
    }
  },
};