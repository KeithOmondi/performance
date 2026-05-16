import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";

/**
 * GET /api/superadmin/dashboard
 *
 * Single endpoint. One DB round-trip for stats + one for recent submissions.
 * Frontend reads this directly — no Redux slice, no re-derivation.
 *
 * Response shape:
 * {
 *   success: true,
 *   data: {
 *     stats: {
 *       total, assigned, unassigned, overdue,
 *       pendingReview, approved, rejected, returnedForCorrection
 *     },
 *     perspectives: [
 *       { name, totalActivities, assignedActivities, completionPercentage }
 *     ],
 *     recentSubmissions: [
 *       { submissionId, indicatorTitle, submittedBy, submittedOn,
 *         quarter, achievedValue, documentsCount, reviewStatus }
 *     ]
 *   }
 * }
 */
export const getDashboardStats = asyncHandler(
  async (_req: Request, res: Response) => {

    /* ── 1. CORE STATS ─────────────────────────────────────────────────────
       All counts in a single query — zero N+1, no frontend re-derivation.

       Logic that matches your existing indicator.controller.ts exactly:
       - assigned        = assignee_id IS NOT NULL  (mirrors getAssignedIndicators)
       - unassigned      = assignee_id IS NULL       (mirrors getUnassignedIndicators)
       - overdue         = deadline < NOW() AND not in a terminal/review status
                           (mirrors getSuperAdminStats overdue filter)
       - pendingReview   = status IN ('Awaiting Admin Approval','Awaiting Super Admin')
       - approved        = status = 'Completed'
       - rejected        = 'Rejected by Admin' OR 'Rejected by Super Admin'
       - returnedForCorrection = same as rejected (surface label differs)
    ─────────────────────────────────────────────────────────────────────── */
    const statsQuery = `
      SELECT
        COUNT(*)::int                                                          AS total,

        COUNT(*) FILTER (WHERE assignee_id IS NOT NULL)::int                  AS assigned,

        COUNT(*) FILTER (WHERE assignee_id IS NULL)::int                      AS unassigned,

        COUNT(*) FILTER (
          WHERE deadline < NOW()
            AND status NOT IN (
              'Completed',
              'Awaiting Admin Approval',
              'Awaiting Super Admin'
            )
        )::int                                                                 AS overdue,

        COUNT(*) FILTER (
          WHERE status IN ('Awaiting Admin Approval', 'Awaiting Super Admin')
        )::int                                                                 AS "pendingReview",

        COUNT(*) FILTER (WHERE status = 'Completed')::int                     AS approved,

        COUNT(*) FILTER (
          WHERE status IN ('Rejected by Admin', 'Rejected by Super Admin')
        )::int                                                                 AS rejected,

        COUNT(*) FILTER (
          WHERE status IN ('Rejected by Admin', 'Rejected by Super Admin')
        )::int                                                                 AS "returnedForCorrection"

      FROM indicators
    `;

    /* ── 2. PERSPECTIVE BREAKDOWN ──────────────────────────────────────────
       Joins strategic_plans → strategic_objectives → strategic_activities
       and left-joins indicators to count how many activities have been
       assigned an indicator. All done in SQL — no frontend array crunching.
    ─────────────────────────────────────────────────────────────────────── */
    const perspectivesQuery = `
      SELECT
        sp.perspective                                    AS name,
        COUNT(DISTINCT sa.id)::int                        AS "totalActivities",
        COUNT(DISTINCT i.activity_id)::int                AS "assignedActivities",
        CASE
          WHEN COUNT(DISTINCT sa.id) = 0 THEN 0
          ELSE ROUND(
            COUNT(DISTINCT i.activity_id)::numeric
            / COUNT(DISTINCT sa.id)::numeric * 100
          )::int
        END                                               AS "completionPercentage"

      FROM strategic_plans sp
      LEFT JOIN strategic_objectives so ON so.plan_id = sp.id
      LEFT JOIN strategic_activities sa ON sa.objective_id      = so.id
      LEFT JOIN indicators           i  ON i.activity_id        = sa.id

      GROUP BY sp.perspective
      ORDER BY sp.perspective
    `;

    /* ── 3. RECENT SUBMISSIONS ─────────────────────────────────────────────
       Last 10 submissions for the dashboard feed.
       Mirrors the shape getAllSubmissions returns so the UI card is unchanged.
    ─────────────────────────────────────────────────────────────────────── */
    const submissionsQuery = `
      SELECT
        s.id                                AS "submissionId",
        sa.description                      AS "indicatorTitle",
        CASE
          WHEN i.assignee_model = 'User' THEN u.name
          ELSE t.name
        END                                 AS "submittedBy",
        s.submitted_at                      AS "submittedOn",
        i.active_quarter                    AS quarter,
        s.achieved_value                    AS "achievedValue",
        s.review_status                     AS "reviewStatus",
        COUNT(sd.id)::int                   AS "documentsCount"

      FROM submissions s
      JOIN  indicators           i  ON s.indicator_id = i.id
      LEFT JOIN users            u  ON i.assignee_id  = u.id  AND i.assignee_model = 'User'
      LEFT JOIN teams            t  ON i.assignee_id  = t.id  AND i.assignee_model = 'Team'
      LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
      LEFT JOIN submission_documents sd ON sd.submission_id = s.id

      GROUP BY
        s.id, sa.description, u.name, t.name,
        i.assignee_model, i.active_quarter, s.submitted_at,
        s.achieved_value, s.review_status

      ORDER BY s.submitted_at DESC
      LIMIT 10
    `;

    /* ── RUN ALL THREE IN PARALLEL ─────────────────────────────────────── */
    const [statsResult, perspectivesResult, submissionsResult] =
      await Promise.all([
        pool.query(statsQuery),
        pool.query(perspectivesQuery),
        pool.query(submissionsQuery),
      ]);

    res.status(200).json({
      success: true,
      data: {
        stats:              statsResult.rows[0],
        perspectives:       perspectivesResult.rows,
        recentSubmissions:  submissionsResult.rows,
      },
    });
  }
);