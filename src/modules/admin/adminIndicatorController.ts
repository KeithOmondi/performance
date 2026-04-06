import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import sendMail from "../../utils/sendMail";
import { submissionRejectedTemplate, superAdminReviewNeededTemplate } from "../../utils/mailTemplates";

/**
 * SQL Helper: Explicitly maps Postgres snake_case to Frontend camelCase
 * FIX: Moved ORDER BY inside a derived subquery before json_agg to avoid
 *      "column must appear in GROUP BY or aggregate function" error.
 */
const INDICATOR_DETAIL_QUERY = `
  SELECT 
    i.*,
    i.active_quarter        AS "activeQuarter",
    i.reporting_cycle       AS "reportingCycle",
    i.strategic_plan_id     AS "strategicPlanId",
    i.objective_id          AS "objectiveId",
    i.activity_id           AS "activityId",
    i.assignee_id           AS "assigneeId",
    i.updated_at            AS "updatedAt",
    u.name                  AS "assigneeName",
    u.email                 AS "assigneeEmail",
    u.pj_number             AS "pjNumber",
    ab.name                 AS "assignedByName",
    sp.perspective,

    -- FETCH OBJECTIVE AS OBJECT
    (
      SELECT json_build_object('title', title)
      FROM strategic_objectives
      WHERE id = i.objective_id
    ) AS objective,

    -- FETCH ACTIVITY AS OBJECT
    (
      SELECT json_build_object('description', description)
      FROM strategic_activities
      WHERE id = i.activity_id
    ) AS activity,

    -- NESTED SUBMISSIONS (ordered inside derived subquery, then aggregated)
    COALESCE(
      (
        SELECT json_agg(sub)
        FROM (
          SELECT json_build_object(
            'id',                s.id,
            'indicatorId',       s.indicator_id,
            'quarter',           s.quarter,
            'year',              s.year,
            'reviewStatus',      s.review_status,
            'adminComment',      s.admin_comment,
            'resubmissionCount', s.resubmission_count,
            'achievedValue',     s.achieved_value,
            'notes',             s.notes,
            'submittedAt',       s.submitted_at,
            'isReviewed',        s.is_reviewed,
            'documents', (
              SELECT json_agg(json_build_object(
                'id',                d.id,
                'submissionId',      d.submission_id,
                'evidenceUrl',       d.evidence_url,
                'evidencePublicId',  d.evidence_public_id,
                'fileType',          d.file_type,
                'fileName',          d.file_name,
                'uploadedAt',        d.uploaded_at
              ))
              FROM submission_documents d
              WHERE d.submission_id = s.id
            )
          ) AS sub
          FROM submissions s
          WHERE s.indicator_id = i.id
          ORDER BY s.submitted_at DESC
        ) ordered_subs
      ),
      '[]'
    ) AS submissions

  FROM indicators i
  LEFT JOIN users u  ON i.assignee_id = u.id
  LEFT JOIN users ab ON i.assigned_by  = ab.id
  LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
`;

// ─── 1. Fetch All Indicators ──────────────────────────────────────────────────
export const fetchIndicatorsForAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { status, search } = req.query;
  const values: any[] = [];
  let whereClause = "WHERE 1=1";

  if (status && status !== "all") {
    values.push(status);
    whereClause += ` AND i.status = $${values.length}`;
  }

  if (search) {
    values.push(`%${search}%`);
    whereClause += ` AND (u.name ILIKE $${values.length} OR u.pj_number ILIKE $${values.length})`;
  }

  const query = `${INDICATOR_DETAIL_QUERY} ${whereClause} ORDER BY i.updated_at DESC`;
  const { rows: indicators } = await pool.query(query, values);

  res.status(200).json({ success: true, data: indicators });
});

// ─── 2. Get Indicator By ID ───────────────────────────────────────────────────
export const getIndicatorByIdAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const query = `${INDICATOR_DETAIL_QUERY} WHERE i.id = $1 LIMIT 1`;
  const { rows } = await pool.query(query, [id]);
  const indicator = rows[0];

  if (!indicator) throw new AppError("Indicator not found.", 404);

  const historyRes = await pool.query(
    `SELECT 
       h.*,
       h.reviewer_role AS "reviewerRole",
       u.name          AS "reviewerName"
     FROM review_history h
     LEFT JOIN users u ON h.reviewed_by = u.id
     WHERE h.indicator_id = $1
     ORDER BY h.at DESC`,
    [id]
  );

  indicator.reviewHistory = historyRes.rows;
  res.status(200).json({ success: true, data: indicator });
});

// ─── 3. Admin Review Process ──────────────────────────────────────────────────
export const adminReviewProcess = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { decision, adminOverallComments, submissionUpdates } = req.body;
  const adminId = (req as any).user.id;

  if (!["Verified", "Rejected"].includes(decision)) {
    throw new AppError('Decision must be "Verified" or "Rejected".', 400);
  }

  const isVerified = decision === "Verified";
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const indRes = await client.query(
      `SELECT 
         i.*,
         i.active_quarter    AS "activeQuarter",
         i.reporting_cycle   AS "reportingCycle",
         u.name,
         u.email
       FROM indicators i
       JOIN users u ON i.assignee_id = u.id
       WHERE i.id = $1`,
      [id]
    );
    const indicator = indRes.rows[0];

    if (!indicator) throw new AppError("Indicator not found.", 404);
    if (indicator.status !== "Awaiting Admin Approval") {
      throw new AppError("Indicator is not in review status.", 400);
    }

    const newStatus = isVerified ? "Awaiting Super Admin" : "Rejected by Admin";

    await client.query(
      `UPDATE indicators
       SET status = $1, admin_overall_comments = $2, updated_at = NOW()
       WHERE id = $3`,
      [newStatus, adminOverallComments, id]
    );

    if (Array.isArray(submissionUpdates)) {
      for (const update of submissionUpdates) {
        await client.query(
          `UPDATE submissions
           SET review_status = $1, admin_comment = $2, is_reviewed = true
           WHERE id = $3`,
          [
            isVerified ? "Verified" : "Rejected",
            update.adminComment || adminOverallComments,
            update.submissionId,
          ]
        );
      }
    }

    await client.query(
      `INSERT INTO review_history (indicator_id, action, reason, reviewer_role, reviewed_by)
       VALUES ($1, $2, $3, 'admin', $4)`,
      [id, isVerified ? "Verified" : "Correction Requested", adminOverallComments, adminId]
    );

    await client.query("COMMIT");

    const taskTitle  = indicator.instructions || "Performance Indicator";
    const year       = new Date().getFullYear();
    const cycleInfo  = indicator.reportingCycle === "Annual" ? "Annual" : `Q${indicator.activeQuarter}`;

    if (isVerified) {
      const saRes = await pool.query(
        "SELECT email FROM users WHERE role = 'superadmin' AND is_active = true"
      );
      saRes.rows.forEach((sa) => {
        sendMail({
          to: sa.email,
          subject: `[${cycleInfo}] Submission Ready for Final Approval`,
          html: superAdminReviewNeededTemplate(
            taskTitle,
            indicator.name,
            (req as any).user.name,
            cycleInfo,
            year
          ),
        }).catch(console.error);
      });
    } else {
      sendMail({
        to: indicator.email,
        subject: "Submission Returned for Correction",
        html: submissionRejectedTemplate(
          indicator.name,
          taskTitle,
          cycleInfo,
          year,
          "Admin",
          adminOverallComments
        ),
      }).catch(console.error);
    }

    res.status(200).json({
      success: true,
      message: isVerified ? "Verified successfully." : "Rejected for correction.",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

// ─── 4. Fetch Resubmitted Indicators ─────────────────────────────────────────
export const fetchResubmittedIndicators = asyncHandler(async (_req: Request, res: Response) => {
  const query = `
    ${INDICATOR_DETAIL_QUERY}
    WHERE i.status = 'Awaiting Admin Approval'
    AND EXISTS (
      SELECT 1
      FROM submissions s
      WHERE s.indicator_id = i.id
        AND s.review_status = 'Pending'
        AND s.resubmission_count > 0
    )
    ORDER BY i.updated_at DESC
  `;

  const { rows: indicators } = await pool.query(query);

  res.status(200).json({
    success: true,
    count: indicators.length,
    data: indicators,
  });
});