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
import { deleteFromCloudinary, uploadMultipleToCloudinary } from "../../config/cloudinary";
import { IndicatorService } from "../user/Indicator.model";
import { PoolClient } from "pg";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAuthUser(req: Request): IUser {
  return (req as Request & { user: IUser }).user;
}

async function getUserTeamIds(userId: string): Promise<string[]> {
  const res = await pool.query(
    "SELECT team_id FROM team_members WHERE user_id = $1",
    [userId],
  );
  return res.rows.map((r) => r.team_id);
}

/**
 * Normalises any quarter value into a consistent string key used for
 * grouping and display.
 *
 *  "annual" (any casing) → "Annual"
 *  1 | "1" | "Q1"        → "Q1"
 *  2 | "2" | "Q2"        → "Q2"   … etc.
 *
 * The returned value is what gets stored in submissions.quarter AND used
 * as the folder-key prefix (e.g. "Q1_2025", "Annual_2025").
 */
function normaliseQuarter(raw: string | number): string {
  const s = String(raw).trim();
  if (s.toLowerCase() === "annual") return "Annual";
  // Strip a leading "Q" so "Q1" and "1" both become "Q1"
  const n = s.replace(/^Q/i, "");
  return isNaN(Number(n)) ? s.toUpperCase() : `Q${n}`;
}

/**
 * Resolves the target quarter for submit / resubmit operations.
 * Annual indicators always use the string "Annual" rather than the
 * integer 1, so the quarter key is consistent across the system.
 */
function resolveTargetQuarter(indicator: Record<string, any>): string {
  if (indicator.reporting_cycle === "Annual") return "Annual";
  return normaliseQuarter(indicator.active_quarter);
}

/**
 * Builds a parameterised ownership WHERE clause.
 * The uuid[] cast on the team array prevents type-mismatch errors when
 * the assignee_id column is of type uuid.
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
  indicator: Record<string, any>,
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
    if (teamIds.includes(assignee_id)) return;

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

// ─── Base query ───────────────────────────────────────────────────────────────

/**
 * Submissions are grouped into quarterly folders matching the admin view:
 *
 *   { "Q1_2025": [...], "Q2_2025": [...], "Annual_2025": [...] }
 *
 * FIX: s.quarter may be stored as an integer column in PostgreSQL.
 * LOWER() and UPPER() are string functions — passing an integer column
 * directly causes "function lower(integer) does not exist".
 * All references use s.quarter::text to cast before applying string ops.
 *
 * This guarantees the frontend can use identical folder-rendering logic for
 * both the user and admin views.
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

    -- ── Quarterly-grouped submissions (matches admin shape) ───────────────
    -- Key: "Q1_2025" | "Q2_2025" | "Q3_2025" | "Q4_2025" | "Annual_2025"
    -- NOTE: ::text casts are required because s.quarter is an integer column.
    COALESCE(
      (
        SELECT json_object_agg(quarter_key, quarter_submissions)
        FROM (
          SELECT
            CONCAT(
              CASE
                WHEN LOWER(s.quarter::text) = 'annual' THEN 'Annual'
                ELSE UPPER(s.quarter::text)
              END,
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
                        'id',             d.id,
                        'evidenceUrl',    d.evidence_url,
                        'fileType',       d.file_type,
                        'fileName',       d.file_name,
                        'description',    d.description,
                        'status',         d.status,
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
            -- FIX: ::text cast required here too — same integer column
            CASE WHEN LOWER(s.quarter::text) = 'annual' THEN 'Annual' ELSE UPPER(s.quarter::text) END,
            s.year
        ) grouped
      ),
      '{}'
    ) AS submissions

  FROM indicators i
  LEFT JOIN users u    ON i.assignee_id      = u.id  AND i.assignee_model = 'User'
  LEFT JOIN teams t    ON i.assignee_id      = t.id  AND i.assignee_model = 'Team'
  LEFT JOIN users ab   ON i.assigned_by      = ab.id
  LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
`;

// ─── Controller ───────────────────────────────────────────────────────────────

export const UserIndicatorController = {

  // ── 1. List my indicators ─────────────────────────────────────────────────
  getMyIndicators: asyncHandler(async (req: Request, res: Response) => {
    const user    = getAuthUser(req);
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
    const user    = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause, params } = ownershipClause([req.params.id], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY} WHERE i.id = $1 AND ${clause} ORDER BY i.id LIMIT 1`,
      params,
    );

    if (rows.length === 0) throw new AppError("Access denied or record missing.", 404);
    res.status(200).json({ success: true, data: rows[0] });
  }),

  // ── 3. Submit progress (first-time only) ──────────────────────────────────
  submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, descriptions } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (achievedValue === undefined || achievedValue === null)
      throw new AppError("Achieved value is required.", 400);

    const teamIds = await getUserTeamIds(user.id);
    const client  = await pool.connect();

    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0];

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const lockedStatuses = ["Awaiting Admin Approval", "Awaiting Super Admin", "Completed"];
      if (lockedStatuses.includes(indicator.status))
        throw new AppError(`Cannot submit while indicator is "${indicator.status}".`, 409);

      const targetQuarter = resolveTargetQuarter(indicator);

      const existing = await client.query(
        "SELECT id FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [indicatorId, targetQuarter],
      );
      if (existing.rows.length > 0) {
        throw new AppError(
          `A submission already exists for ${targetQuarter === "Annual" ? "the annual period" : targetQuarter}. Use resubmit instead.`,
          409,
        );
      }

      let newDocs: {
        url: string; public_id: string;
        file_type: "image" | "video" | "raw";
        file_name: string; description: string;
      }[] = [];

      if (files.length > 0) {
        const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
        const descArr = Array.isArray(descriptions)
          ? descriptions
          : descriptions ? [descriptions] : [];

        newDocs = uploads.map((upload, i) => ({
          url:         upload.secure_url,
          public_id:   upload.public_id,
          file_type:   resolveFileType(upload.resource_type, files[i].mimetype),
          file_name:   files[i].originalname,
          description: descArr[i] ?? "",
        }));
      }

      const newSub = await client.query(
        `INSERT INTO submissions
           (indicator_id, quarter, year, notes, achieved_value, review_status)
         VALUES ($1, $2, $3, $4, $5, 'Pending')
         RETURNING id`,
        [indicatorId, targetQuarter, new Date().getFullYear(), notes.trim(), achievedValue],
      );
      const submissionId: string = newSub.rows[0].id;

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
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Submitted', $2, 'user', $3)`,
        [
          indicatorId,
          `Filing for ${targetQuarter === "Annual" ? "Annual" : targetQuarter}`,
          user.id,
        ],
      );

      await client.query("COMMIT");

      await IndicatorService.syncIndicatorState(indicatorId);

      UserIndicatorController._sendAlerts(user, indicator, targetQuarter).catch(
        (e) => console.error("Mail Error:", e),
      );

      res.status(201).json({ success: true, message: "Filing submitted successfully." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 4. Resubmit progress (existing submission only) ───────────────────────
  resubmitProgress: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, descriptions } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (achievedValue === undefined || achievedValue === null)
      throw new AppError("Achieved value is required.", 400);

    const teamIds = await getUserTeamIds(user.id);
    const client  = await pool.connect();

    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0];

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const lockedStatuses = ["Awaiting Admin Approval", "Awaiting Super Admin", "Completed"];
      if (lockedStatuses.includes(indicator.status))
        throw new AppError(`Cannot resubmit while indicator is "${indicator.status}".`, 409);

      const targetQuarter = resolveTargetQuarter(indicator);

      const subRes = await client.query(
        "SELECT id FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [indicatorId, targetQuarter],
      );
      if (subRes.rows.length === 0) {
        throw new AppError(
          `No existing submission found for ${targetQuarter === "Annual" ? "the annual period" : targetQuarter}. Use submit instead.`,
          404,
        );
      }
      const submissionId: string = subRes.rows[0].id;

      await client.query(
        `UPDATE submissions
         SET notes              = $1,
             achieved_value     = $2,
             review_status      = 'Pending',
             is_reviewed        = false,
             submitted_at       = NOW(),
             resubmission_count = resubmission_count + 1
         WHERE id = $3`,
        [notes.trim(), achievedValue, submissionId],
      );

      const deletedDocs = await client.query(
        `DELETE FROM submission_documents
         WHERE submission_id = $1
         RETURNING evidence_public_id`,
        [submissionId],
      );
      const oldPublicIds: string[] = deletedDocs.rows.map((r) => r.evidence_public_id);

      let newDocs: {
        url: string; public_id: string;
        file_type: "image" | "video" | "raw";
        file_name: string; description: string;
      }[] = [];

      if (files.length > 0) {
        const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
        const descArr = Array.isArray(descriptions)
          ? descriptions
          : descriptions ? [descriptions] : [];

        newDocs = uploads.map((upload, i) => ({
          url:         upload.secure_url,
          public_id:   upload.public_id,
          file_type:   resolveFileType(upload.resource_type, files[i].mimetype),
          file_name:   files[i].originalname,
          description: descArr[i] ?? "",
        }));
      }

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
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Resubmitted', $2, 'user', $3)`,
        [
          indicatorId,
          `Resubmission for ${targetQuarter === "Annual" ? "Annual" : targetQuarter}`,
          user.id,
        ],
      );

      await client.query("COMMIT");

      if (oldPublicIds.length > 0) {
        oldPublicIds.forEach((pid) => {
          if (pid)
            deleteFromCloudinary(pid).catch((e) =>
              console.error("[resubmitProgress] Cloudinary cleanup failed:", e),
            );
        });
      }

      await IndicatorService.syncIndicatorState(indicatorId);

      UserIndicatorController._sendAlerts(user, indicator, targetQuarter).catch(
        (e) => console.error("Mail Error:", e),
      );

      res.status(200).json({ success: true, message: "Resubmission processed successfully." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 5. Update a rejected submission ───────────────────────────────────────
  updateSubmission: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, quarter } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (!quarter)       throw new AppError("Quarter is required.", 400);

    const normalisedQuarter = normaliseQuarter(quarter);

    const teamIds = await getUserTeamIds(user.id);
    const client  = await pool.connect();

    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0];

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const result = await client.query(
        `UPDATE submissions
         SET notes              = $1,
             achieved_value     = $2,
             review_status      = 'Pending',
             is_reviewed        = false,
             submitted_at       = NOW(),
             resubmission_count = resubmission_count + 1
         WHERE indicator_id = $3
           AND quarter       = $4
           AND review_status = 'Rejected'
         RETURNING id`,
        [notes.trim(), achievedValue, indicatorId, normalisedQuarter],
      );

      if (result.rowCount === 0)
        throw new AppError("No rejected submission found to update for this quarter.", 404);

      const submissionId: string = result.rows[0].id;

      let newDocs: {
        url: string; public_id: string;
        file_type: "image" | "video" | "raw"; file_name: string;
      }[] = [];

      if (files.length > 0) {
        const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
        newDocs = uploads.map((upload, i) => ({
          url:       upload.secure_url,
          public_id: upload.public_id,
          file_type: resolveFileType(upload.resource_type, files[i].mimetype),
          file_name: files[i].originalname,
        }));
      }

      let oldPublicIds: string[] = [];
      if (newDocs.length > 0) {
        const deletedDocs = await client.query(
          `DELETE FROM submission_documents
           WHERE submission_id = $1
           RETURNING evidence_public_id`,
          [submissionId],
        );
        oldPublicIds = deletedDocs.rows.map((r) => r.evidence_public_id);

        await Promise.all(
          newDocs.map((doc) =>
            client.query(
              `INSERT INTO submission_documents
                 (submission_id, evidence_url, evidence_public_id, file_type, file_name)
               VALUES ($1, $2, $3, $4, $5)`,
              [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name],
            ),
          ),
        );
      }

      const quarterLabel =
        normalisedQuarter === "Annual" ? "Annual" : normalisedQuarter;

      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Resubmitted', $2, 'user', $3)`,
        [indicatorId, `Correction resubmitted for ${quarterLabel}`, user.id],
      );

      await client.query("COMMIT");

      if (oldPublicIds.length > 0) {
        oldPublicIds.forEach((pid) =>
          deleteFromCloudinary(pid).catch((e) =>
            console.error("[updateSubmission] Cloudinary cleanup failed:", e),
          ),
        );
      }

      await IndicatorService.syncIndicatorState(indicatorId);

      res.status(200).json({ success: true, message: "Submission updated and resent for review." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),

  // ── 6. Add documents to an existing submission ────────────────────────────
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const user                      = getAuthUser(req);
    const { id }                    = req.params;
    const { quarter, descriptions } = req.body;
    const files                     = (req.files ?? []) as Express.Multer.File[];

    if (!files.length) throw new AppError("No files provided.", 400);

    const teamIds = await getUserTeamIds(user.id);
    const client  = await pool.connect();

    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [id],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0];

      await assertIndicatorOwnership(client, indicator, user.id, teamIds);

      const rawQ    = quarter ?? indicator.active_quarter;
      const targetQ =
        indicator.reporting_cycle === "Annual"
          ? "Annual"
          : normaliseQuarter(rawQ);

      const subRes = await client.query(
        "SELECT id, review_status FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [id, targetQ],
      );
      const submission = subRes.rows[0];

      if (!submission)
        throw new AppError(`No submission found for ${targetQ}.`, 404);
      if (submission.review_status === "Accepted")
        throw new AppError("Certified records are locked.", 400);

      const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
      const descArr = Array.isArray(descriptions)
        ? descriptions
        : descriptions ? [descriptions] : [];

      const results = await Promise.all(
        uploads.map((upload, i) =>
          client.query(
            `INSERT INTO submission_documents
               (submission_id, evidence_url, evidence_public_id, file_type, file_name, description)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              submission.id,
              upload.secure_url,
              upload.public_id,
              resolveFileType(upload.resource_type, files[i].mimetype),
              files[i].originalname,
              descArr[i] ?? "",
            ],
          ),
        ),
      );

      await client.query("COMMIT");

      res.status(200).json({
        success:   true,
        message:   `${files.length} document(s) attached successfully.`,
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
    const user      = getAuthUser(req);
    const { docId } = req.params;
    const teamIds   = await getUserTeamIds(user.id);

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
       JOIN submissions s ON d.submission_id  = s.id
       JOIN indicators  i ON s.indicator_id   = i.id
       WHERE d.id = $1 ${ownershipFilter}`,
      checkParams,
    );

    if (rows.length === 0)
      throw new AppError("Document not found or access denied.", 404);

    const doc = rows[0];
    if (doc.doc_status !== "Rejected")
      throw new AppError("Only rejected documents can be deleted.", 400);

    await pool.query("DELETE FROM submission_documents WHERE id = $1", [docId]);

    deleteFromCloudinary(doc.evidence_public_id).catch((e) =>
      console.error("[deleteDocument] Cloudinary cleanup failed:", e),
    );

    res.status(200).json({ success: true, message: "Rejected document removed." });
  }),

  // ── 8. Stream a Cloudinary file through the server ────────────────────────
  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const url  = decodeURIComponent(req.query.url as string);

    if (!url || !url.startsWith("https://res.cloudinary.com/"))
      throw new AppError("Invalid source.", 400);

    const privilegedRoles = ["admin", "superadmin", "examiner"];
    const hasPrivilege    = privilegedRoles.includes(user.role);
    let isAuthorized      = false;

    if (hasPrivilege) {
      const { rows } = await pool.query(
        `SELECT id FROM submission_documents WHERE evidence_url = $1 LIMIT 1`,
        [url],
      );
      if (rows.length > 0) isAuthorized = true;
    } else {
      const teamIds = await getUserTeamIds(user.id);

      const ownershipFilter =
        teamIds.length > 0
          ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
                 OR i.assignee_id = ANY($3::uuid[]) AND i.assignee_model = 'Team')`
          : `AND i.assignee_id = $2 AND i.assignee_model = 'User'`;

      const checkParams = teamIds.length > 0 ? [url, user.id, teamIds] : [url, user.id];

      const { rows } = await pool.query(
        `SELECT d.id
         FROM submission_documents d
         JOIN submissions s ON d.submission_id = s.id
         JOIN indicators  i ON s.indicator_id  = i.id
         WHERE d.evidence_url = $1 ${ownershipFilter}
         LIMIT 1`,
        checkParams,
      );
      if (rows.length > 0) isAuthorized = true;
    }

    if (!isAuthorized) throw new AppError("Access denied.", 403);

    const response = await axios({ method: "GET", url, responseType: "stream" });
    res.setHeader(
      "Content-Type",
      response.headers["content-type"] ?? "application/octet-stream",
    );
    response.data.pipe(res);
  }),

  // ── 9. List only indicators with rejected submissions (with rejectedQuarters) ──
  /**
   * Returns indicators that have at least one rejected quarter, plus a
   * `rejectedQuarters` string array so the frontend can badge only the
   * affected folder tabs (mirrors admin's `pendingQuarters`).
   *
   * FIX: ::text cast applied to s.quarter in the CONCAT so PostgreSQL does
   * not attempt LOWER(integer) / UPPER(integer).
   *
   * Example: { ..., rejectedQuarters: ["Q1_2025", "Annual_2025"] }
   */
  getRejectedSubmissions: asyncHandler(async (req: Request, res: Response) => {
    const user    = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);
    const { clause: ownership, params } = ownershipClause([], user.id, teamIds);

    const { rows } = await pool.query(
      `${USER_INDICATOR_BASE_QUERY}
       WHERE ${ownership}
         AND EXISTS (
           SELECT 1 FROM submissions s
           WHERE  s.indicator_id = i.id
             AND  s.review_status = 'Rejected'
         )
       ORDER BY i.id, i.updated_at DESC`,
      params,
    );

    if (rows.length === 0)
      return res.status(200).json({ success: true, results: 0, data: [] });

    const indicatorIds = rows.map((r: any) => r.id);

    // FIX: ::text cast on s.quarter — same integer-column issue as base query
    const { rows: rejectedRows } = await pool.query(
      `SELECT
         s.indicator_id,
         CONCAT(
           CASE WHEN LOWER(s.quarter::text) = 'annual' THEN 'Annual' ELSE UPPER(s.quarter::text) END,
           '_', s.year
         ) AS quarter_key
       FROM submissions s
       WHERE s.indicator_id  = ANY($1)
         AND s.review_status = 'Rejected'
       GROUP BY s.indicator_id, quarter_key`,
      [indicatorIds],
    );

    const rejectedMap = new Map<string, string[]>();
    for (const { indicator_id, quarter_key } of rejectedRows) {
      if (!rejectedMap.has(indicator_id)) rejectedMap.set(indicator_id, []);
      rejectedMap.get(indicator_id)!.push(quarter_key);
    }

    const enriched = rows.map((row: any) => ({
      ...row,
      rejectedQuarters: rejectedMap.get(row.id) ?? [],
    }));

    res.status(200).json({ success: true, results: enriched.length, data: enriched });
  }),

  // ── Internal: send email alerts after a submission ────────────────────────
  _sendAlerts: async (
    user: IUser,
    indicator: Record<string, any>,
    quarter: string,
  ): Promise<void> => {
    const year       = new Date().getFullYear();
    const cycle      = (indicator.reporting_cycle as string) ?? "Quarterly";
    const label      = quarter === "Annual" ? "Annual" : quarter;
    const quarterNum = quarter === "Annual" ? 0 : parseInt(quarter.replace(/^Q/i, ""), 10);

    await sendMail({
      to:      user.email,
      subject: `Filing Confirmation: ${label}`,
      html:    submissionReceivedTemplate(
        user.name,
        indicator.instructions ?? "Indicator",
        cycle,
        quarterNum,
        year,
      ),
    });

    const admins = await pool.query(
      `SELECT email, name FROM users WHERE role = 'admin' AND is_active = true`,
    );

    await Promise.all(
      admins.rows.map((admin) =>
        sendMail({
          to:      admin.email,
          subject: "Filing Awaiting Review",
          html:    adminReviewNeededTemplate(
            admin.name,
            user.name,
            indicator.instructions ?? "Indicator",
            cycle,
            quarterNum,
            year,
          ),
        }),
      ),
    );
  },
};

// ─── Shared utility ───────────────────────────────────────────────────────────

function resolveFileType(
  resourceType: string,
  mimetype: string,
): "image" | "video" | "raw" {
  if (resourceType === "video")          return "video";
  if (mimetype    === "application/pdf") return "raw";
  return "image";
}