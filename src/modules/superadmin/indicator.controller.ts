import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { sendMail } from "../../utils/sendMail";
import { taskAssignedTemplate } from "../../utils/mailTemplates";

/* ─── SHARED SELECT FRAGMENT ─────────────────────────────────────────────────
   Every query that returns an indicator to the frontend uses this fragment.
   All snake_case columns are aliased to camelCase so the frontend slice works
   without any transformation.
────────────────────────────────────────────────────────────────────────────── */
const INDICATOR_SELECT = `
  SELECT
    i.id,
    i.status,
    i.weight,
    i.unit,
    i.target,
    i.progress,
    i.deadline,
    i.instructions,

    i.assignee_id            AS "assigneeId",
    i.assignee_model         AS "assignmentType",
    i.assigned_by            AS "assignedBy",
    i.strategic_plan_id      AS "strategicPlanId",
    i.objective_id           AS "objectiveId",
    i.activity_id            AS "activityId",
    i.reporting_cycle        AS "reportingCycle",
    i.active_quarter         AS "activeQuarter",
    i.current_total_achieved AS "currentTotalAchieved",
    i.created_at             AS "createdAt",
    i.updated_at             AS "updatedAt",

    sp.perspective,

    -- Resolved display name (works for both User and Team assignments)
    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE t.name
    END AS "assigneeDisplayName",

    -- Extra detail fields used by Reports and Modal
    ab.name        AS "assignedByName",
    so.title       AS "objectiveTitle",
    sa.description AS "activityDescription",
    u.pj_number    AS "assigneePjNumber"
`;

const INDICATOR_JOINS = `
  FROM indicators i
  LEFT JOIN users u               ON i.assignee_id = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t               ON i.assignee_id = t.id AND i.assignee_model = 'Team'
  LEFT JOIN users ab              ON i.assigned_by = ab.id
  LEFT JOIN strategic_plans     sp ON i.strategic_plan_id = sp.id
  LEFT JOIN strategic_objectives so ON i.objective_id = so.id
  LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
`;

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */

const isUUID = (val: any): boolean =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

/**
 * Resolves recipient emails and display names for notifications.
 * For Team assignments, emails all active members of the team.
 */
async function resolveRecipients(
  assigneeId: string,
  type: "User" | "Team"
): Promise<{ emails: string[]; displayName: string }> {
  if (type === "User") {
    const { rows } = await pool.query(
      "SELECT name, email FROM users WHERE id = $1",
      [assigneeId]
    );
    return {
      emails: rows[0] ? [rows[0].email] : [],
      displayName: rows[0]?.name || "Unknown",
    };
  }

  const { rows } = await pool.query(
    `SELECT u.email, t.name AS team_name
     FROM users u
     JOIN team_members tm ON u.id = tm.user_id
     JOIN teams t         ON tm.team_id = t.id
     WHERE t.id = $1 AND u.is_active = true`,
    [assigneeId]
  );

  return {
    emails: rows.map((r: { email: string }) => r.email),
    displayName: rows[0]?.team_name || "Unknown Team",
  };
}

/* ─── 1. CREATE INDICATOR ─────────────────────────────────────────────────── */

export const createIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const {
      strategicPlanId,
      objectiveId,
      activityId,
      assignee,
      assignmentType,
      reportingCycle,
      weight,
      unit,
      target,
      deadline,
      instructions,
      activeQuarter,
    } = req.body;

    const adminId = (req as any).user?.id;

    const uuidFields: [string, any][] = [
      ["strategicPlanId", strategicPlanId],
      ["objectiveId", objectiveId],
      ["activityId", activityId],
      ["assignee", assignee],
      ["adminId", adminId],
    ];

    for (const [field, value] of uuidFields) {
      if (!isUUID(value)) {
        throw new AppError(`Invalid value for "${field}": expected a UUID.`, 400);
      }
    }

    const parsedDeadline = new Date(deadline);
    if (isNaN(parsedDeadline.getTime())) {
      throw new AppError("Invalid deadline date.", 400);
    }

    const type  = assignmentType === "Team" ? "Team" : "User";
    const cycle = reportingCycle || "Quarterly";

    const { rows: inserted } = await pool.query(
      `INSERT INTO indicators (
         strategic_plan_id, objective_id, activity_id, assignee_id, assignee_model,
         reporting_cycle, weight, unit, target, deadline, instructions,
         active_quarter, assigned_by, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending')
       RETURNING id`,
      [
        strategicPlanId,
        objectiveId,
        activityId,
        assignee,
        type,
        cycle,
        weight ?? 5,
        unit || "%",
        target ?? 100,
        parsedDeadline,
        instructions || "",
        activeQuarter || 1,
        adminId,
      ]
    );

    const indicatorId = inserted[0].id;

    // Fetch full indicator for response
    const { rows: indicatorRows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [indicatorId]
    );

    // Fetch activity description and objective title for the email
    const { rows: activityRows } = await pool.query(
      `SELECT
         sa.description AS "activityDescription",
         so.title       AS "objectiveTitle"
       FROM strategic_activities sa
       LEFT JOIN strategic_objectives so ON so.id = $2
       WHERE sa.id = $1`,
      [activityId, objectiveId]
    );

    const activityDescription =
      activityRows[0]?.activityDescription || instructions || "Performance Indicator";
    const objectiveTitle = activityRows[0]?.objectiveTitle || undefined;

    // Fire-and-forget email — does not block the response
    resolveRecipients(assignee, type)
      .then(({ emails, displayName }) => {
        emails.forEach((email) =>
          sendMail({
            to: email,
            subject: "New Performance Indicator Assigned",
            html: taskAssignedTemplate(
              displayName,
              activityDescription,
              cycle,
              activeQuarter || 1,
              new Date().getFullYear(),
              parsedDeadline.toDateString(),
              objectiveTitle,
              target ?? 100,
              unit || "%"
            ),
          }).catch((e) =>
            console.error(
              `[createIndicator] Failed to send assignment email to ${email}:`,
              e
            )
          )
        );
      })
      .catch((err) =>
        console.error("[createIndicator] resolveRecipients failed:", err)
      );

    res.status(201).json({ success: true, data: indicatorRows[0] });
  }
);

/* ─── 2. GET ALL INDICATORS ───────────────────────────────────────────────── */

export const getAllIndicators = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, assignee, assignmentType } = req.query;

    let whereClause = "WHERE 1=1";
    const params: any[] = [];

    if (status) {
      params.push(status);
      whereClause += ` AND i.status = $${params.length}`;
    }

    if (assignee) {
      if (isUUID(assignee as string)) {
        params.push(assignee);
        whereClause += ` AND i.assignee_id = $${params.length}`;
      } else {
        switch ((assignee as string).toLowerCase()) {
          case "assigned":
            whereClause += ` AND i.assignee_id IS NOT NULL AND i.status != 'Unassigned'`;
            break;
          case "unassigned":
            whereClause += ` AND (i.assignee_id IS NULL OR i.status = 'Unassigned')`;
            break;
          case "review":
            whereClause += ` AND i.status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')`;
            break;
        }
      }
    }

    if (assignmentType) {
      params.push(assignmentType);
      whereClause += ` AND i.assignee_model = $${params.length}`;
    }

    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} ${whereClause} ORDER BY i.created_at DESC`,
      params
    );

    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

/* ─── 3. GET INDICATOR BY ID ──────────────────────────────────────────────── */

export const getIndicatorById = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [id]
    );
    if (!rows[0]) throw new AppError("Indicator not found.", 404);

    const indicator = rows[0];

    // Verified columns against submissions schema:
    // id, indicator_id, quarter, year, achieved_value, notes,
    // admin_description_edit, admin_comment, submitted_at,
    // is_reviewed, review_status, resubmission_count
    const { rows: submissions } = await pool.query(
      `SELECT
         s.id,
         s.indicator_id           AS "indicatorId",
         s.quarter,
         s.year,
         s.notes,
         s.admin_description_edit AS "adminDescriptionEdit",
         s.submitted_at           AS "submittedAt",
         s.achieved_value         AS "achievedValue",
         s.is_reviewed            AS "isReviewed",
         s.review_status          AS "reviewStatus",
         s.admin_comment          AS "adminComment",
         s.resubmission_count     AS "resubmissionCount",

         COALESCE(
           json_agg(
             json_build_object(
               'id',               sd.id,
               'submissionId',     sd.submission_id,
               'evidenceUrl',      sd.evidence_url,
               'evidencePublicId', sd.evidence_public_id,
               'fileType',         sd.file_type,
               'fileName',         sd.file_name,
               'uploadedAt',       sd.uploaded_at
             )
           ) FILTER (WHERE sd.id IS NOT NULL),
           '[]'
         ) AS "documents"

       FROM submissions s
       LEFT JOIN submission_documents sd ON sd.submission_id = s.id
       WHERE s.indicator_id = $1
       GROUP BY s.id
       ORDER BY s.year ASC, s.quarter ASC`,
      [id]
    );

    // Verified columns against review_history schema:
    // id, indicator_id, action, reason, reviewer_role, reviewed_by, at, next_deadline
    const { rows: reviewHistory } = await pool.query(
      `SELECT
         rh.id,
         rh.indicator_id  AS "indicatorId",
         rh.action,
         rh.reason,
         rh.reviewer_role AS "reviewerRole",
         rh.reviewed_by   AS "reviewedBy",
         rh.at,
         rh.next_deadline AS "nextDeadline",
         u.name           AS "reviewedByName"
       FROM review_history rh
       LEFT JOIN users u ON rh.reviewed_by = u.id
       WHERE rh.indicator_id = $1
       ORDER BY rh.at DESC`,
      [id]
    );

    res.status(200).json({
      success: true,
      data: { ...indicator, submissions, reviewHistory },
    });
  }
);

/* ─── 4. UPDATE INDICATOR ─────────────────────────────────────────────────── */

export const updateIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { weight, target, deadline, instructions, reportingCycle } = req.body;

    const check = await pool.query(
      "SELECT status FROM indicators WHERE id = $1",
      [id]
    );
    if (!check.rows[0]) throw new AppError("Indicator not found.", 404);
    if (
      ["Awaiting Admin Approval", "Awaiting Super Admin"].includes(
        check.rows[0].status
      )
    ) {
      throw new AppError("Cannot edit while under review.", 400);
    }

    await pool.query(
      `UPDATE indicators SET
         weight          = COALESCE($1, weight),
         target          = COALESCE($2, target),
         deadline        = COALESCE($3, deadline),
         instructions    = COALESCE($4, instructions),
         reporting_cycle = COALESCE($5, reporting_cycle),
         status          = CASE WHEN $3 IS NOT NULL OR $2 IS NOT NULL THEN 'Pending' ELSE status END,
         updated_at      = NOW()
       WHERE id = $6`,
      [weight, target, deadline, instructions, reportingCycle, id]
    );

    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [id]
    );

    res.status(200).json({ success: true, data: rows[0] });
  }
);

/* ─── 5. DELETE INDICATOR ─────────────────────────────────────────────────── */

export const deleteIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const { rows } = await pool.query(
      "SELECT status FROM indicators WHERE id = $1",
      [id]
    );
    if (!rows[0]) throw new AppError("Indicator not found.", 404);
    if (rows[0].status === "Completed") {
      throw new AppError("Cannot delete completed task.", 400);
    }

    await pool.query("DELETE FROM indicators WHERE id = $1", [id]);
    res.status(200).json({ success: true, message: "Indicator removed." });
  }
);

/* ─── 6. GET REJECTED BY ADMIN ────────────────────────────────────────────── */

export const getRejectedByAdmin = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS}
       WHERE i.status = 'Rejected by Admin'
       ORDER BY i.updated_at DESC`
    );
    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

/* ─── 7. SUPER ADMIN FINAL REVIEW ─────────────────────────────────────────── */

export const superAdminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { decision, reason, progressOverride, nextDeadline } = req.body;
    const adminId  = (req as any).user.id;
    const isApprove = decision === "Approved";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [id]
      );
      const indicator = indRes.rows[0];

      if (!indicator || indicator.status !== "Awaiting Super Admin") {
        throw new AppError("Not in Super Admin review state.", 400);
      }

      const subStatus = isApprove ? "Accepted" : "Rejected";

      await client.query(
        `UPDATE submissions
         SET review_status = $1, is_reviewed = true, admin_comment = $2
         WHERE indicator_id = $3 AND quarter = $4`,
        [subStatus, reason || "", id, indicator.active_quarter]
      );

      let nextStatus: string;
      let nextQuarter = indicator.active_quarter;
      let newDeadline = indicator.deadline;

      if (isApprove) {
        if (
          indicator.reporting_cycle === "Quarterly" &&
          indicator.active_quarter < 4
        ) {
          nextStatus  = "Pending";
          nextQuarter = indicator.active_quarter + 1;
          if (nextDeadline) newDeadline = new Date(nextDeadline);
        } else {
          nextStatus = "Completed";
        }
      } else {
        nextStatus = "Rejected by Super Admin";
      }

      const achievedValue = progressOverride ?? indicator.current_total_achieved;

      await client.query(
        `UPDATE indicators
         SET status                 = $1,
             active_quarter         = $2,
             deadline               = $3,
             current_total_achieved = $4,
             updated_at             = NOW()
         WHERE id = $5`,
        [nextStatus, nextQuarter, newDeadline, achievedValue, id]
      );

      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by, next_deadline)
         VALUES ($1, $2, $3, 'superadmin', $4, $5)`,
        [id, isApprove ? "Approved" : "Rejected", reason, adminId, nextDeadline || null]
      );

      await client.query("COMMIT");

      const { rows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id]
      );

      res.status(200).json({ success: true, data: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

/* ─── 8. REOPEN INDICATOR ─────────────────────────────────────────────────── */

export const reopenIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { newDeadline, reason } = req.body;
    const adminId = (req as any).user.id;

    if (!newDeadline) {
      throw new AppError("A new deadline is required to reopen an indicator.", 400);
    }

    const parsedDeadline = new Date(newDeadline);
    if (isNaN(parsedDeadline.getTime())) {
      throw new AppError("Invalid deadline date.", 400);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [id]
      );
      const indicator = indRes.rows[0];

      if (!indicator) throw new AppError("Indicator not found.", 404);

      const reopenableStatuses = [
        "Pending",
        "Completed",
        "Rejected by Admin",
        "Rejected by Super Admin",
      ];

      if (!reopenableStatuses.includes(indicator.status)) {
        throw new AppError(
          `Indicator cannot be reopened from status "${indicator.status}". It may still be under active review.`,
          400
        );
      }

      // Audit trail before mutation
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by, at)
         VALUES ($1, 'Reopened', $2, 'admin', $3, NOW())`,
        [id, reason?.trim() || "Reopened by admin", adminId]
      );

      // Reset status and extend deadline.
      // active_quarter and progress are intentionally preserved —
      // previously accepted quarters remain certified.
      await client.query(
        `UPDATE indicators
         SET status     = 'Pending',
             deadline   = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [parsedDeadline, id]
      );

      await client.query("COMMIT");

      const { rows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id]
      );

      res.status(200).json({ success: true, data: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

/* ─── 9. GET ALL SUBMISSIONS ──────────────────────────────────────────────── */
export const getAllSubmissions = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT
        i.id,
        i.status,
        i.assignee_model             AS "assigneeType",
        i.active_quarter             AS "quarter",
        s.id                         AS "submissionId",
        s.year,                       -- ADD THIS LINE - missing year!
        s.submitted_at               AS "submittedOn",
        s.achieved_value             AS "achievedValue",
        s.notes,
        s.admin_description_edit     AS "adminDescriptionEdit",
        s.is_reviewed                AS "isReviewed",
        s.review_status              AS "reviewStatus",
        s.admin_comment              AS "adminComment",
        s.resubmission_count         AS "resubmissionCount",
        sa.description               AS "indicatorTitle",
        CASE
          WHEN i.assignee_model = 'User' THEN u.name
          ELSE t.name
        END                          AS "submittedBy",

        COALESCE(
          json_agg(
            json_build_object(
              'id',               sd.id,
              'evidenceUrl',      sd.evidence_url,
              'evidencePublicId', sd.evidence_public_id,
              'fileType',         sd.file_type,
              'fileName',         sd.file_name,
              'uploadedAt',       sd.uploaded_at
            )
          ) FILTER (WHERE sd.id IS NOT NULL),
          '[]'
        )                            AS "documents",
        COUNT(sd.id)                 AS "documentsCount"

      FROM submissions s
      JOIN    indicators i           ON s.indicator_id = i.id
      LEFT JOIN users u              ON i.assignee_id = u.id AND i.assignee_model = 'User'
      LEFT JOIN teams t              ON i.assignee_id = t.id AND i.assignee_model = 'Team'
      LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
      LEFT JOIN submission_documents sd ON sd.submission_id = s.id

      GROUP BY
        i.id, i.status, i.assignee_model, i.active_quarter,
        s.id, s.year, s.submitted_at, s.achieved_value, s.notes,  -- Add s.year here too
        s.admin_description_edit, s.is_reviewed, s.review_status,
        s.admin_comment, s.resubmission_count,
        sa.description, u.name, t.name

      ORDER BY s.submitted_at DESC
    `);

    const queue = rows.map((row) => ({
      ...row,
      quarter: row.quarter, // Keep as number, don't convert to string
      documentsCount: parseInt(row.documentsCount, 10),
    }));

    res.status(200).json({ success: true, count: queue.length, data: queue });
  }
);

/* ─── 10. SUPER ADMIN DASHBOARD STATS ────────────────────────────────────── */

export const getSuperAdminStats = asyncHandler(
  async (_req: Request, res: Response) => {
    const [totalRes, statusRes] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM indicators"),
      pool.query(
        "SELECT status, COUNT(*) AS count FROM indicators GROUP BY status"
      ),
    ]);

    const stats = statusRes.rows.reduce((acc: any, curr: any) => {
      acc[curr.status] = parseInt(curr.count, 10);
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: { total: parseInt(totalRes.rows[0].total, 10), stats },
    });
  }
);

/* ─── 11. UNASSIGN INDICATOR ─────────────────────────────────────────────── */

export const unassignIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT id FROM indicators WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (indRes.rowCount === 0) throw new AppError("Indicator not found.", 404);

      // Cascade: submission_documents removed via FK when submissions are deleted
      await client.query("DELETE FROM submissions WHERE indicator_id = $1", [id]);
      await client.query("DELETE FROM review_history WHERE indicator_id = $1", [id]);

      await client.query(
        `UPDATE indicators
         SET assignee_id            = NULL,
             assignee_model         = 'User',
             status                 = 'Pending',
             progress               = 0,
             current_total_achieved = 0,
             active_quarter         = 1,
             updated_at             = NOW()
         WHERE id = $1`,
        [id]
      );

      await client.query("COMMIT");

      const { rows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id]
      );

      res.status(200).json({ success: true, data: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

/* ─── 12. DELETE SUBMISSION ───────────────────────────────────────────────── */

export const deleteSubmission = asyncHandler(
  async (req: Request, res: Response) => {
    const { submissionId } = req.params;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const subRes = await client.query(
        `SELECT s.id, s.indicator_id, s.review_status
         FROM submissions s
         WHERE s.id = $1
         FOR UPDATE`,
        [submissionId]
      );

      if (subRes.rows.length === 0) {
        throw new AppError("Submission not found.", 404);
      }

      const submission = subRes.rows[0];

      if (submission.review_status === "Accepted") {
        throw new AppError("Cannot delete a certified submission.", 400);
      }

      // Pull Cloudinary public_ids before deletion
      const docsRes = await client.query(
        `SELECT evidence_public_id
         FROM submission_documents
         WHERE submission_id = $1`,
        [submissionId]
      );
      const publicIds: string[] = docsRes.rows
        .map((r: { evidence_public_id: string }) => r.evidence_public_id)
        .filter(Boolean);

      // FK cascade removes submission_documents when submission is deleted
      await client.query("DELETE FROM submissions WHERE id = $1", [submissionId]);

      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Submission Deleted', 'Deleted by admin', 'admin', $2)`,
        [submission.indicator_id, (req as any).user.id]
      );

      await client.query("COMMIT");

      // Cloudinary cleanup outside transaction — non-fatal if it fails
      if (publicIds.length > 0) {
        const { deleteFromCloudinary } = await import("../../config/cloudinary");
        publicIds.forEach((pid) =>
          deleteFromCloudinary(pid).catch((e) =>
            console.error("[deleteSubmission] Cloudinary cleanup failed:", e)
          )
        );
      }

      res.status(200).json({
        success: true,
        message: "Submission and associated documents removed.",
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

/* ─── 13. GET ASSIGNED INDICATORS ────────────────────────────────────────── */

export const getAssignedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS}
       WHERE i.assignee_id IS NOT NULL
         AND i.status NOT IN (
           'Awaiting Admin Approval',
           'Awaiting Super Admin',
           'Rejected by Admin',
           'Rejected by Super Admin',
           'Completed'
         )
       ORDER BY i.created_at DESC`
    );

    const enrichedRows = rows.map((row) => ({
      ...row,
      needsAction: false,
      isOverdue: row.deadline ? new Date(row.deadline) < new Date() : false,
      completionPercentage: row.progress || 0,
    }));

    res.status(200).json({
      success: true,
      count: enrichedRows.length,
      data: enrichedRows,
    });
  }
);

/* ─── 14. GET UNASSIGNED INDICATORS ──────────────────────────────────────── */

export const getUnassignedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS}
       WHERE i.assignee_id IS NULL
         AND i.status = 'Pending'
       ORDER BY i.created_at DESC`
    );

    const enrichedRows = rows.map((row) => ({
      ...row,
      status: "Unassigned",
      needsAction: false,
      isOverdue: false,
      completionPercentage: 0,
    }));

    res.status(200).json({
      success: true,
      count: enrichedRows.length,
      data: enrichedRows,
    });
  }
);

/* ─── 15. GET REVIEW INDICATORS ──────────────────────────────────────────── */

/**
 * Previously this ran an extra COUNT query per indicator (N+1).
 * Now needsAction is computed entirely in SQL using a LEFT JOIN
 * with a pre-aggregated subquery — one round-trip regardless of row count.
 */
export const getReviewIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT},
         -- Pending submission count resolved in a single join, not per-row queries
         COALESCE(ps.pending_count, 0) AS "pendingSubmissionCount"

       ${INDICATOR_JOINS}

       -- Pre-aggregate pending submissions for all relevant indicators
       LEFT JOIN (
         SELECT indicator_id, COUNT(*) AS pending_count
         FROM submissions
         WHERE review_status = 'Pending'
           AND is_reviewed = false
         GROUP BY indicator_id
       ) ps ON ps.indicator_id = i.id

       WHERE i.status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')
          OR ps.pending_count > 0

       ORDER BY i.updated_at DESC`
    );

    const enrichedRows = rows.map((row) => ({
      ...row,
      needsAction:
        row.pendingSubmissionCount > 0 ||
        row.status === "Awaiting Admin Approval" ||
        row.status === "Awaiting Super Admin",
      isOverdue: row.deadline ? new Date(row.deadline) < new Date() : false,
      completionPercentage: row.progress || 0,
    }));

    res.status(200).json({
      success: true,
      count: enrichedRows.length,
      data: enrichedRows,
    });
  }
);