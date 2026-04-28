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

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    // Explicit ::uuid[] cast avoids implicit-cast failures on uuid columns
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
    if (assignee_id !== userId) {
      throw new AppError("Access denied: you are not assigned to this indicator.", 403);
    }
    return;
  }

  if (assignee_model === "Team") {
    if (teamIds.includes(assignee_id)) return;

    const memberCheck = await client.query(
      `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
      [assignee_id, userId],
    );
    if (memberCheck.rowCount === 0) {
      throw new AppError(
        "Access denied: you are not a member of the team assigned to this indicator.",
        403,
      );
    }
    return;
  }

  throw new AppError("Access denied: unrecognised assignee type.", 403);
}

// ─── Base query ─────────────────────────────────────────────────────────────

const USER_INDICATOR_BASE_QUERY = `
  SELECT DISTINCT ON (i.id)
    i.*,
    u.name                                          AS "assigneeName",
    ab.name                                         AS "assignedByName",
    sp.perspective,
    (SELECT json_build_object('title', title)
       FROM strategic_objectives WHERE id = i.objective_id)   AS objective,
    (SELECT json_build_object('description', description)
       FROM strategic_activities  WHERE id = i.activity_id)   AS activity,
    COALESCE(
      (
        SELECT json_agg(ordered_subs)
        FROM (
          SELECT json_build_object(
            'id',                s.id,
            'quarter',           s.quarter,
            'notes',             s.notes,
            'achievedValue',     s.achieved_value,
            'reviewStatus',      s.review_status,
            'submittedAt',       s.submitted_at,
            'resubmissionCount', s.resubmission_count,
            'documents', (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'id',              d.id,
                  'evidenceUrl',     d.evidence_url,
                  'fileType',        d.file_type,
                  'fileName',        d.file_name,
                  'description',     d.description,
                  'status',          d.status
                )
                ORDER BY d.uploaded_at DESC
              ), '[]'::json)
              FROM submission_documents d
              WHERE d.submission_id = s.id
            )
          ) AS ordered_subs
          FROM submissions s
          WHERE s.indicator_id = i.id
          ORDER BY s.submitted_at DESC
        ) sub_rows
      ),
      '[]'
    ) AS submissions
  FROM indicators i
  LEFT JOIN users u  ON i.assignee_id    = u.id  AND i.assignee_model = 'User'
  LEFT JOIN teams t  ON i.assignee_id    = t.id  AND i.assignee_model = 'Team'
  LEFT JOIN users ab ON i.assigned_by    = ab.id
  LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
`;

// ─── Controller ─────────────────────────────────────────────────────────────

export const UserIndicatorController = {

  // ── 1. List my indicators ────────────────────────────────────────────────
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

  // ── 2. Get single indicator (ownership-gated) ────────────────────────────
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

  // ── 3. Submit progress (first-time only) ────────────────────────────────
  submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, descriptions } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (achievedValue === undefined || achievedValue === null) {
      throw new AppError("Achieved value is required.", 400);
    }

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
      if (lockedStatuses.includes(indicator.status)) {
        throw new AppError(`Cannot submit while indicator is "${indicator.status}".`, 409);
      }

      const targetQuarter =
        indicator.reporting_cycle === "Annual" ? 1 : indicator.active_quarter;

      const existing = await client.query(
        "SELECT id FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [indicatorId, targetQuarter],
      );
      if (existing.rows.length > 0) {
        throw new AppError(
          `A submission already exists for ${indicator.reporting_cycle === "Annual" ? "the annual period" : `Q${targetQuarter}`}. Use resubmit instead.`,
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
          ? descriptions : descriptions ? [descriptions] : [];

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
          `Filing for ${indicator.reporting_cycle === "Annual" ? "Annual" : `Q${targetQuarter}`}`,
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

  // ── 4. Resubmit progress (existing submission only) ──────────────────────
  resubmitProgress: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, descriptions } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (achievedValue === undefined || achievedValue === null) {
      throw new AppError("Achieved value is required.", 400);
    }

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
      if (lockedStatuses.includes(indicator.status)) {
        throw new AppError(`Cannot resubmit while indicator is "${indicator.status}".`, 409);
      }

      const targetQuarter =
        indicator.reporting_cycle === "Annual" ? 1 : indicator.active_quarter;

      const subRes = await client.query(
        "SELECT id FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [indicatorId, targetQuarter],
      );
      if (subRes.rows.length === 0) {
        throw new AppError(
          `No existing submission found for ${indicator.reporting_cycle === "Annual" ? "the annual period" : `Q${targetQuarter}`}. Use submit instead.`,
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
          ? descriptions : descriptions ? [descriptions] : [];

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
          `Resubmission for ${indicator.reporting_cycle === "Annual" ? "Annual" : `Q${targetQuarter}`}`,
          user.id,
        ],
      );

      await client.query("COMMIT");

      if (oldPublicIds.length > 0) {
        oldPublicIds.forEach((pid) => {
          if (pid) deleteFromCloudinary(pid).catch((e) =>
            console.error("[resubmitProgress] Cloudinary cleanup failed:", e));
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

  // ── 5. Update a rejected submission ─────────────────────────────────────
  updateSubmission: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, quarter } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (!quarter)       throw new AppError("Quarter is required.", 400);

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
        [notes.trim(), achievedValue, indicatorId, quarter],
      );

      if (result.rowCount === 0) {
        throw new AppError("No rejected submission found to update for this quarter.", 404);
      }

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

      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Resubmitted', $2, 'user', $3)`,
        [indicatorId, `Correction resubmitted for Q${quarter}`, user.id],
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

  // ── 6. Add documents to an existing submission ───────────────────────────
  // Fixed: replaced broken clause.replace() ownership check with a proper
  // assertIndicatorOwnership call using a dedicated client.
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const user    = getAuthUser(req);
    const { id }  = req.params;
    const { quarter } = req.body;
    const files   = (req.files ?? []) as Express.Multer.File[];

    if (!files.length) throw new AppError("No files provided.", 400);

    const teamIds = await getUserTeamIds(user.id);
    const client  = await pool.connect();

    try {
      // Fetch the indicator and assert ownership via the shared helper,
      // which correctly handles both User and Team assignee models.
      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [id],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);

      await assertIndicatorOwnership(client, indRes.rows[0], user.id, teamIds);

      const targetQ = Number(quarter) || indRes.rows[0].active_quarter;

      const subRes = await client.query(
        "SELECT id, review_status FROM submissions WHERE indicator_id = $1 AND quarter = $2",
        [id, targetQ],
      );
      const submission = subRes.rows[0];

      if (!submission) throw new AppError("No submission found for this quarter.", 404);

      if (submission.review_status === "Accepted") {
        throw new AppError("Certified records are locked.", 400);
      }

      const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");

      const results = await Promise.all(
        uploads.map((upload, i) =>
          client.query(
            `INSERT INTO submission_documents
               (submission_id, evidence_url, evidence_public_id, file_type, file_name)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
              submission.id,
              upload.secure_url,
              upload.public_id,
              resolveFileType(upload.resource_type, files[i].mimetype),
              files[i].originalname,
            ],
          ),
        ),
      );

      res.status(200).json({
        success:   true,
        message:   `${files.length} document(s) attached.`,
        documents: results.map((r) => r.rows[0]),
      });
    } finally {
      client.release();
    }
  }),

  // ── 7. Delete a rejected document ───────────────────────────────────────
  deleteDocument: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { docId } = req.params;

    const teamIds = await getUserTeamIds(user.id);

    // uuid[] cast applied here for consistency with ownershipClause
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
       JOIN submissions  s ON d.submission_id  = s.id
       JOIN indicators   i ON s.indicator_id   = i.id
       WHERE d.id = $1 ${ownershipFilter}`,
      checkParams,
    );

    if (rows.length === 0) {
      throw new AppError("Document not found or access denied.", 404);
    }

    const doc = rows[0];
    if (doc.doc_status !== "Rejected") {
      throw new AppError("Only rejected documents can be deleted.", 400);
    }

    await pool.query("DELETE FROM submission_documents WHERE id = $1", [docId]);

    deleteFromCloudinary(doc.evidence_public_id).catch((e) =>
      console.error("[deleteDocument] Cloudinary cleanup failed:", e),
    );

    res.status(200).json({ success: true, message: "Rejected document removed." });
  }),

  // ── 8. Stream a Cloudinary file through the server ──────────────────────
  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const url  = decodeURIComponent(req.query.url as string);

    if (!url || !url.startsWith("https://res.cloudinary.com/")) {
      throw new AppError("Invalid source.", 400);
    }

    const privilegedRoles = ["admin", "superadmin", "examiner"];
    const hasPrivilege    = privilegedRoles.includes(user.role);

    let isAuthorized = false;

    if (hasPrivilege) {
      const { rows } = await pool.query(
        `SELECT id FROM submission_documents WHERE evidence_url = $1 LIMIT 1`,
        [url],
      );
      if (rows.length > 0) isAuthorized = true;
    } else {
      const teamIds = await getUserTeamIds(user.id);

      // uuid[] cast applied here for consistency
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

  // ── 9. List only indicators with rejected submissions ────────────────────
  getRejectedSubmissions: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const teamIds = await getUserTeamIds(user.id);

    // 1. Get ownership clause
    const { clause: ownership, params } = ownershipClause([], user.id, teamIds);

    // 2. Build query to filter for indicators that have ANY rejected submission
    // We use EXISTS to keep the query performant
    const rejectedQuery = `
      ${USER_INDICATOR_BASE_QUERY} 
      WHERE ${ownership} 
      AND EXISTS (
        SELECT 1 FROM submissions s 
        WHERE s.indicator_id = i.id 
        AND s.review_status = 'Rejected'
      )
      ORDER BY i.id, i.updated_at DESC
    `;

    const { rows } = await pool.query(rejectedQuery, params);

    res.status(200).json({ 
      success: true, 
      results: rows.length, 
      data: rows 
    });
  }),

  // ── Internal: send email alerts after a submission ───────────────────────
  _sendAlerts: async (user: IUser, indicator: Record<string, any>, q: number): Promise<void> => {
    const year  = new Date().getFullYear();
    const cycle = (indicator.reporting_cycle as string) ?? "Quarterly";
    const label = cycle === "Annual" ? "Annual" : `Q${q}`;

    await sendMail({
      to:      user.email,
      subject: `Filing Confirmation: ${label}`,
      html:    submissionReceivedTemplate(
        user.name,
        indicator.instructions ?? "Indicator",
        cycle,
        q,
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
            q,
            year,
          ),
        }),
      ),
    );
  },
};

// ─── Shared utility ─────────────────────────────────────────────────────────

function resolveFileType(
  resourceType: string,
  mimetype: string,
): "image" | "video" | "raw" {
  if (resourceType === "video")          return "video";
  if (mimetype    === "application/pdf") return "raw";
  return "image";
}