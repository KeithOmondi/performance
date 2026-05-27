import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";

// ─── Types ────────────────────────────────────────────────────────────────────

type CalendarEventType =
  | "deadline"
  | "submission"
  | "resubmission"
  | "review"
  | "reopen";

type CalendarEventStatus =
  | "Pending"
  | "Awaiting Admin Approval"
  | "Awaiting Super Admin"
  | "Rejected by Admin"
  | "Rejected by Super Admin"
  | "Completed"
  | "Verified"
  | "Accepted"
  | "Reopened";

export interface ICalendarEvent {
  id: string;
  indicatorId: string;
  title: string;
  type: CalendarEventType;
  date: string;           // ISO string — the single anchor date for the event
  endDate?: string;       // ISO string — only present for deadline range events
  status: CalendarEventStatus | string;
  assigneeName: string | null;
  assigneeEmail: string | null;
  quarter: number | null;
  year: number | null;
  reportingCycle: "Quarterly" | "Annual";
  perspective: string | null;
  objectiveTitle: string | null;
  activityDescription: string | null;
  meta?: Record<string, unknown>; // extra payload the frontend can use (reason, comment, etc.)
}

// ─── Helper: derive a human-readable title for an event ──────────────────────

function buildTitle(
  type: CalendarEventType,
  activityDescription: string | null,
  reportingCycle: string,
  quarter: number | null,
  year: number | null
): string {
  const period =
    reportingCycle === "Annual"
      ? `FY ${year}`
      : `Q${quarter} ${year}`;

  const base = activityDescription ?? "Indicator";

  switch (type) {
    case "deadline":      return `Deadline — ${base} (${period})`;
    case "submission":    return `Submitted — ${base} (${period})`;
    case "resubmission":  return `Resubmitted — ${base} (${period})`;
    case "review":        return `Reviewed — ${base} (${period})`;
    case "reopen":        return `Reopened — ${base} (${period})`;
  }
}

// ─── 1. Full Calendar Feed ────────────────────────────────────────────────────
//
// Returns every calendar-relevant event across all indicators the caller can
// see.  Each row in the result is a flat event object — no nesting — so the
// frontend can hand it straight to FullCalendar / react-big-calendar / etc.
//
// Event sources (one DB query each, UNIONed):
//   A) Indicator deadlines          → indicators.deadline
//   B) Submission events            → submissions.submitted_at  (first submission)
//   C) Resubmission events          → submissions.submitted_at  (resubmission_count > 0)
//   D) Review history events        → review_history.at

export const getCalendarEvents = asyncHandler(
  async (req: Request, res: Response) => {
    // ── Optional filters ─────────────────────────────────────────────────────
    // ?from=2024-01-01&to=2024-12-31   — date range (applied to all event types)
    // ?assigneeId=uuid                 — narrow to one assignee
    // ?status=Pending                  — narrow by indicator status
    // ?cycle=Quarterly|Annual

    const { from, to, assigneeId, status, cycle } = req.query as Record<
      string,
      string | undefined
    >;

    // Build optional WHERE fragments appended to each UNION branch
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (from) {
      values.push(from);
      conditions.push(`event_date >= $${values.length}::date`);
    }
    if (to) {
      values.push(to);
      conditions.push(`event_date <= $${values.length}::date`);
    }
    if (assigneeId) {
      values.push(assigneeId);
      conditions.push(`assignee_id = $${values.length}`);
    }
    if (status && status !== "all") {
      values.push(status);
      conditions.push(`indicator_status = $${values.length}`);
    }
    if (cycle) {
      values.push(cycle);
      conditions.push(`reporting_cycle = $${values.length}`);
    }

    const havingClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // ── Master UNION query ────────────────────────────────────────────────────
    // Each branch produces the same column set so they can be UNIONed cleanly.
    // We wrap everything in a CTE so the optional WHERE filters apply uniformly
    // across all branches without duplicating param indexes.

    const sql = `
      WITH base_events AS (

        -- ── A. Deadlines ──────────────────────────────────────────────────────
        SELECT
          CONCAT('deadline_', i.id)               AS id,
          i.id                                     AS indicator_id,
          'deadline'::text                         AS type,
          i.deadline                               AS event_date,
          NULL::timestamptz                        AS end_date,
          i.status                                 AS indicator_status,
          i.assignee_id,
          COALESCE(u.name,  t.name)                AS assignee_name,
          COALESCE(u.email, t.email)               AS assignee_email,
          i.active_quarter                         AS quarter,
          EXTRACT(YEAR FROM i.deadline)::int       AS year,
          i.reporting_cycle,
          sp.perspective,
          so.title                                 AS objective_title,
          sa.description                           AS activity_description,
          NULL::text                               AS meta_reason,
          NULL::text                               AS meta_comment,
          NULL::int                                AS meta_resubmission_count
        FROM indicators i
        LEFT JOIN users u           ON i.assignee_id = u.id  AND i.assignee_model = 'User'
        LEFT JOIN teams t           ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
        LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
        LEFT JOIN strategic_objectives so ON i.objective_id = so.id
        LEFT JOIN strategic_activities sa ON i.activity_id  = sa.id
        WHERE i.deadline IS NOT NULL

        UNION ALL

        -- ── B. First Submissions ──────────────────────────────────────────────
        SELECT
          CONCAT('submission_', s.id)              AS id,
          i.id                                     AS indicator_id,
          CASE
            WHEN s.resubmission_count > 0 THEN 'resubmission'
            ELSE 'submission'
          END::text                                AS type,
          s.submitted_at                           AS event_date,
          NULL::timestamptz                        AS end_date,
          i.status                                 AS indicator_status,
          i.assignee_id,
          COALESCE(u.name,  t.name)                AS assignee_name,
          COALESCE(u.email, t.email)               AS assignee_email,
          s.quarter,
          s.year,
          i.reporting_cycle,
          sp.perspective,
          so.title                                 AS objective_title,
          sa.description                           AS activity_description,
          s.previous_rejection_reason              AS meta_reason,
          s.admin_comment                          AS meta_comment,
          s.resubmission_count                     AS meta_resubmission_count
        FROM submissions s
        JOIN indicators i           ON s.indicator_id = i.id
        LEFT JOIN users u           ON i.assignee_id = u.id  AND i.assignee_model = 'User'
        LEFT JOIN teams t           ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
        LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
        LEFT JOIN strategic_objectives so ON i.objective_id = so.id
        LEFT JOIN strategic_activities sa ON i.activity_id  = sa.id
        WHERE s.submitted_at IS NOT NULL

        UNION ALL

        -- ── C. Review History Events ──────────────────────────────────────────
        SELECT
          CONCAT('review_', rh.id)                 AS id,
          i.id                                     AS indicator_id,
          CASE
            WHEN rh.action = 'Reopened' THEN 'reopen'
            ELSE 'review'
          END::text                                AS type,
          rh.at                                    AS event_date,
          NULL::timestamptz                        AS end_date,
          i.status                                 AS indicator_status,
          i.assignee_id,
          COALESCE(u.name,  t.name)                AS assignee_name,
          COALESCE(u.email, t.email)               AS assignee_email,
          i.active_quarter                         AS quarter,
          EXTRACT(YEAR FROM rh.at)::int            AS year,
          i.reporting_cycle,
          sp.perspective,
          so.title                                 AS objective_title,
          sa.description                           AS activity_description,
          rh.reason                                AS meta_reason,
          rh.action                                AS meta_comment,
          NULL::int                                AS meta_resubmission_count
        FROM review_history rh
        JOIN indicators i           ON rh.indicator_id = i.id
        LEFT JOIN users u           ON i.assignee_id = u.id  AND i.assignee_model = 'User'
        LEFT JOIN teams t           ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
        LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
        LEFT JOIN strategic_objectives so ON i.objective_id = so.id
        LEFT JOIN strategic_activities sa ON i.activity_id  = sa.id
        WHERE rh.at IS NOT NULL

      )
      SELECT *
      FROM base_events
      ${havingClause}
      ORDER BY event_date DESC
    `;

    const { rows } = await pool.query(sql, values);

    // ── Shape into ICalendarEvent ─────────────────────────────────────────────
    const events: ICalendarEvent[] = rows.map((row) => ({
      id:                  row.id,
      indicatorId:         row.indicator_id,
      title: buildTitle(
        row.type as CalendarEventType,
        row.activity_description,
        row.reporting_cycle,
        row.quarter,
        row.year
      ),
      type:                row.type as CalendarEventType,
      date:                row.event_date,
      endDate:             row.end_date ?? undefined,
      status:              row.indicator_status,
      assigneeName:        row.assignee_name ?? null,
      assigneeEmail:       row.assignee_email ?? null,
      quarter:             row.quarter ?? null,
      year:                row.year ?? null,
      reportingCycle:      row.reporting_cycle,
      perspective:         row.perspective ?? null,
      objectiveTitle:      row.objective_title ?? null,
      activityDescription: row.activity_description ?? null,
      meta: {
        reason:             row.meta_reason ?? undefined,
        comment:            row.meta_comment ?? undefined,
        resubmissionCount:  row.meta_resubmission_count ?? undefined,
      },
    }));

    res.status(200).json({
      success: true,
      count: events.length,
      data: events,
    });
  }
);

// ─── 2. Single Indicator Calendar ────────────────────────────────────────────
//
// Narrower version: all events for one indicator by ID.
// Useful for a detail drawer / side panel timeline view.

export const getIndicatorCalendarEvents = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    // Verify the indicator exists first so we return a clean 404
    const { rows: check } = await pool.query(
      "SELECT id FROM indicators WHERE id = $1 LIMIT 1",
      [id]
    );
    if (check.length === 0) throw new AppError("Indicator not found.", 404);

    const sql = `
      WITH indicator_meta AS (
        SELECT
          i.id,
          i.status,
          i.active_quarter,
          i.reporting_cycle,
          i.deadline,
          i.assignee_id,
          COALESCE(u.name,  t.name)  AS assignee_name,
          COALESCE(u.email, t.email) AS assignee_email,
          sp.perspective,
          so.title                   AS objective_title,
          sa.description             AS activity_description
        FROM indicators i
        LEFT JOIN users u            ON i.assignee_id = u.id  AND i.assignee_model = 'User'
        LEFT JOIN teams t            ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
        LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
        LEFT JOIN strategic_objectives so ON i.objective_id = so.id
        LEFT JOIN strategic_activities sa ON i.activity_id  = sa.id
        WHERE i.id = $1
      ),

      deadline_event AS (
        SELECT
          CONCAT('deadline_', m.id)              AS id,
          m.id                                   AS indicator_id,
          'deadline'::text                       AS type,
          m.deadline                             AS event_date,
          m.status                               AS indicator_status,
          m.active_quarter                       AS quarter,
          EXTRACT(YEAR FROM m.deadline)::int     AS year,
          m.reporting_cycle,
          m.perspective,
          m.objective_title,
          m.activity_description,
          m.assignee_name,
          m.assignee_email,
          NULL::text                             AS meta_reason,
          NULL::text                             AS meta_comment,
          NULL::int                              AS meta_resubmission_count
        FROM indicator_meta m
        WHERE m.deadline IS NOT NULL
      ),

      submission_events AS (
        SELECT
          CONCAT('submission_', s.id)            AS id,
          m.id                                   AS indicator_id,
          CASE
            WHEN s.resubmission_count > 0 THEN 'resubmission'
            ELSE 'submission'
          END::text                              AS type,
          s.submitted_at                         AS event_date,
          m.status                               AS indicator_status,
          s.quarter,
          s.year,
          m.reporting_cycle,
          m.perspective,
          m.objective_title,
          m.activity_description,
          m.assignee_name,
          m.assignee_email,
          s.previous_rejection_reason            AS meta_reason,
          s.admin_comment                        AS meta_comment,
          s.resubmission_count                   AS meta_resubmission_count
        FROM submissions s
        JOIN indicator_meta m ON m.id = s.indicator_id
        WHERE s.submitted_at IS NOT NULL
      ),

      review_events AS (
        SELECT
          CONCAT('review_', rh.id)               AS id,
          m.id                                   AS indicator_id,
          CASE
            WHEN rh.action = 'Reopened' THEN 'reopen'
            ELSE 'review'
          END::text                              AS type,
          rh.at                                  AS event_date,
          m.status                               AS indicator_status,
          m.active_quarter                       AS quarter,
          EXTRACT(YEAR FROM rh.at)::int          AS year,
          m.reporting_cycle,
          m.perspective,
          m.objective_title,
          m.activity_description,
          m.assignee_name,
          m.assignee_email,
          rh.reason                              AS meta_reason,
          rh.action                              AS meta_comment,
          NULL::int                              AS meta_resubmission_count
        FROM review_history rh
        JOIN indicator_meta m ON m.id = rh.indicator_id
        WHERE rh.at IS NOT NULL
      )

      SELECT * FROM deadline_event
      UNION ALL
      SELECT * FROM submission_events
      UNION ALL
      SELECT * FROM review_events
      ORDER BY event_date DESC
    `;

    const { rows } = await pool.query(sql, [id]);

    const events: ICalendarEvent[] = rows.map((row) => ({
      id:                  row.id,
      indicatorId:         row.indicator_id,
      title: buildTitle(
        row.type as CalendarEventType,
        row.activity_description,
        row.reporting_cycle,
        row.quarter,
        row.year
      ),
      type:                row.type as CalendarEventType,
      date:                row.event_date,
      status:              row.indicator_status,
      assigneeName:        row.assignee_name ?? null,
      assigneeEmail:       row.assignee_email ?? null,
      quarter:             row.quarter ?? null,
      year:                row.year ?? null,
      reportingCycle:      row.reporting_cycle,
      perspective:         row.perspective ?? null,
      objectiveTitle:      row.objective_title ?? null,
      activityDescription: row.activity_description ?? null,
      meta: {
        reason:            row.meta_reason ?? undefined,
        comment:           row.meta_comment ?? undefined,
        resubmissionCount: row.meta_resubmission_count ?? undefined,
      },
    }));

    res.status(200).json({
      success: true,
      count: events.length,
      data: events,
    });
  }
);

// ─── 3. Upcoming Deadlines ────────────────────────────────────────────────────
//
// Lightweight feed — only deadline events from today forward.
// Used for dashboard widgets / notification badges.
// ?days=30  (default 30, max 365)

export const getUpcomingDeadlines = asyncHandler(
  async (req: Request, res: Response) => {
    const rawDays = parseInt((req.query.days as string) ?? "30", 10);
    const days    = Math.min(Math.max(rawDays, 1), 365);

    const { rows } = await pool.query(
      `SELECT
         CONCAT('deadline_', i.id)          AS id,
         i.id                               AS "indicatorId",
         i.deadline                         AS date,
         i.status,
         i.active_quarter                   AS quarter,
         i.reporting_cycle                  AS "reportingCycle",
         EXTRACT(YEAR FROM i.deadline)::int AS year,
         COALESCE(u.name,  t.name)          AS "assigneeName",
         COALESCE(u.email, t.email)         AS "assigneeEmail",
         sa.description                     AS "activityDescription",
         sp.perspective,
         so.title                           AS "objectiveTitle",
         -- Days remaining (negative = overdue)
         (i.deadline::date - CURRENT_DATE)  AS days_remaining
       FROM indicators i
       LEFT JOIN users u            ON i.assignee_id = u.id  AND i.assignee_model = 'User'
       LEFT JOIN teams t            ON i.assignee_id = t.id  AND i.assignee_model = 'Team'
       LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
       LEFT JOIN strategic_objectives so ON i.objective_id = so.id
       LEFT JOIN strategic_activities sa ON i.activity_id  = sa.id
       WHERE i.deadline IS NOT NULL
         AND i.deadline >= CURRENT_DATE
         AND i.deadline <= CURRENT_DATE + ($1 || ' days')::interval
         AND i.status NOT IN ('Completed', 'Rejected by Super Admin')
       ORDER BY i.deadline ASC`,
      [days]
    );

    res.status(200).json({
      success: true,
      count: rows.length,
      windowDays: days,
      data: rows,
    });
  }
);