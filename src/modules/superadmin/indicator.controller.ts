import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { sendMail } from "../../utils/sendMail";
import { 
  superAdminApprovedTemplate, 
  superAdminRejectedTemplate, 
  taskAssignedTemplate,
  partialApprovalTemplate
} from "../../utils/mailTemplates";

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

    i.assignee_id            AS "assignee",
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
    i.is_multi_assignee      AS "isMultiAssignee",

    sp.perspective,

    -- Primary assignee display name
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

async function resolveMultipleRecipients(
  assigneeIds: string[]
): Promise<{ emails: string[]; displayNames: string[] }> {
  if (assigneeIds.length === 0) {
    return { emails: [], displayNames: [] };
  }

  const { rows } = await pool.query(
    `SELECT id, name, email FROM users WHERE id = ANY($1) AND is_active = true`,
    [assigneeIds]
  );

  return {
    emails: rows.map((r: { email: string }) => r.email),
    displayNames: rows.map((r: { name: string }) => r.name),
  };
}

async function getCurrentQuarter(indicatorId: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT active_quarter FROM indicators WHERE id = $1",
    [indicatorId]
  );
  return rows[0]?.active_quarter || 1;
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
      additionalAssignees = [], // NEW: Array of additional user IDs for multi-assignee
    } = req.body;

    const adminId = (req as any).user?.id;

    // Validate required fields
    if (!strategicPlanId || !objectiveId || !activityId) {
      throw new AppError("Strategic Plan, Objective, and Activity are required.", 400);
    }

    // ✅ CHECK IF INDICATOR ALREADY EXISTS FOR THIS ACTIVITY
    const existingIndicator = await pool.query(
      `SELECT id, assignee_id, status, is_multi_assignee FROM indicators WHERE activity_id = $1 AND deleted_at IS NULL`,
      [activityId]
    );

    if (existingIndicator.rows.length > 0) {
      const existing = existingIndicator.rows[0];
      
      // Update the existing indicator
      await pool.query(
        `UPDATE indicators
         SET strategic_plan_id = COALESCE($1, strategic_plan_id),
             objective_id = COALESCE($2, objective_id),
             reporting_cycle = COALESCE($3, reporting_cycle),
             weight = COALESCE($4, weight),
             unit = COALESCE($5, unit),
             target = COALESCE($6, target),
             deadline = COALESCE($7, deadline),
             instructions = COALESCE($8, instructions),
             active_quarter = COALESCE($9, active_quarter),
             assignee_id = COALESCE($10, assignee_id),
             assignee_model = COALESCE($11, assignee_model),
             assigned_by = COALESCE($12, assigned_by),
             is_multi_assignee = COALESCE($13, is_multi_assignee),
             updated_at = NOW()
         WHERE id = $14
         RETURNING id`,
        [
          strategicPlanId,
          objectiveId,
          reportingCycle,
          weight ?? 5,
          unit || "%",
          target ?? 100,
          deadline ? new Date(deadline) : null,
          instructions || "",
          activeQuarter || 1,
          assignee && assignee !== "unassigned" ? assignee : null,
          assignmentType === "Team" ? "Team" : "User",
          adminId,
          additionalAssignees.length > 0, // is_multi_assignee
          existing.id
        ]
      );

      // Handle multi-assignee updates
      if (additionalAssignees.length > 0) {
        // Clear existing additional assignees
        await pool.query(
          "DELETE FROM indicator_assignees WHERE indicator_id = $1 AND is_primary = false",
          [existing.id]
        );
        
        // Add new additional assignees
        for (const userId of additionalAssignees) {
          await pool.query(
            `INSERT INTO indicator_assignees (indicator_id, user_id, is_primary)
             VALUES ($1, $2, false)
             ON CONFLICT (indicator_id, user_id) DO NOTHING`,
            [existing.id, userId]
          );
        }
      }

      // Fetch and return the updated indicator
      const { rows: updatedRows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [existing.id]
      );

      // Get all assignees for the response
      const allAssignees = await getIndicatorAssignees(existing.id);

      res.status(200).json({
        success: true,
        message: "Indicator already existed and has been updated.",
        data: { ...updatedRows[0], allAssignees }
      });
      return;
    }

    // ✅ No existing indicator - create new one
    const isMultiAssignee = additionalAssignees.length > 0;
    const primaryAssignee = assignee && assignee !== "unassigned" ? assignee : null;
    const assigneeModel = assignmentType === "Team" ? "Team" : "User";

    const { rows: newRows } = await pool.query(
      `INSERT INTO indicators (
         strategic_plan_id,
         objective_id,
         activity_id,
         reporting_cycle,
         weight,
         unit,
         target,
         deadline,
         instructions,
         active_quarter,
         assignee_id,
         assignee_model,
         assigned_by,
         status,
         progress,
         current_total_achieved,
         is_multi_assignee
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, 0, $15
       )
       RETURNING id`,
      [
        strategicPlanId,
        objectiveId,
        activityId,
        reportingCycle || "Quarterly",
        weight ?? 5,
        unit || "%",
        target ?? 100,
        deadline ? new Date(deadline) : null,
        instructions || "",
        activeQuarter || 1,
        primaryAssignee,
        assigneeModel,
        adminId,
        primaryAssignee ? "Pending" : "Pending",
        isMultiAssignee
      ]
    );

    const indicatorId = newRows[0].id;

    // Add additional assignees if multi-assignee
    if (isMultiAssignee && primaryAssignee) {
      // Add primary as first assignee
      await pool.query(
        `INSERT INTO indicator_assignees (indicator_id, user_id, is_primary)
         VALUES ($1, $2, true)`,
        [indicatorId, primaryAssignee]
      );

      // Add additional assignees
      for (const userId of additionalAssignees) {
        if (userId !== primaryAssignee) {
          await pool.query(
            `INSERT INTO indicator_assignees (indicator_id, user_id, is_primary)
             VALUES ($1, $2, false)
             ON CONFLICT (indicator_id, user_id) DO NOTHING`,
            [indicatorId, userId]
          );
        }
      }
    }

    const { rows: createdRows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [indicatorId]
    );

    // Get all assignees for the response
    const allAssignees = await getIndicatorAssignees(indicatorId);

    res.status(201).json({
      success: true,
      message: "Indicator created successfully.",
      data: { ...createdRows[0], allAssignees },
    });
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

    // Enrich with all assignees for multi-assignee indicators
    for (const row of rows) {
      if (row.isMultiAssignee) {
        row.allAssignees = await getIndicatorAssignees(row.id);
      }
    }

    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

/* ─── 3. GET INDICATOR BY ID (with latest submissions per period) ─────────── */

export const getIndicatorById = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [id]
    );
    if (!rows[0]) throw new AppError("Indicator not found.", 404);

    const indicator = rows[0];

    // Get all assignees if multi-assignee
    if (indicator.isMultiAssignee) {
      indicator.allAssignees = await getIndicatorAssignees(id);
    }

    const { rows: submissions } = await pool.query(
      `WITH latest_submissions AS (
         SELECT *,
           ROW_NUMBER() OVER (PARTITION BY quarter, year ORDER BY submitted_at DESC) as rn
         FROM submissions
         WHERE indicator_id = $1
       )
       SELECT
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
         s.submitted_by           AS "submittedBy",
         COALESCE(
           json_agg(
             json_build_object(
               'id',               sd.id,
               'submissionId',     sd.submission_id,
               'evidenceUrl',      sd.evidence_url,
               'evidencePublicId', sd.evidence_public_id,
               'fileType',         sd.file_type,
               'fileName',         sd.file_name,
               'description',      sd.description,
               'status',           sd.status,
               'rejectionReason',  sd.rejection_reason,
               'uploadedAt',       sd.uploaded_at
             )
           ) FILTER (WHERE sd.id IS NOT NULL),
           '[]'::json
         ) AS "documents"
       FROM latest_submissions s
       LEFT JOIN submission_documents sd ON sd.submission_id = s.id
       WHERE s.rn = 1
       GROUP BY
         s.id, s.indicator_id, s.quarter, s.year, s.notes,
         s.admin_description_edit, s.submitted_at, s.achieved_value,
         s.is_reviewed, s.review_status, s.admin_comment, s.resubmission_count,
         s.submitted_by
       ORDER BY s.year ASC, s.quarter ASC`,
      [id]
    );

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
         u.name           AS "reviewedByName",
         rh.approved_amount AS "approvedAmount"
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const check = await client.query(
        "SELECT status, reporting_cycle FROM indicators WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!check.rows[0]) throw new AppError("Indicator not found.", 404);

      const cycleChanged =
        reportingCycle && reportingCycle !== check.rows[0].reporting_cycle;

      let newActiveQuarter: number | null = null;
      if (cycleChanged) {
        newActiveQuarter = 1;
      }

      await client.query(
        `UPDATE indicators SET
           weight          = COALESCE($1, weight),
           target          = COALESCE($2, target),
           deadline        = COALESCE($3, deadline),
           instructions    = COALESCE($4, instructions),
           reporting_cycle = COALESCE($5, reporting_cycle),
           active_quarter  = COALESCE($6, active_quarter),
           progress               = CASE WHEN $7 THEN 0 ELSE progress END,
           current_total_achieved = CASE WHEN $7 THEN 0 ELSE current_total_achieved END,
           status = CASE
             WHEN $7                                                THEN 'Pending'
             WHEN $3 IS NOT NULL                                    THEN 'Pending'
             WHEN $2 IS NOT NULL                                    THEN 'Pending'
             WHEN $5 IS NOT NULL AND $5 IS DISTINCT FROM reporting_cycle THEN 'Pending'
             ELSE status
           END,
           updated_at = NOW()
         WHERE id = $8`,
        [
          weight,
          target,
          deadline,
          instructions,
          reportingCycle,
          newActiveQuarter,
          cycleChanged,
          id,
        ]
      );

      await client.query("COMMIT");

      const { rows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id]
      );

      // Get all assignees if multi-assignee
      if (rows[0]?.isMultiAssignee) {
        rows[0].allAssignees = await getIndicatorAssignees(id);
      }

      res.status(200).json({ success: true, data: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
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

    // Clean up indicator_assignees
    await pool.query("DELETE FROM indicator_assignees WHERE indicator_id = $1", [id]);
    await pool.query("DELETE FROM indicators WHERE id = $1", [id]);
    
    res.status(200).json({ success: true, message: "Indicator removed." });
  }
);

/* ─── 6. GET REJECTED BY ADMIN ────────────────────────────────────────────── */

export const getRejectedByAdmin = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS}
       WHERE EXISTS (
         SELECT 1 FROM review_history rh
         WHERE rh.indicator_id = i.id
           AND rh.action IN ('Correction Requested', 'Rejected')
       )
       ORDER BY i.updated_at DESC`
    );
    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

/* ─── 7. SUPER ADMIN FINAL REVIEW (WITH PARTIAL APPROVAL SUPPORT) ─────────── */

export const superAdminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { 
      decision, 
      reason, 
      progressOverride, 
      year, 
      quarter,
      isPartialApproval = false
    } = req.body;
    
    const adminId = (req as any).user.id;
    const isApprove = decision === "Approved";

    if (isApprove && (progressOverride === undefined || progressOverride === null)) {
      throw new AppError("Achieved value (progressOverride) is required when approving.", 400);
    }

    if (isApprove && (progressOverride < 0 || progressOverride > 100)) {
      throw new AppError("Progress must be between 0 and 100.", 400);
    }

    const targetYear = year || new Date().getFullYear();
    const targetQuarter = quarter !== undefined ? quarter : await getCurrentQuarter(id);

    const client = await pool.connect();
    let assigneeInfo: { emails: string[]; displayName: string } | null = null;
    let multiAssigneeInfo: { emails: string[]; displayNames: string[] } | null = null;

    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [id]
      );
      const indicator = indRes.rows[0];

      if (!indicator) throw new AppError("Indicator not found.", 404);
      
      if (indicator.status === "Completed") {
        throw new AppError("This indicator has already been completed.", 400);
      }

      const subRes = await client.query(
        `SELECT id, year, achieved_value, submitted_at, review_status
         FROM submissions
         WHERE indicator_id = $1 AND quarter = $2 AND year = $3
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [id, targetQuarter, targetYear]
      );

      if (subRes.rows.length === 0) {
        throw new AppError(
          `No submission found for ${targetQuarter === 0 ? "Annual" : `Q${targetQuarter}`} ${targetYear}.`,
          404
        );
      }

      const submission = subRes.rows[0];
      
      if (submission.review_status === "Accepted" && !isPartialApproval) {
        throw new AppError("This submission has already been approved.", 400);
      }

      // Get assignee information
      if (indicator.is_multi_assignee) {
        const assignees = await getIndicatorAssignees(id);
        const userIds = assignees.map((a: any) => a.userId);
        multiAssigneeInfo = await resolveMultipleRecipients(userIds);
      } else {
        const { emails, displayName } = await resolveRecipients(
          indicator.assignee_id,
          indicator.assignee_model
        );
        assigneeInfo = { emails, displayName };
      }

      // Calculate new totals
      const currentTotal = indicator.current_total_achieved || 0;
      let newTotal: number;
      let newProgress: number;
      let newStatus: string;
      let approvalMessage = "";

      if (isApprove) {
        const approvedAmount = Number(progressOverride);
        
        if (isPartialApproval) {
          newTotal = currentTotal + approvedAmount;
          newProgress = indicator.target > 0 
            ? Math.min(Math.round((newTotal / indicator.target) * 100), 100)
            : 0;
          
          if (newProgress >= 100) {
            newStatus = "Completed";
            approvalMessage = `Final approval completed. Total progress: 100%`;
          } else {
            newStatus = "Awaiting Super Admin";
            approvalMessage = `Partially approved: +${approvedAmount}%. Current total: ${newProgress}%. Remaining: ${100 - newProgress}%`;
          }
          
          await client.query(
            `UPDATE submissions
             SET review_status = 'Partially Approved', 
                 is_reviewed = true, 
                 admin_comment = $1,
                 approved_amount = $2,
                 reviewed_at = NOW()
             WHERE indicator_id = $3 AND quarter = $4 AND year = $5`,
            [approvalMessage, approvedAmount, id, targetQuarter, targetYear]
          );
        } else {
          if (currentTotal > 0 && currentTotal < indicator.target) {
            const remainingNeeded = indicator.target - currentTotal;
            if (approvedAmount !== remainingNeeded) {
              throw new AppError(
                `You have ${currentTotal}% already approved. You need to approve ${remainingNeeded}% to reach 100%.`,
                400
              );
            }
            newTotal = indicator.target;
            newProgress = 100;
          } else {
            newTotal = approvedAmount;
            newProgress = indicator.target > 0 
              ? Math.min(Math.round((newTotal / indicator.target) * 100), 100)
              : 0;
          }
          
          newStatus = "Completed";
          approvalMessage = `Fully approved: ${newProgress}% complete`;
          
          await client.query(
            `UPDATE submissions
             SET review_status = 'Accepted', 
                 is_reviewed = true, 
                 admin_comment = $1,
                 approved_amount = $2,
                 reviewed_at = NOW()
             WHERE indicator_id = $3 AND quarter = $4 AND year = $5`,
            [reason || approvalMessage, newTotal - currentTotal, id, targetQuarter, targetYear]
          );
        }
        
        await client.query(
          `UPDATE indicators
           SET status = $1,
               progress = $2,
               current_total_achieved = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [newStatus, newProgress, newTotal, id]
        );
        
        await client.query(
          `INSERT INTO review_history
             (indicator_id, action, reason, reviewer_role, reviewed_by, quarter, year, approved_amount, is_partial)
           VALUES ($1, $2, $3, 'superadmin', $4, $5, $6, $7, $8)`,
          [
            id, 
            isPartialApproval ? "Partially Approved" : "Approved", 
            reason || approvalMessage, 
            adminId, 
            targetQuarter, 
            targetYear,
            progressOverride,
            isPartialApproval
          ]
        );
        
      } else {
        newStatus = "Rejected by Super Admin";
        
        await client.query(
          `UPDATE submissions
           SET review_status = 'Rejected', 
               is_reviewed = true, 
               admin_comment = $1,
               reviewed_at = NOW()
           WHERE indicator_id = $2 AND quarter = $3 AND year = $4`,
          [reason || "No specific reason provided", id, targetQuarter, targetYear]
        );
        
        await client.query(
          `UPDATE indicators
           SET status = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [newStatus, id]
        );
        
        await client.query(
          `INSERT INTO review_history
             (indicator_id, action, reason, reviewer_role, reviewed_by, quarter, year)
           VALUES ($1, $2, $3, 'superadmin', $4, $5, $6)`,
          [id, "Rejected", reason || "Submission rejected", adminId, targetQuarter, targetYear]
        );
      }

      await client.query("COMMIT");

      const { rows: updatedRows } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id]
      );

      // Send email notifications
      const activityRes = await pool.query(
        `SELECT sa.description AS "activityDescription"
         FROM strategic_activities sa
         WHERE sa.id = $1`,
        [indicator.activity_id]
      );
      const activityDescription = activityRes.rows[0]?.activityDescription || "Performance Indicator";
      
      const periodYear = targetYear;
      const periodLabel = targetQuarter === 0 ? "Annual" : `Q${targetQuarter}`;

      // Send emails based on assignee type
      if (indicator.is_multi_assignee && multiAssigneeInfo) {
        const emailPromises = multiAssigneeInfo.emails.map((email, index) => {
          const displayName = multiAssigneeInfo!.displayNames[index] || "Team Member";
          let html: string;
          
          if (isApprove) {
            if (isPartialApproval) {
              html = partialApprovalTemplate(
                displayName,
                activityDescription,
                indicator.reporting_cycle,
                targetQuarter,
                periodYear,
                progressOverride,
                newProgress,
                indicator.target,
                indicator.unit || "%"
              );
            } else {
              html = superAdminApprovedTemplate(
                displayName,
                activityDescription,
                indicator.reporting_cycle,
                targetQuarter,
                periodYear,
                newProgress,
                indicator.unit || "%"
              );
            }
          } else {
            html = superAdminRejectedTemplate(
              displayName,
              activityDescription,
              indicator.reporting_cycle,
              targetQuarter,
              periodYear,
              reason || "No reason provided"
            );
          }
          
          return sendMail({
            to: email,
            subject: isApprove 
              ? (isPartialApproval ? "📈 Progress Partially Approved" : "✅ Performance Indicator Certified")
              : "❌ Performance Indicator Returned by Super Admin",
            html,
          }).catch((err) =>
            console.error(`[superAdminReview] Failed to send email to ${email}:`, err)
          );
        });
        await Promise.all(emailPromises);
      } else if (assigneeInfo && assigneeInfo.emails.length > 0) {
        const emailPromises = assigneeInfo.emails.map((email) => {
          let html: string;
          
          if (isApprove) {
            if (isPartialApproval) {
              html = partialApprovalTemplate(
                assigneeInfo!.displayName,
                activityDescription,
                indicator.reporting_cycle,
                targetQuarter,
                periodYear,
                progressOverride,
                newProgress,
                indicator.target,
                indicator.unit || "%"
              );
            } else {
              html = superAdminApprovedTemplate(
                assigneeInfo!.displayName,
                activityDescription,
                indicator.reporting_cycle,
                targetQuarter,
                periodYear,
                newProgress,
                indicator.unit || "%"
              );
            }
          } else {
            html = superAdminRejectedTemplate(
              assigneeInfo!.displayName,
              activityDescription,
              indicator.reporting_cycle,
              targetQuarter,
              periodYear,
              reason || "No reason provided"
            );
          }
          
          return sendMail({
            to: email,
            subject: isApprove 
              ? (isPartialApproval ? "📈 Progress Partially Approved" : "✅ Performance Indicator Certified")
              : "❌ Performance Indicator Returned by Super Admin",
            html,
          }).catch((err) =>
            console.error(`[superAdminReview] Failed to send email to ${email}:`, err)
          );
        });
        await Promise.all(emailPromises);
      }

      res.status(200).json({ 
        success: true, 
        data: updatedRows[0],
        message: isApprove 
          ? (isPartialApproval ? `Partially approved: +${progressOverride}%` : "Fully approved and completed")
          : "Submission rejected"
      });
      
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

/* ─── 8. GET PARTIAL APPROVALS HISTORY ────────────────────────────────────── */

export const getPartialApprovalsHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    
    const { rows } = await pool.query(
      `SELECT 
         rh.id,
         rh.action,
         rh.reason,
         rh.approved_amount AS "approvedAmount",
         rh.quarter,
         rh.year,
         rh.at AS "approvedAt",
         rh.is_partial AS "isPartial",
         u.name AS "approvedBy"
       FROM review_history rh
       LEFT JOIN users u ON rh.reviewed_by = u.id
       WHERE rh.indicator_id = $1 
         AND rh.action IN ('Partially Approved', 'Approved')
       ORDER BY rh.at ASC`,
      [id]
    );
    
    res.status(200).json({ success: true, data: rows });
  }
);

/* ─── 9. REOPEN INDICATOR ─────────────────────────────────────────────────── */

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

      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by, at)
         VALUES ($1, 'Reopened', $2, 'admin', $3, NOW())`,
        [id, reason?.trim() || "Reopened by admin", adminId]
      );

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

      if (rows[0]?.isMultiAssignee) {
        rows[0].allAssignees = await getIndicatorAssignees(id);
      }

      res.status(200).json({ success: true, data: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

/* ─── 10. GET ALL SUBMISSIONS ─────────────────────────────────────────────── */

export const getAllSubmissions = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT
        i.id,
        i.status,
        i.assignee_model             AS "assigneeType",
        i.active_quarter             AS "quarter",
        s.id                         AS "submissionId",
        s.year,
        s.submitted_at               AS "submittedOn",
        s.achieved_value             AS "achievedValue",
        s.notes,
        s.admin_description_edit     AS "adminDescriptionEdit",
        s.is_reviewed                AS "isReviewed",
        s.review_status              AS "reviewStatus",
        s.admin_comment              AS "adminComment",
        s.resubmission_count         AS "resubmissionCount",
        s.submitted_by               AS "submittedBy",
        sa.description               AS "indicatorTitle",
        CASE
          WHEN i.assignee_model = 'User' THEN u.name
          ELSE t.name
        END                          AS "primaryAssignee",
        i.is_multi_assignee          AS "isMultiAssignee",

        COALESCE(
          json_agg(
            json_build_object(
              'id',               sd.id,
              'evidenceUrl',      sd.evidence_url,
              'evidencePublicId', sd.evidence_public_id,
              'fileType',         sd.file_type,
              'fileName',         sd.file_name,
              'description',      sd.description,
              'status',           sd.status,
              'rejectionReason',  sd.rejection_reason,
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
        i.id, i.status, i.assignee_model, i.active_quarter, i.is_multi_assignee,
        s.id, s.year, s.submitted_at, s.achieved_value, s.notes,
        s.admin_description_edit, s.is_reviewed, s.review_status,
        s.admin_comment, s.resubmission_count, s.submitted_by,
        sa.description, u.name, t.name

      ORDER BY s.submitted_at DESC
    `);

    const queue = rows.map((row) => ({
      ...row,
      quarter: row.quarter,
      documentsCount: parseInt(row.documentsCount, 10),
    }));

    res.status(200).json({ success: true, count: queue.length, data: queue });
  }
);

/* ─── 11. SUPER ADMIN DASHBOARD STATS ─────────────────────────────────────── */

export const getSuperAdminStats = asyncHandler(
  async (_req: Request, res: Response) => {
    const query = `
      SELECT
        COUNT(*)                                                        AS total_indicators,
        COUNT(*) FILTER (WHERE assignee_id IS NOT NULL)                 AS assigned,
        COUNT(*) FILTER (WHERE assignee_id IS NULL)                     AS unassigned,
        COUNT(*) FILTER (
          WHERE deadline < NOW()
            AND status NOT IN ('Completed', 'Awaiting Admin Approval', 'Awaiting Super Admin')
        )                                                               AS overdue,
        COUNT(*) FILTER (
          WHERE status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')
        )                                                               AS awaiting_review,
        COUNT(*) FILTER (WHERE status = 'Completed')                    AS approved,
        COUNT(*) FILTER (
          WHERE status IN ('Rejected by Admin', 'Rejected by Super Admin')
        )                                                               AS rejected,
        COUNT(DISTINCT CASE WHEN assignee_model = 'User' THEN assignee_id END) AS users
      FROM indicators
    `;

    const result = await pool.query(query);
    const s = result.rows[0];

    res.status(200).json({
      success: true,
      data: {
        general: {
          total:          parseInt(s.total_indicators, 10),
          assigned:       parseInt(s.assigned, 10),
          unassigned:     parseInt(s.unassigned, 10),
          overdue:        parseInt(s.overdue, 10),
          awaitingReview: parseInt(s.awaiting_review, 10),
          approved:       parseInt(s.approved, 10),
          rejected:       parseInt(s.rejected, 10),
          users:          parseInt(s.users, 10),
        },
      },
    });
  }
);

/* ─── 12. UNASSIGN INDICATOR ──────────────────────────────────────────────── */

export const unassignIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const { rows: existing } = await pool.query(
      "SELECT id, assignee_id, assigned_by, status, progress, current_total_achieved, is_multi_assignee FROM indicators WHERE id = $1",
      [id]
    );
    
    if (!existing[0]) throw new AppError("Indicator not found.", 404);

    if (existing[0].assignee_id === null) {
      throw new AppError("Indicator is already unassigned.", 400);
    }

    // Clean up indicator_assignees
    await pool.query(
      "DELETE FROM indicator_assignees WHERE indicator_id = $1",
      [id]
    );

    await pool.query(
      `UPDATE indicators
       SET assignee_id          = NULL,
           assignee_model       = NULL,
           status               = 'Pending',
           progress             = 0,
           current_total_achieved = 0,
           is_multi_assignee    = false,
           updated_at           = NOW()
       WHERE id = $1`,
      [id]
    );

    const { rows: updated } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
      [id]
    );

    res.status(200).json({ 
      success: true, 
      message: "Indicator unassigned successfully. It is now available for reassignment.",
      data: updated[0] 
    });
  }
);

/* ─── 13. DELETE SUBMISSION ───────────────────────────────────────────────── */

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

      const docsRes = await client.query(
        `SELECT evidence_public_id
         FROM submission_documents
         WHERE submission_id = $1`,
        [submissionId]
      );
      const publicIds: string[] = docsRes.rows
        .map((r: { evidence_public_id: string }) => r.evidence_public_id)
        .filter(Boolean);

      await client.query("DELETE FROM submissions WHERE id = $1", [submissionId]);

      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Submission Deleted', 'Deleted by admin', 'admin', $2)`,
        [submission.indicator_id, (req as any).user.id]
      );

      await client.query("COMMIT");

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

/* ─── 14. GET ASSIGNED INDICATORS ────────────────────────────────────────── */

export const getAssignedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT} ${INDICATOR_JOINS}
       WHERE i.assignee_id IS NOT NULL
       ORDER BY i.created_at DESC`
    );

    const enrichedRows = await Promise.all(rows.map(async (row) => ({
      ...row,
      needsAction:
        row.status === "Awaiting Admin Approval" ||
        row.status === "Awaiting Super Admin",
      isOverdue: row.deadline ? new Date(row.deadline) < new Date() : false,
      completionPercentage: row.progress || 0,
      allAssignees: row.isMultiAssignee ? await getIndicatorAssignees(row.id) : undefined,
    })));

    res.status(200).json({
      success: true,
      count: enrichedRows.length,
      data: enrichedRows,
    });
  }
);

/* ─── 15. GET UNASSIGNED INDICATORS ──────────────────────────────────────── */

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

/* ─── 16. GET REVIEW INDICATORS ──────────────────────────────────────────── */

export const getReviewIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `${INDICATOR_SELECT},
         COALESCE(ps.pending_count, 0) AS "pendingSubmissionCount"

       ${INDICATOR_JOINS}

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

    const enrichedRows = await Promise.all(rows.map(async (row) => ({
      ...row,
      needsAction:
        row.pendingSubmissionCount > 0 ||
        row.status === "Awaiting Admin Approval" ||
        row.status === "Awaiting Super Admin",
      isOverdue: row.deadline ? new Date(row.deadline) < new Date() : false,
      completionPercentage: row.progress || 0,
      allAssignees: row.isMultiAssignee ? await getIndicatorAssignees(row.id) : undefined,
    })));

    res.status(200).json({
      success: true,
      count: enrichedRows.length,
      data: enrichedRows,
    });
  }
);

/* ─── 17. GET INDICATOR COUNTS ────────────────────────────────────────────── */

export const getIndicatorCounts = asyncHandler(
  async (_req: Request, res: Response) => {
    const countsQuery = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE assignee_id IS NOT NULL 
          AND assignee_model IS NOT NULL
          AND status != 'Unassigned'
        )::int AS assigned,
        COUNT(*) FILTER (
          WHERE assignee_id IS NULL 
          OR assignee_model IS NULL
          OR status = 'Unassigned'
        )::int AS unassigned,
        COUNT(*) FILTER (
          WHERE status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')
        )::int AS review,
        COUNT(*) FILTER (
          WHERE deadline < NOW()
            AND status NOT IN (
              'Completed',
              'Awaiting Admin Approval',
              'Awaiting Super Admin'
            )
            AND assignee_id IS NOT NULL
        )::int AS overdue
      FROM indicators
      WHERE deleted_at IS NULL
    `;

    const perspectiveQuery = `
      SELECT
        sp.perspective,
        COUNT(DISTINCT i.id)::int AS "indicatorCount"
      FROM strategic_plans sp
      LEFT JOIN strategic_objectives so ON so.plan_id = sp.id
      LEFT JOIN strategic_activities sa ON sa.objective_id = so.id
      LEFT JOIN indicators i ON i.activity_id = sa.id
      WHERE i.deleted_at IS NULL
      GROUP BY sp.perspective
    `;

    const [countsResult, perspectiveResult] = await Promise.all([
      pool.query(countsQuery),
      pool.query(perspectiveQuery),
    ]);

    const counts = countsResult.rows[0];
    const perspectives: Record<string, number> = {};
    perspectiveResult.rows.forEach((row) => {
      if (row.perspective) {
        perspectives[row.perspective.toUpperCase()] = parseInt(row.indicatorCount, 10);
      }
    });

    res.status(200).json({
      success: true,
      data: {
        total: parseInt(counts.total, 10),
        assigned: parseInt(counts.assigned, 10),
        unassigned: parseInt(counts.unassigned, 10),
        review: parseInt(counts.review, 10),
        overdue: parseInt(counts.overdue, 10),
        perspectives,
      },
    });
  }
);

/* ─── 18. GET SUPER ADMIN APPROVED INDICATORS ────────────────────────────── */

export const getSuperAdminApprovedIndicators = asyncHandler(
  async (req: Request, res: Response) => {
    const includePending = req.query.includePending === "true";

    let whereClause = `
      WHERE EXISTS (
        SELECT 1
        FROM review_history rh
        WHERE rh.indicator_id = i.id
          AND rh.action = 'Approved'
          AND rh.reviewer_role = 'superadmin'
      )
    `;

    if (!includePending) {
      whereClause += ` AND i.status = 'Completed'`;
    }

    const selectWithDistinct = INDICATOR_SELECT.replace(/SELECT/i, "SELECT DISTINCT");

    const { rows } = await pool.query(`
      ${selectWithDistinct}
      ${INDICATOR_JOINS}
      ${whereClause}
      ORDER BY i.updated_at DESC
    `);

    res.status(200).json({ success: true, data: rows });
  }
);

/* ─── 19. ASSIGN INDICATOR (for existing unassigned indicators) ──────────── */

export const assignIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { assigneeId, assigneeModel = "User" } = req.body;
    const adminId = (req as any).user.id;

    if (!assigneeId) {
      throw new AppError("Please provide an assignee ID.", 400);
    }

    if (!isUUID(assigneeId)) {
      throw new AppError("Invalid assignee ID format.", 400);
    }

    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      const indRes = await client.query(
        "SELECT id, status, assignee_id, is_multi_assignee FROM indicators WHERE id = $1 FOR UPDATE",
        [id]
      );
      
      if (!indRes.rows[0]) {
        throw new AppError("Indicator not found.", 404);
      }

      const wasUnassigned = indRes.rows[0].assignee_id === null;
      const type = assigneeModel === "Team" ? "Team" : "User";

      await client.query(
        `UPDATE indicators
         SET assignee_id = $1,
             assignee_model = $2,
             assigned_by = $3,
             status = 'Pending',
             is_multi_assignee = false,
             updated_at = NOW()
         WHERE id = $4`,
        [assigneeId, type, adminId, id]
      );

      // Clear any existing multi-assignee records
      await client.query(
        "DELETE FROM indicator_assignees WHERE indicator_id = $1",
        [id]
      );

      await client.query("COMMIT");

      const { rows: updated } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [id]
      );

      const { rows: activityRows } = await pool.query(
        `SELECT sa.description AS "activityDescription"
         FROM strategic_activities sa
         WHERE sa.id = (SELECT activity_id FROM indicators WHERE id = $1)`,
        [id]
      );

      if (activityRows[0]?.activityDescription) {
        resolveRecipients(assigneeId, type)
          .then(({ emails, displayName }) => {
            emails.forEach((email) =>
              sendMail({
                to: email,
                subject: "Performance Indicator Assigned",
                html: taskAssignedTemplate(
                  displayName,
                  activityRows[0].activityDescription,
                  updated[0]?.reportingCycle || "Quarterly",
                  updated[0]?.activeQuarter || 1,
                  new Date().getFullYear(),
                  updated[0]?.deadline ? new Date(updated[0].deadline).toDateString() : "Not specified",
                  updated[0]?.objectiveTitle,
                  updated[0]?.target,
                  updated[0]?.unit
                ),
              }).catch((e) =>
                console.error(`[assignIndicator] Failed to send email to ${email}:`, e)
              )
            );
          })
          .catch((err) =>
            console.error("[assignIndicator] resolveRecipients failed:", err)
          );
      }

      res.status(200).json({
        success: true,
        message: wasUnassigned 
          ? "Indicator assigned successfully." 
          : "Indicator reassigned successfully.",
        data: updated[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

/* ─── 20. REASSIGN INDICATOR (replace primary assignee) ──────────────────── */

export const reassignIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { newAssigneeId, newAssigneeModel = "User", reason } = req.body;
    const adminId = (req as any).user.id;

    if (!newAssigneeId) {
      throw new AppError("Please provide a new assignee ID.", 400);
    }

    if (!isUUID(newAssigneeId)) {
      throw new AppError("Invalid assignee ID format.", 400);
    }

    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      // Get current indicator details - FIXED: Use string for id
      const indicatorId = Array.isArray(id) ? id[0] : id;
      const indRes = await client.query(
        `SELECT i.id, i.assignee_id, i.assignee_model, i.status, i.is_multi_assignee, 
                sa.description AS "activityDescription"
         FROM indicators i
         LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
         WHERE i.id = $1 FOR UPDATE`,
        [indicatorId]
      );
      
      if (!indRes.rows[0]) {
        throw new AppError("Indicator not found.", 404);
      }

      const indicator = indRes.rows[0];
      const oldAssigneeId = indicator.assignee_id;
      const oldAssigneeModel = indicator.assignee_model;

      if (!oldAssigneeId) {
        throw new AppError("Cannot reassign an unassigned indicator. Please use assign endpoint.", 400);
      }

      // Get old assignee info for email
      let oldAssigneeInfo = null;
      if (!indicator.is_multi_assignee) {
        oldAssigneeInfo = await resolveRecipients(oldAssigneeId, oldAssigneeModel);
      }

      // Update primary assignee
      const type = newAssigneeModel === "Team" ? "Team" : "User";
      await client.query(
        `UPDATE indicators
         SET assignee_id = $1,
             assignee_model = $2,
             assigned_by = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [newAssigneeId, type, adminId, indicatorId]
      );

      // If multi-assignee, update the assignees table
      if (indicator.is_multi_assignee) {
        // Remove old primary and add new primary
        await client.query(
          `DELETE FROM indicator_assignees WHERE indicator_id = $1 AND is_primary = true`,
          [indicatorId]
        );
        
        await client.query(
          `INSERT INTO indicator_assignees (indicator_id, user_id, is_primary)
           VALUES ($1, $2, true)
           ON CONFLICT (indicator_id, user_id) DO NOTHING`,
          [indicatorId, newAssigneeId]
        );
      }

      // Record the reassignment in review history
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Reassigned', $2, 'admin', $3)`,
        [indicatorId, reason || `Reassigned from ${oldAssigneeId} to ${newAssigneeId}`, adminId]
      );

      await client.query("COMMIT");

      // Fetch updated indicator
      const { rows: updated } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [indicatorId]
      );

      if (updated[0]?.isMultiAssignee) {
        updated[0].allAssignees = await getIndicatorAssignees(indicatorId);
      }

      // Send notifications
      const activityDescription = indicator.activityDescription || "Performance Indicator";
      
      // Notify new assignee
      const newAssigneeInfo = await resolveRecipients(newAssigneeId, type);
      const emailPromises = newAssigneeInfo.emails.map((email) =>
        sendMail({
          to: email,
          subject: "Performance Indicator Reassigned to You",
          html: taskAssignedTemplate(
            newAssigneeInfo.displayName,
            activityDescription,
            updated[0]?.reportingCycle || "Quarterly",
            updated[0]?.activeQuarter || 1,
            new Date().getFullYear(),
            updated[0]?.deadline ? new Date(updated[0].deadline).toDateString() : "Not specified",
            updated[0]?.objectiveTitle,
            updated[0]?.target,
            updated[0]?.unit
          ),
        }).catch((e) =>
          console.error(`[reassignIndicator] Failed to send email to ${email}:`, e)
        )
      );

      // Notify old assignee if different
      if (oldAssigneeInfo && oldAssigneeInfo.emails.length > 0) {
        oldAssigneeInfo.emails.forEach((email) => {
          emailPromises.push(
            sendMail({
              to: email,
              subject: "Performance Indicator Reassigned Away",
              html: `
                <h2>Indicator Reassigned</h2>
                <p>Hello ${oldAssigneeInfo.displayName},</p>
                <p>The following indicator has been reassigned from you:</p>
                <ul>
                  <li><strong>Activity:</strong> ${activityDescription}</li>
                  <li><strong>New Assignee:</strong> ${newAssigneeInfo.displayName}</li>
                  ${reason ? `<li><strong>Reason:</strong> ${reason}</li>` : ''}
                </ul>
                <p>You are no longer responsible for this indicator.</p>
              `,
            }).catch((e) =>
              console.error(`[reassignIndicator] Failed to send email to ${email}:`, e)
            )
          );
        });
      }

      await Promise.all(emailPromises);

      res.status(200).json({
        success: true,
        message: "Indicator reassigned successfully.",
        data: updated[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

/* ─── 21. ADD USERS TO TASK (multi-assignee) ────────────────────────────── */

export const addUsersToIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { userIds, role = "contributor" } = req.body;
    const adminId = (req as any).user.id;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      throw new AppError("Please provide an array of user IDs to add.", 400);
    }

    // Validate UUIDs
    for (const userId of userIds) {
      if (!isUUID(userId)) {
        throw new AppError(`Invalid user ID format: ${userId}`, 400);
      }
    }

    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      const indicatorId = Array.isArray(id) ? id[0] : id;

      // Check if indicator exists
      const indRes = await client.query(
        "SELECT id, assignee_id, is_multi_assignee FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId]
      );
      
      if (!indRes.rows[0]) {
        throw new AppError("Indicator not found.", 404);
      }

      const indicator = indRes.rows[0];

      // If not already multi-assignee, convert it
      if (!indicator.is_multi_assignee) {
        // If there's an existing assignee, add them as primary
        if (indicator.assignee_id) {
          await client.query(
            `INSERT INTO indicator_assignees (indicator_id, user_id, is_primary)
             VALUES ($1, $2, true)
             ON CONFLICT (indicator_id, user_id) DO NOTHING`,
            [indicatorId, indicator.assignee_id]
          );
        }
        
        // Mark as multi-assignee
        await client.query(
          `UPDATE indicators SET is_multi_assignee = true WHERE id = $1`,
          [indicatorId]
        );
      }

      // Add new users
      let addedCount = 0;
      for (const userId of userIds) {
        // Skip if user is already primary assignee
        if (indicator.assignee_id === userId) {
          continue;
        }

        const result = await client.query(
          `INSERT INTO indicator_assignees (indicator_id, user_id, is_primary)
           VALUES ($1, $2, false)
           ON CONFLICT (indicator_id, user_id) DO NOTHING`,
          [indicatorId, userId]
        );
        
        // FIXED: Check rowCount with null coalescing
        if ((result.rowCount ?? 0) > 0) {
          addedCount++;
        }
      }

      if (addedCount === 0) {
        throw new AppError("No new users were added. They may already be assigned to this indicator.", 400);
      }

      // Record in review history
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Users Added', $2, 'admin', $3)`,
        [indicatorId, `Added ${addedCount} user(s) to the task: ${userIds.join(', ')}`, adminId]
      );

      await client.query("COMMIT");

      // Fetch updated indicator
      const { rows: updated } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [indicatorId]
      );

      const allAssignees = await getIndicatorAssignees(indicatorId);
      if (updated[0]) {
        updated[0].allAssignees = allAssignees;
      }

      // Get user details for notification
      const userDetails = await pool.query(
        `SELECT name, email FROM users WHERE id = ANY($1)`,
        [userIds]
      );

      // Get activity description for email
      const activityRes = await pool.query(
        `SELECT sa.description AS "activityDescription"
         FROM strategic_activities sa
         WHERE sa.id = (SELECT activity_id FROM indicators WHERE id = $1)`,
        [indicatorId]
      );
      const activityDescription = activityRes.rows[0]?.activityDescription || "Performance Indicator";

      // Send notifications to new users
      const emailPromises = userDetails.rows.map((user: any) =>
        sendMail({
          to: user.email,
          subject: "Added to Performance Indicator",
          html: `
            <h2>You've Been Added to a Task</h2>
            <p>Hello ${user.name},</p>
            <p>You have been added as a contributor to the following indicator:</p>
            <ul>
              <li><strong>Activity:</strong> ${activityDescription}</li>
              <li><strong>Reporting Cycle:</strong> ${updated[0]?.reportingCycle || "Quarterly"}</li>
              <li><strong>Target:</strong> ${updated[0]?.target || 100}${updated[0]?.unit || "%"}</li>
              ${updated[0]?.deadline ? `<li><strong>Deadline:</strong> ${new Date(updated[0].deadline).toDateString()}</li>` : ''}
            </ul>
            <p>You can now view and contribute to this indicator.</p>
          `,
        }).catch((e) =>
          console.error(`[addUsersToIndicator] Failed to send email to ${user.email}:`, e)
        )
      );

      await Promise.all(emailPromises);

      res.status(200).json({
        success: true,
        message: `${addedCount} user(s) added to the indicator successfully.`,
        data: updated[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

/* ─── 22. REMOVE USERS FROM TASK ──────────────────────────────────────────── */

export const removeUsersFromIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { userIds } = req.body;
    const adminId = (req as any).user.id;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      throw new AppError("Please provide an array of user IDs to remove.", 400);
    }

    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      const indicatorId = Array.isArray(id) ? id[0] : id;

      // Check if indicator exists
      const indRes = await client.query(
        "SELECT id, assignee_id, is_multi_assignee FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId]
      );
      
      if (!indRes.rows[0]) {
        throw new AppError("Indicator not found.", 404);
      }

      const indicator = indRes.rows[0];

      if (!indicator.is_multi_assignee) {
        throw new AppError("This indicator is not a multi-assignee task.", 400);
      }

      // Check if trying to remove primary assignee
      let removedPrimary = false;
      for (const userId of userIds) {
        if (indicator.assignee_id === userId) {
          removedPrimary = true;
          break;
        }
      }

      if (removedPrimary) {
        throw new AppError(
          "Cannot remove the primary assignee. Please reassign or unassign the indicator first.",
          400
        );
      }

      // Remove users
      const result = await client.query(
        `DELETE FROM indicator_assignees
         WHERE indicator_id = $1 AND user_id = ANY($2) AND is_primary = false
         RETURNING user_id`,
        [indicatorId, userIds]
      );

      // FIXED: Check rowCount with null coalescing
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError("No users were removed. They may not be assigned to this indicator.", 400);
      }

      // If no other assignees remain, convert back to single assignee
      const remainingAssignees = await client.query(
        `SELECT COUNT(*) FROM indicator_assignees WHERE indicator_id = $1`,
        [indicatorId]
      );

      if (parseInt(remainingAssignees.rows[0].count) <= 1) {
        // Only primary remains, mark as not multi-assignee
        await client.query(
          `UPDATE indicators SET is_multi_assignee = false WHERE id = $1`,
          [indicatorId]
        );
      }

      // Record in review history
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reason, reviewer_role, reviewed_by)
         VALUES ($1, 'Users Removed', $2, 'admin', $3)`,
        [indicatorId, `Removed user(s): ${userIds.join(', ')}`, adminId]
      );

      await client.query("COMMIT");

      // Fetch updated indicator
      const { rows: updated } = await pool.query(
        `${INDICATOR_SELECT} ${INDICATOR_JOINS} WHERE i.id = $1`,
        [indicatorId]
      );

      if (updated[0]?.isMultiAssignee) {
        updated[0].allAssignees = await getIndicatorAssignees(indicatorId);
      }

      res.status(200).json({
        success: true,
        message: `${result.rowCount ?? 0} user(s) removed from the indicator successfully.`,
        data: updated[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

/* ─── HELPER: GET INDICATOR ASSIGNEES ────────────────────────────────────── */

async function getIndicatorAssignees(indicatorId: string): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT 
       ia.user_id AS "userId",
       ia.is_primary AS "isPrimary",
       u.name,
       u.email,
       u.pj_number AS "pjNumber"
     FROM indicator_assignees ia
     JOIN users u ON ia.user_id = u.id
     WHERE ia.indicator_id = $1
     ORDER BY ia.is_primary DESC, u.name ASC`,
    [indicatorId]
  );
  return rows;
}