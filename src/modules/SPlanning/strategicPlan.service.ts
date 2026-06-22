import { pool } from "../../config/db";
import { AppError } from "../../utils/AppError";
import { StrategicPlanModel } from "./strategicPlan.model";

/* ─── STRATEGIC PLAN SERVICES ─────────────────────────────────────────────── */

const createStrategicPlan = async (payload: any, createdBy: string) => {
  // Check if perspective already exists (Postgres UNIQUE constraint would also catch this)
  const { rows } = await pool.query(
    "SELECT id FROM strategic_plans WHERE perspective = $1",
    [payload.perspective]
  );
  if (rows.length > 0) {
    throw new AppError("A strategic plan with this perspective already exists.", 400);
  }

  // Use the Transactional create method from our Model
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

    // 1. Update the main plan details
    const result = await client.query(
      `UPDATE strategic_plans 
       SET perspective = COALESCE($1, perspective), updated_at = NOW() 
       WHERE id = $2 RETURNING *`,
      [payload.perspective, id]
    );

    if (result.rows.length === 0) {
      throw new AppError("Strategic Plan not found.", 404);
    }

    /**
     * NOTE: For nested objectives/activities update logic:
     * In a relational DB, you usually handle these via separate endpoints 
     * (e.g., PUT /objectives/:id) rather than replacing the whole array.
     * For now, we return the updated parent record.
     */

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
  // PostgreSQL handles deleting objectives and activities automatically 
  // because we set 'ON DELETE CASCADE' in the schema.
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

  const { rows } = await pool.query(
    `INSERT INTO strategic_activities (objective_id, description)
     VALUES ($1, $2)
     RETURNING id, objective_id AS "objectiveId", description, created_at AS "createdAt"`,
    [objectiveId, description]
  );
  return rows[0];
};

const updateActivity = async (activityId: string, description: string) => {
  const { rows } = await pool.query(
    `UPDATE strategic_activities
     SET description = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, objective_id AS "objectiveId", description`,
    [description, activityId]
  );
  
  if (rows.length === 0) {
    throw new AppError("Activity not found.", 404);
  }
  return rows[0];
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
  
  // Returns null if no indicator assigned yet — that's valid
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
  
  // Indicator Lookup
  getIndicatorByActivity,
};