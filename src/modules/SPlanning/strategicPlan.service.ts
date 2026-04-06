import { pool } from "../../config/db";
import { AppError } from "../../utils/AppError";
import { StrategicPlanModel } from "./strategicPlan.model";

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

    if (result.rows.length === 0) throw new AppError("Strategic Plan not found.", 404);

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
  const result = await pool.query("DELETE FROM strategic_plans WHERE id = $1 RETURNING id", [id]);
  
  if (result.rows.length === 0) {
    throw new AppError("Strategic Plan not found.", 404);
  }
};

export const StrategicPlanService = {
  createStrategicPlan,
  fetchAllStrategicPlans,
  fetchStrategicPlanById,
  updateStrategicPlan,
  deleteStrategicPlan,
};