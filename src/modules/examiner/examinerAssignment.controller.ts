import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";

/* ─── SHARED SELECT ───────────────────────────────────────────────────────── */

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
    i.strategic_plan_id      AS "strategicPlanId",
    i.objective_id           AS "objectiveId",
    i.activity_id            AS "activityId",
    i.reporting_cycle        AS "reportingCycle",
    i.active_quarter         AS "activeQuarter",
    i.current_total_achieved AS "currentTotalAchieved",
    i.created_at             AS "createdAt",
    i.updated_at             AS "updatedAt",
    sp.perspective,
    CASE
      WHEN i.assignee_model = 'User' THEN u.name
      ELSE t.name
    END                      AS "assigneeDisplayName",
    sa.description           AS "activityDescription",
    so.title                 AS "objectiveTitle"
  FROM indicators i
  LEFT JOIN users u                ON i.assignee_id = u.id AND i.assignee_model = 'User'
  LEFT JOIN teams t                ON i.assignee_id = t.id AND i.assignee_model = 'Team'
  LEFT JOIN strategic_plans sp     ON i.strategic_plan_id = sp.id
  LEFT JOIN strategic_objectives so ON i.objective_id = so.id
  LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
`;

/* ─── 1. GET ALL ASSIGNMENTS (superadmin view) ───────────────────────────── */
/**
 * Returns every strategic objective with:
 *   - its assigned examiner (if any)
 *   - count of completed indicators inside it
 * Used to power the ExaminerManagement page.
 */
export const getAllExaminerAssignments = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT
        so.id                         AS "objectiveId",
        so.title                      AS "objectiveTitle",
        sp.perspective,
        sp.id                         AS "planId",

        -- assigned examiner (NULL if none)
        efa.id                        AS "assignmentId",
        efa.assigned_at               AS "assignedAt",
        e.id                          AS "examinerId",
        e.name                        AS "examinerName",
        e.email                       AS "examinerEmail",

        -- progress counters
        COUNT(DISTINCT sa.id)::int                                    AS "totalActivities",
        COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'Completed')::int AS "completedCount"

      FROM strategic_objectives so
      JOIN  strategic_plans           sp  ON sp.id  = so.plan_id
      LEFT JOIN strategic_activities  sa  ON sa.objective_id = so.id
      LEFT JOIN indicators            i   ON i.activity_id   = sa.id
      LEFT JOIN examiner_folder_assignments efa ON efa.objective_id = so.id
      LEFT JOIN users                 e   ON e.id = efa.examiner_id

      GROUP BY so.id, so.title, sp.perspective, sp.id,
               efa.id, efa.assigned_at, e.id, e.name, e.email
      ORDER BY sp.perspective, so.title
    `);

    res.status(200).json({ success: true, count: rows.length, data: rows });
  }
);

/* ─── 2. ASSIGN / REASSIGN EXAMINER TO FOLDER ───────────────────────────── */
/**
 * Upserts: if objective already has an examiner, replaces them.
 * Body: { objectiveId, examinerId }
 */
export const assignExaminerToFolder = asyncHandler(
  async (req: Request, res: Response) => {
    const { objectiveId, examinerId } = req.body;
    const adminId = (req as any).user.id;

    if (!objectiveId || !examinerId) {
      throw new AppError("objectiveId and examinerId are required.", 400);
    }

    /* Verify objective exists */
    const objCheck = await pool.query(
      "SELECT id FROM strategic_objectives WHERE id = $1",
      [objectiveId]
    );
    if (objCheck.rows.length === 0) {
      throw new AppError("Objective not found.", 404);
    }

    /* Verify target user is an examiner */
    const userCheck = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1 AND role = 'examiner'",
      [examinerId]
    );
    if (userCheck.rows.length === 0) {
      throw new AppError("User not found or is not an examiner.", 400);
    }

    /* Upsert — ON CONFLICT replaces the existing examiner */
    const { rows } = await pool.query(
      `INSERT INTO examiner_folder_assignments
         (objective_id, examiner_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (objective_id)
       DO UPDATE SET
         examiner_id = EXCLUDED.examiner_id,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = NOW()
       RETURNING *`,
      [objectiveId, examinerId, adminId]
    );

    res.status(200).json({
      success: true,
      message: `Folder assigned to ${userCheck.rows[0].name}.`,
      data: rows[0],
    });
  }
);

/* ─── 3. UNASSIGN EXAMINER FROM FOLDER ──────────────────────────────────── */

export const unassignExaminerFromFolder = asyncHandler(
  async (req: Request, res: Response) => {
    const { objectiveId } = req.params;

    const { rowCount } = await pool.query(
      "DELETE FROM examiner_folder_assignments WHERE objective_id = $1",
      [objectiveId]
    );

    if (rowCount === 0) {
      throw new AppError("No assignment found for this folder.", 404);
    }

    res.status(200).json({ success: true, message: "Examiner unassigned." });
  }
);

/* ─── 4. EXAMINER — GET MY FOLDERS ──────────────────────────────────────── */
/**
 * Called by the examiner role.
 * Returns only the folders assigned to them, with completed indicators inside.
 */
export const getMyExaminerFolders = asyncHandler(
  async (req: Request, res: Response) => {
    const examinerId = (req as any).user.id;

    /* Get assigned objectives */
    const { rows: folders } = await pool.query(
      `SELECT
         so.id          AS "objectiveId",
         so.title       AS "objectiveTitle",
         sp.perspective,
         efa.assigned_at AS "assignedAt"
       FROM examiner_folder_assignments efa
       JOIN strategic_objectives so ON so.id = efa.objective_id
       JOIN strategic_plans      sp ON sp.id = so.plan_id
       WHERE efa.examiner_id = $1
       ORDER BY sp.perspective, so.title`,
      [examinerId]
    );

    if (folders.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const objectiveIds = folders.map((f: { objectiveId: string }) => f.objectiveId);

    /* Get completed indicators for those objectives only */
    const { rows: indicators } = await pool.query(
      `${INDICATOR_SELECT}
       WHERE i.objective_id = ANY($1::uuid[])
         AND i.status = 'Completed'
       ORDER BY i.updated_at DESC`,
      [objectiveIds]
    );

    /* Nest indicators under their objective */
    const indicatorsByObjective: Record<string, typeof indicators> = {};
    indicators.forEach((ind: { objectiveId: string }) => {
      if (!indicatorsByObjective[ind.objectiveId]) {
        indicatorsByObjective[ind.objectiveId] = [];
      }
      indicatorsByObjective[ind.objectiveId].push(ind);
    });

    const data = folders.map((folder: { objectiveId: string }) => ({
      ...folder,
      completedIndicators: indicatorsByObjective[folder.objectiveId] ?? [],
    }));

    res.status(200).json({ success: true, data });
  }
);

/* ─── 5. GET ALL EXAMINERS (for the assignment dropdown) ─────────────────── */

export const getExaminers = asyncHandler(
  async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE role = 'examiner' ORDER BY name`
    );
    res.status(200).json({ success: true, data: rows });
  }
);