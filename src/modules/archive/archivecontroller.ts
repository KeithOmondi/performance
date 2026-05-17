import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";

/* ─── 1. PREVIEW ─────────────────────────────────────────────────────────────
   Returns a summary of what will be archived — shown to superadmin BEFORE
   they confirm. No data is mutated here.
────────────────────────────────────────────────────────────────────────────── */
export const getArchivePreview = asyncHandler(
  async (req: Request, res: Response) => {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();

    /* Overall counts */
    const countsResult = await pool.query(
      `SELECT
         COUNT(*)::int                                        AS total,
         COUNT(*) FILTER (WHERE status = 'Completed')::int   AS completed,
         COUNT(*) FILTER (WHERE status != 'Completed')::int  AS incomplete
       FROM indicators
       WHERE year = $1`,
      [year]
    );

    /* Incomplete indicators with assignee names */
    const incompleteResult = await pool.query(
      `SELECT
         i.id,
         i.status,
         i.progress,
         i.active_quarter   AS "activeQuarter",
         i.deadline,
         sa.description     AS "activityDescription",
         so.title           AS "objectiveTitle",
         sp.perspective,
         CASE
           WHEN i.assignee_model = 'User' THEN u.name
           ELSE t.name
         END                AS "assigneeName"
       FROM indicators i
       LEFT JOIN users u                 ON i.assignee_id = u.id AND i.assignee_model = 'User'
       LEFT JOIN teams t                 ON i.assignee_id = t.id AND i.assignee_model = 'Team'
       LEFT JOIN strategic_plans sp      ON i.strategic_plan_id = sp.id
       LEFT JOIN strategic_objectives so ON i.objective_id = so.id
       LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
       WHERE i.year = $1 AND i.status != 'Completed'
       ORDER BY sp.perspective, so.title`,
      [year]
    );

    const counts = countsResult.rows[0];

    res.status(200).json({
      success: true,
      data: {
        year,
        summary: {
          total:      counts.total,
          completed:  counts.completed,
          incomplete: counts.incomplete,
        },
        incompleteIndicators: incompleteResult.rows,
      },
    });
  }
);

/* ─── 2. RUN ARCHIVE ─────────────────────────────────────────────────────────
   Archives current year → resets indicators → bumps to new year.
   Everything runs in a single transaction — either all succeeds or nothing.
────────────────────────────────────────────────────────────────────────────── */
export const runArchive = asyncHandler(
  async (req: Request, res: Response) => {
    const { year } = req.body;
    const adminId  = (req as any).user.id;

    if (!year || isNaN(Number(year))) {
      throw new AppError("A valid year is required.", 400);
    }

    const archiveYear = Number(year);
    const nextYear    = archiveYear + 1;

    /* Prevent double-archive */
    const alreadyArchived = await pool.query(
      "SELECT id FROM indicator_archives WHERE year = $1 LIMIT 1",
      [archiveYear]
    );
    if (alreadyArchived.rows.length > 0) {
      throw new AppError(
        `Year ${archiveYear} has already been archived.`,
        400
      );
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      /* ── Step 1: Fetch all indicators for the year with full detail ── */
      const { rows: indicators } = await client.query(
        `SELECT
           i.*,
           sp.perspective,
           so.title           AS objective_title,
           sa.description     AS activity_description,
           CASE
             WHEN i.assignee_model = 'User' THEN u.name
             ELSE t.name
           END                AS assignee_name
         FROM indicators i
         LEFT JOIN users u                 ON i.assignee_id = u.id AND i.assignee_model = 'User'
         LEFT JOIN teams t                 ON i.assignee_id = t.id AND i.assignee_model = 'Team'
         LEFT JOIN strategic_plans sp      ON i.strategic_plan_id = sp.id
         LEFT JOIN strategic_objectives so ON i.objective_id = so.id
         LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
         WHERE i.year = $1`,
        [archiveYear]
      );

      if (indicators.length === 0) {
        throw new AppError(
          `No indicators found for year ${archiveYear}.`,
          404
        );
      }

      /* ── Step 2: For each indicator, snapshot submissions + review history ── */
      for (const ind of indicators) {
        const { rows: submissions } = await client.query(
          `SELECT
             s.*,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id',           sd.id,
                   'evidenceUrl',  sd.evidence_url,
                   'fileType',     sd.file_type,
                   'fileName',     sd.file_name,
                   'uploadedAt',   sd.uploaded_at
                 )
               ) FILTER (WHERE sd.id IS NOT NULL),
               '[]'
             ) AS documents
           FROM submissions s
           LEFT JOIN submission_documents sd ON sd.submission_id = s.id
           WHERE s.indicator_id = $1
           GROUP BY s.id
           ORDER BY s.year, s.quarter`,
          [ind.id]
        );

        const { rows: reviewHistory } = await client.query(
          `SELECT rh.*, u.name AS reviewed_by_name
           FROM review_history rh
           LEFT JOIN users u ON rh.reviewed_by = u.id
           WHERE rh.indicator_id = $1
           ORDER BY rh.at DESC`,
          [ind.id]
        );

        /* ── Step 3: Insert into indicator_archives ── */
        await client.query(
          `INSERT INTO indicator_archives (
             year, archived_at, archived_by,
             indicator_id, activity_id, objective_id, strategic_plan_id,
             assignee_id, assignee_model, assignee_name,
             status, progress, target, unit, weight, reporting_cycle,
             final_achieved, perspective, activity_description, objective_title,
             submissions_snapshot, review_history_snapshot
           ) VALUES (
             $1, NOW(), $2,
             $3, $4, $5, $6,
             $7, $8, $9,
             $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19,
             $20, $21
           )`,
          [
            archiveYear, adminId,
            ind.id, ind.activity_id, ind.objective_id, ind.strategic_plan_id,
            ind.assignee_id, ind.assignee_model, ind.assignee_name,
            ind.status, ind.progress, ind.target, ind.unit, ind.weight,
            ind.reporting_cycle, ind.current_total_achieved,
            ind.perspective, ind.activity_description, ind.objective_title,
            JSON.stringify(submissions),
            JSON.stringify(reviewHistory),
          ]
        );
      }

      const indicatorIds = indicators.map((i: { id: string }) => i.id);

      /* ── Step 4: Delete submissions + documents + review history ── */
      await client.query(
        `DELETE FROM submission_documents
         WHERE submission_id IN (
           SELECT id FROM submissions WHERE indicator_id = ANY($1::uuid[])
         )`,
        [indicatorIds]
      );

      await client.query(
        `DELETE FROM submissions WHERE indicator_id = ANY($1::uuid[])`,
        [indicatorIds]
      );

      await client.query(
        `DELETE FROM review_history WHERE indicator_id = ANY($1::uuid[])`,
        [indicatorIds]
      );

      /* ── Step 5: Reset indicators for new year ── */
      await client.query(
        `UPDATE indicators SET
           status                 = 'Pending',
           progress               = 0,
           active_quarter         = 1,
           current_total_achieved = 0,
           assignee_id            = NULL,
           assignee_model         = 'User',
           assigned_by            = NULL,
           year                   = $1,
           updated_at             = NOW()
         WHERE id = ANY($2::uuid[])`,
        [nextYear, indicatorIds]
      );

      /* ── Step 6: Roll over registry_configurations for next year ── */
      await client.query(
        `INSERT INTO registry_configurations
           (quarter, year, start_date, end_date, is_locked, locked_reason, created_by)
         SELECT
           quarter,
           $1,
           (start_date + INTERVAL '1 year')::date,
           (end_date   + INTERVAL '1 year')::date,
           false,
           '',
           $2
         FROM registry_configurations
         WHERE year = $3
         ON CONFLICT (quarter, year) DO NOTHING`,
        [nextYear, adminId, archiveYear]
      );

      await client.query("COMMIT");

      res.status(200).json({
        success: true,
        message: `Year ${archiveYear} archived successfully. ${nextYear} cycle has begun.`,
        data: {
          archivedYear:      archiveYear,
          nextYear,
          indicatorsArchived: indicators.length,
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
);

/* ─── 3. GET ARCHIVED YEARS LIST ─────────────────────────────────────────────
   Returns a list of years that have been archived, with counts.
────────────────────────────────────────────────────────────────────────────── */
export const getArchivedYears = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT
         year,
         COUNT(*)::int                                           AS total,
         COUNT(*) FILTER (WHERE status = 'Completed')::int      AS completed,
         COUNT(*) FILTER (WHERE status != 'Completed')::int     AS incomplete,
         MIN(archived_at)                                        AS "archivedAt",
         (SELECT name FROM users WHERE id = MAX(archived_by::text)::uuid) AS "archivedBy"
       FROM indicator_archives
       GROUP BY year
       ORDER BY year DESC`
    );

    res.status(200).json({ success: true, data: rows });
  }
);

/* ─── 4. GET ARCHIVE DETAIL FOR A YEAR ───────────────────────────────────────
   Returns full archived indicator data for a specific year.
   Supports filtering by perspective.
────────────────────────────────────────────────────────────────────────────── */
export const getArchiveByYear = asyncHandler(
  async (req: Request, res: Response) => {
    const year = parseInt(req.params.year as string);
    const perspective = req.query.perspective as string | undefined;

    if (isNaN(year)) throw new AppError("Invalid year.", 400);

    let query = `
      SELECT
        ia.*,
        u.name AS "archivedByName"
      FROM indicator_archives ia
      LEFT JOIN users u ON ia.archived_by = u.id
      WHERE ia.year = $1
    `;
    const params: (number | string)[] = [year];

    if (perspective) {
      params.push(perspective);
      query += ` AND ia.perspective = $${params.length}`;
    }

    query += ` ORDER BY ia.perspective, ia.objective_title`;

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      throw new AppError(`No archive found for year ${year}.`, 404);
    }

    res.status(200).json({
      success: true,
      count: rows.length,
      data:  rows,
    });
  }
);