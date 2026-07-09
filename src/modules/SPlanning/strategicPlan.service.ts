import { pool } from "../../config/db";
import { AppError } from "../../utils/AppError";
import { StrategicPlanModel } from "./strategicPlan.model";

/* ─── STRATEGIC PLAN SERVICES ─────────────────────────────────────────────── */

const createStrategicPlan = async (payload: any, createdBy: string) => {
  // Check if perspective already exists
  const { rows } = await pool.query(
    "SELECT id FROM strategic_plans WHERE perspective = $1",
    [payload.perspective]
  );
  if (rows.length > 0) {
    throw new AppError("A strategic plan with this perspective already exists.", 400);
  }

  return await StrategicPlanModel.createFullPlan(
    payload.perspective,
    createdBy,
    payload.objectives || []
  );
};

const fetchAllStrategicPlans = async () => {
  return await StrategicPlanModel.findAll();
};

const fetchStrategicPlanById = async (id: string) => {
  const plan = await StrategicPlanModel.findById(id);
  if (!plan) throw new AppError("Strategic Plan not found.", 404);
  return plan;
};

const updateStrategicPlan = async (id: string, payload: any) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE strategic_plans 
       SET perspective = COALESCE($1, perspective), updated_at = NOW() 
       WHERE id = $2 RETURNING *`,
      [payload.perspective, id]
    );

    if (result.rows.length === 0) {
      throw new AppError("Strategic Plan not found.", 404);
    }

    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const deleteStrategicPlan = async (id: string) => {
  const result = await pool.query(
    "DELETE FROM strategic_plans WHERE id = $1 RETURNING id", 
    [id]
  );
  
  if (result.rows.length === 0) {
    throw new AppError("Strategic Plan not found.", 404);
  }
};

/* ─── OBJECTIVE SERVICES ──────────────────────────────────────────────────── */

const addObjective = async (planId: string, title: string) => {
  const planCheck = await pool.query(
    "SELECT id FROM strategic_plans WHERE id = $1",
    [planId]
  );
  if (planCheck.rows.length === 0) {
    throw new AppError("Strategic Plan not found.", 404);
  }

  const { rows } = await pool.query(
    `INSERT INTO strategic_objectives (plan_id, title)
     VALUES ($1, $2)
     RETURNING id, plan_id AS "planId", title, created_at AS "createdAt"`,
    [planId, title]
  );
  return rows[0];
};

const updateObjective = async (objectiveId: string, title: string) => {
  const { rows } = await pool.query(
    `UPDATE strategic_objectives
     SET title = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, plan_id AS "planId", title`,
    [title, objectiveId]
  );
  
  if (rows.length === 0) {
    throw new AppError("Objective not found.", 404);
  }
  return rows[0];
};

/* ─── ACTIVITY SERVICES ───────────────────────────────────────────────────── */

const addActivity = async (objectiveId: string, description: string) => {
  const objCheck = await pool.query(
    "SELECT id FROM strategic_objectives WHERE id = $1",
    [objectiveId]
  );
  if (objCheck.rows.length === 0) {
    throw new AppError("Objective not found.", 404);
  }

  // Get max order for this objective
  const orderResult = await pool.query(
    "SELECT COALESCE(MAX(\"order\"), -1) + 1 as next_order FROM strategic_activities WHERE objective_id = $1",
    [objectiveId]
  );
  const nextOrder = orderResult.rows[0].next_order;

  const { rows } = await pool.query(
    `INSERT INTO strategic_activities (objective_id, description, "order")
     VALUES ($1, $2, $3)
     RETURNING id, objective_id AS "objectiveId", description, "order", created_at AS "createdAt"`,
    [objectiveId, description, nextOrder]
  );
  return rows[0];
};

const updateActivity = async (activityId: string, description: string) => {
  const { rows } = await pool.query(
    `UPDATE strategic_activities
     SET description = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, objective_id AS "objectiveId", description, "order"`,
    [description, activityId]
  );
  
  if (rows.length === 0) {
    throw new AppError("Activity not found.", 404);
  }
  return rows[0];
};

const deleteActivity = async (activityId: string) => {
  const result = await pool.query(
    "DELETE FROM strategic_activities WHERE id = $1 RETURNING id",
    [activityId]
  );
  
  if (result.rows.length === 0) {
    throw new AppError("Activity not found.", 404);
  }
  
  // Optionally reorder remaining activities
  // This can be handled by the frontend or a trigger
};

// ─── REORDER ACTIVITIES ─────────────────────────────────────────────────────

const reorderActivities = async (objectiveId: string, activityIds: string[]) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify objective exists
    const objCheck = await client.query(
      "SELECT id FROM strategic_objectives WHERE id = $1",
      [objectiveId]
    );
    if (objCheck.rows.length === 0) {
      throw new AppError("Objective not found.", 404);
    }

    // Update order for each activity
    for (let i = 0; i < activityIds.length; i++) {
      await client.query(
        `UPDATE strategic_activities 
         SET "order" = $1, updated_at = NOW()
         WHERE id = $2 AND objective_id = $3`,
        [i, activityIds[i], objectiveId]
      );
    }

    await client.query("COMMIT");
    return { success: true, message: "Activities reordered successfully" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/* ─── INDICATOR LOOKUP SERVICE ───────────────────────────────────────────── */

const getIndicatorByActivity = async (activityId: string) => {
  const { rows } = await pool.query(
    `SELECT
       i.id,
       i.status,
       i.progress,
       i.target,
       i.unit,
       i.deadline,
       i.assignee_id        AS "assigneeId",
       i.assignee_model     AS "assignmentType",
       i.reporting_cycle    AS "reportingCycle",
       i.active_quarter     AS "activeQuarter",
       CASE
         WHEN i.assignee_model = 'User' THEN u.name
         ELSE t.name
       END                  AS "assigneeDisplayName"
     FROM indicators i
     LEFT JOIN users u ON i.assignee_id = u.id AND i.assignee_model = 'User'
     LEFT JOIN teams t ON i.assignee_id = t.id AND i.assignee_model = 'Team'
     WHERE i.activity_id = $1
       AND i.deleted_at IS NULL`,
    [activityId]
  );
  
  return rows[0] ?? null;
};

/* ─── EXPORTS ──────────────────────────────────────────────────────────────── */

export const StrategicPlanService = {
  // Strategic Plan CRUD
  createStrategicPlan,
  fetchAllStrategicPlans,
  fetchStrategicPlanById,
  updateStrategicPlan,
  deleteStrategicPlan,
  
  // Objectives
  addObjective,
  updateObjective,
  
  // Activities
  addActivity,
  updateActivity,
  deleteActivity,
  reorderActivities,
  
  // Indicator Lookup
  getIndicatorByActivity,
};