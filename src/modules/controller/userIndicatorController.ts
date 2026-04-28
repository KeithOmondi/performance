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

/**
 * Typed accessor for the authenticated user injected by auth middleware.
 */
function getAuthUser(req: Request): IUser {
  return (req as Request & { user: IUser }).user;
}

/**
 * Returns all team IDs the given user belongs to.
 * Extracted so every handler doesn't repeat this query.
 */
async function getUserTeamIds(userId: string): Promise<string[]> {
  const res = await pool.query(
    "SELECT team_id FROM team_members WHERE user_id = $1",
    [userId],
  );
  return res.rows.map((r) => r.team_id);
}

/**
 * Builds the ownership WHERE clause and matching parameter list,
 * handling both direct-user and team-assigned indicators uniformly.
 *
 * @param baseParams   - Already-bound params before the ownership block
 * @param userId       - Authenticated user's ID
 * @param teamIds      - User's team memberships
 * @param tableAlias   - SQL alias used for the indicators table (default "i")
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
    clause += ` OR (${tableAlias}.assignee_id = ANY($${teamIdx}) AND ${tableAlias}.assignee_model = 'Team')`;
  }

  clause += ")";
  return { clause, params };
}

/**
 * Asserts that the given user owns (or is a team member of) the indicator.
 * Must be called inside an open transaction using the transaction client so
 * the indicator row is already locked before this check runs.
 *
 * Throws a 403 AppError if the user has no claim over the indicator.
 *
 * @param client     - Active transaction client (indicator already locked)
 * @param indicator  - The already-fetched indicator row
 * @param userId     - Authenticated user's ID
 * @param teamIds    - User's team memberships (pre-fetched before the tx)
 */
async function assertIndicatorOwnership(
  client: PoolClient,
  indicator: Record<string, any>,
  userId: string,
  teamIds: string[],
): Promise<void> {
  const { assignee_id, assignee_model } = indicator;

  if (assignee_model === "User") {
    // Direct assignment — must be the exact assignee.
    if (assignee_id !== userId) {
      throw new AppError("Access denied: you are not assigned to this indicator.", 403);
    }
    return;
  }

  if (assignee_model === "Team") {
    // Team assignment — user must be a member of the assigned team.
    // First check the pre-fetched list; fall back to a DB query in case
    // the list was built before a recent team membership change.
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

  // Unknown assignee_model — deny by default.
  throw new AppError("Access denied: unrecognised assignee type.", 403);
}

// ─── Base query ─────────────────────────────────────────────────────────────

const USER_INDICATOR_BASE_QUERY = `
  SELECT
    i.*,
    u.name                                          AS "assigneeName",
    ab.name                                         AS "assignedByName",
    sp.perspective,
    (SELECT json_build_object('title', title)
       FROM strategic_objectives WHERE id = i.objective_id)   AS objective,
    (SELECT json_build_object('description', description)
       FROM strategic_activities  WHERE id = i.activity_id)   AS activity,
    COALESCE(
      (SELECT json_agg(json_build_object(
          'id',            s.id,
          'quarter',       s.quarter,
          'notes',         s.notes,
          'achievedValue', s.achieved_value,
          'reviewStatus',  s.review_status,
          'submittedAt',   s.submitted_at,
          'documents',     (
            SELECT json_agg(json_build_object(
              'id',               d.id,
              'evidenceUrl',      d.evidence_url,
              'fileType',         d.file_type,
              'fileName',         d.file_name,
              'description',      d.description,
              'status',           d.status
            ))
            FROM submission_documents d
            WHERE d.submission_id = s.id
          )
        ))
        FROM submissions s WHERE s.indicator_id = i.id
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
      `${USER_INDICATOR_BASE_QUERY} WHERE ${clause} ORDER BY i.updated_at DESC`,
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
      `${USER_INDICATOR_BASE_QUERY} WHERE i.id = $1 AND ${clause} LIMIT 1`,
      params,
    );

    if (rows.length === 0) throw new AppError("Access denied or record missing.", 404);
    res.status(200).json({ success: true, data: rows[0] });
  }),

  // ── 3. Submit / resubmit progress ───────────────────────────────────────
  // ─── 3. Submit / resubmit progress (Rewritten) ───────────────────────────
submitProgress: asyncHandler(async (req: Request, res: Response) => {
  const user = getAuthUser(req);
  const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { notes, achievedValue, descriptions } = req.body;
  const files = (req.files ?? []) as Express.Multer.File[];

  if (!indicatorId) throw new AppError("Indicator ID is required.", 400);
  if (!notes?.trim()) throw new AppError("Notes are required.", 400);
  if (achievedValue === undefined || achievedValue === null) {
    throw new AppError("Achieved value is required.", 400);
  }

  const teamIds = await getUserTeamIds(user.id);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Lock the indicator and verify ownership
    const indRes = await client.query(
      "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
      [indicatorId]
    );
    if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
    const indicator = indRes.rows[0];

    await assertIndicatorOwnership(client, indicator, user.id, teamIds);

    // 2. Prevent submission if locked by workflow
    const lockedStatuses = ["Awaiting Admin Approval", "Awaiting Super Admin", "Completed"];
    if (lockedStatuses.includes(indicator.status)) {
      throw new AppError(`Cannot submit while indicator is "${indicator.status}".`, 409);
    }

    const targetQuarter = indicator.reporting_cycle === "Annual" ? 1 : indicator.active_quarter;

    // 3. Find existing submission for this quarter
    const subRes = await client.query(
      "SELECT id FROM submissions WHERE indicator_id = $1 AND quarter = $2",
      [indicatorId, targetQuarter]
    );
    const existingSub = subRes.rows[0];

    // 4. Prepare Cloudinary uploads (if any)
    let newDocs: any[] = [];
    if (files.length > 0) {
      const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
      const descArr = Array.isArray(descriptions) ? descriptions : descriptions ? [descriptions] : [];

      newDocs = uploads.map((upload, i) => ({
        url: upload.secure_url,
        public_id: upload.public_id,
        file_type: resolveFileType(upload.resource_type, files[i].mimetype),
        file_name: files[i].originalname,
        description: descArr[i] ?? "",
      }));
    }

    // 5. Upsert Submission and PURGE old documents
    let submissionId: string;
    let oldPublicIds: string[] = [];

    if (existingSub) {
      submissionId = existingSub.id;

      // Update text fields
      await client.query(
        `UPDATE submissions 
         SET notes = $1, achieved_value = $2, review_status = 'Pending', 
             is_reviewed = false, submitted_at = NOW(), 
             resubmission_count = resubmission_count + 1
         WHERE id = $3`,
        [notes.trim(), achievedValue, submissionId]
      );

      // 🔥 THE FIX: Always clear old documents for this submission ID
      // This ensures if the user uploads nothing, the registry is empty.
      const deletedDocs = await client.query(
        `DELETE FROM submission_documents 
         WHERE submission_id = $1 
         RETURNING evidence_public_id`,
        [submissionId]
      );
      oldPublicIds = deletedDocs.rows.map((r) => r.evidence_public_id);
    } else {
      // Create new submission record
      const newSub = await client.query(
        `INSERT INTO submissions (indicator_id, quarter, year, notes, achieved_value, review_status)
         VALUES ($1, $2, $3, $4, $5, 'Pending') RETURNING id`,
        [indicatorId, targetQuarter, new Date().getFullYear(), notes.trim(), achievedValue]
      );
      submissionId = newSub.rows[0].id;
    }

    // 6. Insert new documents (if any were uploaded)
    if (newDocs.length > 0) {
      await Promise.all(
        newDocs.map((doc) =>
          client.query(
            `INSERT INTO submission_documents 
               (submission_id, evidence_url, evidence_public_id, file_type, file_name, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [submissionId, doc.url, doc.public_id, doc.file_type, doc.file_name, doc.description]
          )
        )
      );
    }

    // 7. Audit Trail
    await client.query(
      `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
       VALUES ($1, $2, $3, 'user', $4)`,
      [
        indicatorId,
        existingSub ? "Resubmitted" : "Submitted",
        `Filing update for ${indicator.reporting_cycle === "Annual" ? "Annual" : `Q${targetQuarter}`}`,
        user.id,
      ]
    );

    await client.query("COMMIT");

    // ── Post-Commit Side Effects ──

    // Cleanup Cloudinary storage for deleted files
    if (oldPublicIds.length > 0) {
      oldPublicIds.forEach((pid) => {
        if (pid) deleteFromCloudinary(pid).catch(e => console.error("Cloudinary Cleanup Error:", e));
      });
    }

    // Sync progress score and indicator status
    await IndicatorService.syncIndicatorState(indicatorId);

    // Send alerts
    UserIndicatorController._sendAlerts(user, indicator, targetQuarter).catch(
      (e) => console.error("Mail Error:", e)
    );

    res.status(201).json({ 
      success: true, 
      message: "Registry updated successfully. Old evidence cleared." 
    });

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}),

  // ── 4. Update a rejected submission ─────────────────────────────────────
  updateSubmission: asyncHandler(async (req: Request, res: Response) => {
    const user        = getAuthUser(req);
    const indicatorId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { notes, achievedValue, quarter } = req.body;
    const files       = (req.files ?? []) as Express.Multer.File[];

    if (!indicatorId)   throw new AppError("Indicator ID is required.", 400);
    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (!quarter)       throw new AppError("Quarter is required.", 400);

    const teamIds = await getUserTeamIds(user.id);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch and lock the indicator first so ownership can be verified
      // before the submission row is touched.
      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );
      if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);
      const indicator = indRes.rows[0];

      // Ownership gate — mirrors the guard in submitProgress.
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

      // ── Upload replacement evidence ────────────────────────────────────
      let newDocs: {
        url: string;
        public_id: string;
        file_type: "image" | "video" | "raw";
        file_name: string;
      }[] = [];

      if (files.length > 0) {
        const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
        newDocs = uploads.map((upload, i) => {
          if (!upload.secure_url) {
            throw new AppError(`Failed to get URL for file: ${files[i].originalname}`, 500);
          }
          return {
            url:       upload.secure_url,
            public_id: upload.public_id,
            file_type: resolveFileType(upload.resource_type, files[i].mimetype),
            file_name: files[i].originalname,
          };
        });
      }

      // Purge old documents before inserting the replacement set.
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

      // Best-effort Cloudinary cleanup — after commit so it never causes a rollback.
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

  // ── 5. Add documents to an existing submission ───────────────────────────
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const user    = getAuthUser(req);
    const { id }  = req.params;
    const { quarter } = req.body;
    const files   = (req.files ?? []) as Express.Multer.File[];

    if (!files.length) throw new AppError("No files provided.", 400);

    const teamIds = await getUserTeamIds(user.id);
    const { clause, params } = ownershipClause([id], user.id, teamIds);

    const indRes = await pool.query(
      `SELECT id, active_quarter
       FROM indicators
       WHERE id = $1 AND ${clause.replace(/i\./g, "")}`,
      params,
    );

    if (indRes.rows.length === 0) throw new AppError("Indicator not found.", 404);

    const targetQ = Number(quarter) || indRes.rows[0].active_quarter;

    const subRes = await pool.query(
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
        pool.query(
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
  }),

  // ── 6. Delete a rejected document ───────────────────────────────────────
  deleteDocument: asyncHandler(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const { docId } = req.params;

    const teamIds = await getUserTeamIds(user.id);

    const ownershipFilter =
      teamIds.length > 0
        ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
               OR i.assignee_id = ANY($3) AND i.assignee_model = 'Team')`
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

  // ── 7. Stream a Cloudinary file through the server ──────────────────────
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
      const ownershipFilter =
        teamIds.length > 0
          ? `AND (i.assignee_id = $2 AND i.assignee_model = 'User'
                 OR i.assignee_id = ANY($3) AND i.assignee_model = 'Team')`
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

  // ── Internal: send email alerts after a submission ───────────────────────
  _sendAlerts: async (user: IUser, indicator: Record<string, any>, q: number): Promise<void> => {
    const year  = new Date().getFullYear();
    const cycle = (indicator.reporting_cycle as string) ?? "Quarterly";
    const label = cycle === "Annual" ? "Annual" : `Q${q}`;

    await sendMail({
      to:      user.email,
      subject: `Filing Confirmation: ${label}`,
      html:    submissionReceivedTemplate(user.name, indicator.instructions ?? "Indicator", cycle, q, year),
    });

    const admins = await pool.query(
      `SELECT u.email, u.name
       FROM users u
       JOIN strategic_plan_admins spa ON spa.user_id = u.id
       WHERE spa.strategic_plan_id = $1
         AND u.role      = 'admin'
         AND u.is_active = true`,
      [indicator.strategic_plan_id],
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

/**
 * Maps Cloudinary resource_type + browser mimetype to our FileType union.
 */
function resolveFileType(
  resourceType: string,
  mimetype: string,
): "image" | "video" | "raw" {
  if (resourceType === "video")          return "video";
  if (mimetype    === "application/pdf") return "raw";
  return "image";
}