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

    i.assignee_id        AS "assigneeId",
    i.assignee_model     AS "assignmentType",
    i.assigned_by        AS "assignedBy",
    i.strategic_plan_id  AS "strategicPlanId",
    i.objective_id       AS "objectiveId",
    i.activity_id        AS "activityId",
    i.reporting_cycle    AS "reportingCycle",
    i.active_quarter     AS "activeQuarter",
    i.current_total_achieved AS "currentTotalAchieved",
    i.created_at         AS "createdAt",
    i.updated_at         AS "updatedAt",

    sp.perspective,

    -- Resolved display name (works for both User and Team assignments)
    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE t.name
    END AS "assigneeDisplayName",

    -- Extra detail fields used by Reports and Modal
    ab.name              AS "assignedByName",
    so.title             AS "objectiveTitle",
    sa.description       AS "activityDescription",
    u.pj_number          AS "assigneePjNumber"
`;

const INDICATOR_JOINS = `
  FROM indicators i
  LEFT JOIN users u  ON i.assignee_id = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t  ON i.assignee_id = t.id AND i.assignee_model = 'Team'
  LEFT JOIN users ab ON i.assigned_by = ab.id
  LEFT JOIN strategic_plans     sp ON i.strategic_plan_id = sp.id
  LEFT JOIN strategic_objectives so ON i.objective_id = so.id
  LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
`;

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */

async function resolveRecipients(assigneeId: string, type: "User" | "Team") {
  if (type === "User") {
    const { rows } = await pool.query(
      "SELECT name, email FROM users WHERE id = $1",
      [assigneeId],
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
     JOIN teams t ON tm.team_id = t.id
     WHERE t.id = $1 AND u.is_active = true`,
    [assigneeId],
  );
  return {
    emails: rows.map((r) => r.email),
    displayName: rows[0]?.team_name || "Unknown Team",
  };
}

const isUUID = (val: any): boolean =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

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
        throw new AppError(
          `Invalid value for "${field}": expected a UUID, got ${JSON.stringify(value) ?? "undefined"}.`,
          400,
        );
      }
    }

    const parsedDeadline = new Date(deadline);
    if (isNaN(parsedDeadline.getTime()))
      throw new AppError("Invalid deadline date.", 400);
    if (parsedDeadline < new Date())
      throw new AppError("Deadline cannot be in the past.", 400);

    const type = assignmentType === "Team" ? "Team" : "User";

    const insertQuery = `
    INSERT INTO indicators (
      strategic_plan_id, objective_id, activity_id, assignee_id, assignee_model,
      reporting_cycle, weight, unit, target, deadline, instructions,
      active_quarter, assigned_by, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending')
    RETURNING id
  `;

    const { rows: inserted } = await pool.query(insertQuery, [
      strategicPlanId,
      objectiveId,
      activityId,
      assignee,
      type,
      reportingCycle || "Quarterly",
      weight ?? 5,
      unit || "%",
      target ?? 100,
      parsedDeadline,
      instructions || "",
      activeQuarter || 1,
      adminId,
    ]);

    // Return the full camelCase shape using the shared fragment
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [inserted[0].id],
    );

    // Non-blocking email notifications
    resolveRecipients(assignee, type).then(({ emails, displayName }) => {
      emails.forEach((email) =>
        sendMail({
          to: email,
          subject: "New Task Assigned",
          html: taskAssignedTemplate(
            displayName,
            instructions || "—",
            activeQuarter || 1,
            new Date().getFullYear(),
            parsedDeadline.toDateString(),
          ),
        }),
      );
    });

    res.status(201).json({ success: true, data: rows[0] });
  },
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
      params.push(assignee);
      whereClause += ` AND i.assignee_id = $${params.length}`;
    }
    if (assignmentType) {
      params.push(assignmentType);
      whereClause += ` AND i.assignee_model = $${params.length}`;
    }

    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} ${whereClause} ORDER BY i.created_at DESC`,
      params,
    );

    res.status(200).json({ success: true, count: rows.length, data: rows });
  },
);

export const getIndicatorById = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    // 1. Fetch the indicator using the shared camelCase fragment
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [id],
    );
    if (!rows[0]) throw new AppError("Indicator not found.", 404);

    const indicator = rows[0];

    // 2. Fetch submissions with their documents aggregated
    const { rows: submissions } = await pool.query(
      `
      SELECT
        s.id,
        s.indicator_id          AS "indicatorId",
        s.quarter,
        s.notes,
        s.admin_description_edit AS "adminDescriptionEdit",
        s.submitted_at          AS "submittedAt",
        s.achieved_value        AS "achievedValue",
        s.is_reviewed           AS "isReviewed",
        s.review_status         AS "reviewStatus",
        s.admin_comment         AS "adminComment",
        s.resubmission_count    AS "resubmissionCount",

        -- ✅ Documents nested inside each submission
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
        )                       AS "documents"

      FROM submissions s
      LEFT JOIN submission_documents sd ON sd.submission_id = s.id
      WHERE s.indicator_id = $1
      GROUP BY s.id
      ORDER BY s.quarter ASC
      `,
      [id],
    );

    // 3. Fetch review history
    const { rows: reviewHistory } = await pool.query(
      `
      SELECT
        rh.id,
        rh.indicator_id   AS "indicatorId",
        rh.action,
        rh.reason,
        rh.reviewer_role  AS "reviewerRole",
        rh.reviewed_by    AS "reviewedBy",
        rh.at,
        rh.next_deadline  AS "nextDeadline",
        u.name            AS "reviewedByName"
      FROM review_history rh
      LEFT JOIN users u ON rh.reviewed_by = u.id
      WHERE rh.indicator_id = $1
      ORDER BY rh.at DESC
      `,
      [id],
    );

    res.status(200).json({
      success: true,
      data: {
        ...indicator,
        submissions,
        reviewHistory,
      },
    });
  },
);

/* ─── 4. UPDATE INDICATOR ─────────────────────────────────────────────────── */
export const updateIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { weight, target, deadline, instructions, reportingCycle } = req.body;

    const check = await pool.query(
      "SELECT status FROM indicators WHERE id = $1",
      [id],
    );
    if (!check.rows[0]) throw new AppError("Indicator not found.", 404);
    if (
      ["Awaiting Admin Approval", "Awaiting Super Admin"].includes(
        check.rows[0].status,
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
      [weight, target, deadline, instructions, reportingCycle, id],
    );

    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [id],
    );

    res.status(200).json({ success: true, data: rows[0] });
  },
);

/* ─── 5. DELETE INDICATOR ─────────────────────────────────────────────────── */
export const deleteIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      "SELECT status FROM indicators WHERE id = $1",
      [id],
    );
    if (!rows[0]) throw new AppError("Indicator not found.", 404);
    if (rows[0].status === "Completed")
      throw new AppError("Cannot delete completed task.", 400);

    await pool.query("DELETE FROM indicators WHERE id = $1", [id]);
    res.status(200).json({ success: true, message: "Indicator removed." });
  },
);

/* ─── 6. GET REJECTED BY ADMIN ────────────────────────────────────────────── */
export const getRejectedByAdmin = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS}
     WHERE i.status = 'Rejected by Admin'
     ORDER BY i.updated_at DESC`,
    );
    res.status(200).json({ success: true, count: rows.length, data: rows });
  },
);

/* ─── 7. SUPER ADMIN FINAL REVIEW ─────────────────────────────────────────── */
export const superAdminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { decision, reason, progressOverride, nextDeadline } = req.body;
    const adminId = (req as any).user.id;
    const isApprove = decision === "Approved";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1",
        [id],
      );
      const indicator = indRes.rows[0];

      if (!indicator || indicator.status !== "Awaiting Super Admin") {
        throw new AppError("Not in Super Admin review state.", 400);
      }

      const subStatus = isApprove ? "Accepted" : "Rejected";

      // Update the submission for the active quarter
      await client.query(
        `UPDATE submissions
       SET review_status = $1, is_reviewed = true, admin_comment = $2
       WHERE indicator_id = $3 AND quarter = $4`,
        [subStatus, reason || "", id, indicator.active_quarter],
      );

      // Determine next indicator status
      let nextStatus: string;
      let nextQuarter = indicator.active_quarter;
      let newDeadline = indicator.deadline;

      if (isApprove) {
        if (
          indicator.reporting_cycle === "Quarterly" &&
          indicator.active_quarter < 4
        ) {
          nextStatus = "Pending";
          nextQuarter = indicator.active_quarter + 1;
          if (nextDeadline) newDeadline = new Date(nextDeadline);
        } else {
          nextStatus = "Completed";
        }
      } else {
        nextStatus = "Rejected by Super Admin";
      }

      // Apply progress override if provided
      const achievedValue =
        progressOverride ?? indicator.current_total_achieved;

      await client.query(
        `UPDATE indicators
       SET status                = $1,
           active_quarter        = $2,
           deadline              = $3,
           current_total_achieved = $4,
           updated_at            = NOW()
       WHERE id = $5`,
        [nextStatus, nextQuarter, newDeadline, achievedValue, id],
      );

      await client.query(
        `INSERT INTO review_history
         (indicator_id, action, reason, reviewer_role, reviewed_by, next_deadline)
       VALUES ($1, $2, $3, 'superadmin', $4, $5)`,
        [
          id,
          isApprove ? "Approved" : "Rejected",
          reason,
          adminId,
          nextDeadline || null,
        ],
      );

      await client.query("COMMIT");

      // Return the full updated indicator in camelCase shape
      const { rows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id],
      );

      res.status(200).json({ success: true, data: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
);

export const getAllSubmissions = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT
        i.id,
        i.status,
        i.assignee_model                  AS "assigneeType",
        i.active_quarter                  AS "quarter",
        s.id                              AS "submissionId",
        s.submitted_at                    AS "submittedOn",
        s.achieved_value                  AS "achievedValue",
        s.notes,
        s.admin_description_edit          AS "adminDescriptionEdit",
        s.is_reviewed                     AS "isReviewed",
        s.review_status                   AS "reviewStatus",
        s.admin_comment                   AS "adminComment",
        s.resubmission_count              AS "resubmissionCount",
        sa.description                    AS "indicatorTitle",
        CASE
          WHEN i.assignee_model = 'User' THEN u.name
          ELSE t.name
        END                               AS "submittedBy",

        -- ✅ Aggregate documents into a JSON array
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
        )                                 AS "documents",
        COUNT(sd.id)                      AS "documentsCount"

      FROM submissions s
      JOIN    indicators i          ON s.indicator_id = i.id
      LEFT JOIN users u             ON i.assignee_id = u.id  AND i.assignee_model = 'User'
      LEFT JOIN teams t             ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
      LEFT JOIN strategic_activities sa ON i.activity_id = sa.id

      -- ✅ Join documents here
      LEFT JOIN submission_documents sd ON sd.submission_id = s.id

      GROUP BY
        i.id, i.status, i.assignee_model, i.active_quarter,
        s.id, s.submitted_at, s.achieved_value, s.notes,
        s.admin_description_edit, s.is_reviewed, s.review_status,
        s.admin_comment, s.resubmission_count,
        sa.description, u.name, t.name

      ORDER BY s.submitted_at DESC
    `);

    const queue = rows.map((row) => ({
      ...row,
      quarter:       `Q${row.quarter}`,
      documentsCount: parseInt(row.documentsCount),
    }));

    res.status(200).json({ success: true, count: queue.length, data: queue });
  },
);

/* ─── 9. SUPER ADMIN DASHBOARD STATS ─────────────────────────────────────── */
export const getSuperAdminStats = asyncHandler(
  async (_req: Request, res: Response) => {
    const [totalRes, statusRes] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM indicators"),
      pool.query(
        "SELECT status, COUNT(*) AS count FROM indicators GROUP BY status",
      ),
    ]);

    const stats = statusRes.rows.reduce((acc: any, curr: any) => {
      acc[curr.status] = parseInt(curr.count);
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: { total: parseInt(totalRes.rows[0].total), stats },
    });
  },
);

/*====10. SUPER ADMIN UNASSIGN ACTIVITIES */
export const unassignIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    // 1. Update the indicator to nullify assignee fields
    const result = await pool.query(
      `UPDATE indicators 
       SET assignee_id = NULL, 
           assignee_model = NULL, 
           status = 'Pending',
           updated_at = NOW()
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    if (result.rowCount === 0) throw new AppError("Indicator not found.", 404);

    res.status(200).json({ 
      success: true, 
      message: "Activity unassigned successfully." 
    });
  }
);