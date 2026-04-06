import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";

// ─── 1. Performance Summary (by Perspective) ──────────────────────────────────
export const getPerformanceSummary = asyncHandler(async (_req: Request, res: Response) => {
  const query = `
    SELECT 
      COALESCE(sp.perspective, 'Uncategorised') as name,
      SUM(i.weight) as weight,
      SUM(i.target) as target,
      SUM(i.current_total_achieved) as achieved,
      COUNT(i.id) as count,
      ROUND(
        CASE 
          WHEN SUM(i.target) > 0 THEN (SUM(i.current_total_achieved)::FLOAT / SUM(i.target)::FLOAT) * SUM(i.weight)
          ELSE 0 
        END::NUMERIC, 2
      ) as score,
      CASE 
        WHEN SUM(i.current_total_achieved) >= SUM(i.target) THEN 'ON TRACK'
        ELSE 'IN PROGRESS'
      END as status
    FROM indicators i
    LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
    GROUP BY sp.perspective
    ORDER BY weight DESC
  `;

  const { rows } = await pool.query(query);
  res.status(200).json({ success: true, data: rows });
});

// ─── 2. Review Log ────────────────────────────────────────────────────────────
export const getReviewLog = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const validStatuses = ["Pending", "Verified", "Accepted", "Rejected"];
  
  let filterClause = "";
  const params: any[] = [];

  if (status && status !== "ALL" && validStatuses.includes(status as string)) {
    params.push(status);
    filterClause = `WHERE s.review_status = $1`;
  }

  const logsQuery = `
    SELECT 
      s.id as _id,
      COALESCE(i.instructions, 'Performance Indicator') as "indicatorTitle",
      s.quarter,
      s.achieved_value as "achievedValue",
      s.review_status as "reviewStatus",
      s.submitted_at as "submittedAt",
      s.notes,
      s.admin_comment as "adminComment",
      s.resubmission_count as "resubmissionCount",
      u.name as "assigneeName",
      u.email as "assigneeEmail",
      u.pj_number as "assigneePjNumber"
    FROM submissions s
    JOIN indicators i ON s.indicator_id = i.id
    LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
    ${filterClause}
    ORDER BY s.submitted_at DESC
  `;

  const statsQuery = `
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE review_status = 'Accepted') as accepted,
      COUNT(*) FILTER (WHERE review_status = 'Rejected') as rejected,
      COUNT(*) FILTER (WHERE review_status = 'Pending') as pending,
      COUNT(*) FILTER (WHERE review_status = 'Verified') as verified
    FROM submissions
  `;

  const [logsRes, statsRes] = await Promise.all([
    pool.query(logsQuery, params),
    pool.query(statsQuery)
  ]);

  res.status(200).json({
    success: true,
    data: logsRes.rows,
    stats: statsRes.rows[0] || { accepted: 0, rejected: 0, pending: 0, verified: 0, total: 0 }
  });
});

// ─── 3. Individual Performance ────────────────────────────────────────────────
export const getIndividualPerformance = asyncHandler(async (_req: Request, res: Response) => {
  const query = `
    SELECT 
      u.name,
      u.pj_number as "pjNumber",
      u.role,
      u.title,
      COUNT(i.id) as "totalAssigned",
      COUNT(i.id) FILTER (WHERE i.status = 'Completed') as completed,
      COUNT(i.id) FILTER (WHERE i.status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')) as "awaitingReview",
      COUNT(i.id) FILTER (WHERE i.status IN ('Rejected by Admin', 'Rejected by Super Admin')) as rejected,
      ROUND(COALESCE(AVG(i.progress), 0)::NUMERIC, 1) as "avgProgress"
    FROM users u
    LEFT JOIN indicators i ON u.id = i.assignee_id AND i.assignee_model = 'User'
    WHERE u.role IN ('user', 'examiner') AND u.is_active = true
    GROUP BY u.id
    ORDER BY "avgProgress" DESC
  `;

  const { rows } = await pool.query(query);
  res.status(200).json({ success: true, data: rows });
});