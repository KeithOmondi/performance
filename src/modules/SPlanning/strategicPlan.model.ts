import { pool } from "../../config/db";
import { IStrategicPlan } from "../../types/plan.types";
import { activityOrderSql, perspectiveRankSql } from "../../utils/pmmuOrder";

export const StrategicPlanModel = {
  /**
   * Create a full nested Strategic Plan
   */
  async createFullPlan(
    perspective: string,
    createdBy: string,
    objectives: any[]
  ): Promise<IStrategicPlan> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1. Insert the Plan
      const planRes = await client.query(
        `INSERT INTO strategic_plans (perspective, created_by) 
         VALUES ($1, $2) RETURNING id, perspective, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [perspective, createdBy]
      );
      const plan = planRes.rows[0];

      // 2. Insert Objectives and nested Activities
      for (const [objIndex, obj] of objectives.entries()) {
        const objRes = await client.query(
          `INSERT INTO strategic_objectives (plan_id, title, sort_order) 
           VALUES ($1, $2, $3) RETURNING id`,
          [plan.id, obj.title, objIndex + 1]
        );
        const objectiveId = objRes.rows[0].id;

        if (obj.activities && Array.isArray(obj.activities)) {
          for (const [actIndex, act] of obj.activities.entries()) {
            // Check if act is a string (from seed) or object (from frontend)
            const description = typeof act === "string" ? act : act.description;
            await client.query(
              `INSERT INTO strategic_activities (objective_id, description, "order") 
               VALUES ($1, $2, $3)`,
              [objectiveId, description, actIndex]
            );
          }
        }
      }

      await client.query("COMMIT");
      return plan;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Find all plans with full nested JSON hierarchy
   * FIXED: Now includes the 'objectives' array so the frontend has data to map over.
   */
  async findAll(): Promise<any[]> {
    const query = `
      SELECT 
        sp.id,
        sp.perspective,
        sp.created_at AS "createdAt",
        sp.updated_at AS "updatedAt",
        u.name as "createdByName",
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', so.id,
              'title', so.title,
              'activities', (
                SELECT COALESCE(json_agg(json_build_object(
                  'id', sa.id,
                  'description', sa.description
                ) ORDER BY ${activityOrderSql("sa")}), '[]'::json)
                FROM strategic_activities sa 
                WHERE sa.objective_id = so.id
              )
            ) ORDER BY so.sort_order NULLS LAST, so.created_at, so.title)
            FROM strategic_objectives so
            WHERE so.plan_id = sp.id
          ), 
          '[]'::json
        ) as objectives,
        (SELECT COUNT(*) FROM strategic_objectives WHERE plan_id = sp.id) as "objectiveCount"
      FROM strategic_plans sp
      LEFT JOIN users u ON sp.created_by = u.id
      ORDER BY ${perspectiveRankSql("sp.perspective")}, sp.perspective ASC
    `;
    const { rows } = await pool.query(query);
    return rows;
  },

  /**
   * Find a single plan with full nested JSON hierarchy
   */
  async findById(id: string): Promise<IStrategicPlan | null> {
    const query = `
      SELECT 
        sp.id,
        sp.perspective,
        sp.created_at AS "createdAt",
        sp.updated_at AS "updatedAt",
        (
          SELECT json_agg(json_build_object(
            'id', so.id,
            'title', so.title,
            'activities', (
              SELECT json_agg(json_build_object(
                'id', sa.id,
                'description', sa.description
              ) ORDER BY ${activityOrderSql("sa")})
              FROM strategic_activities sa 
              WHERE sa.objective_id = so.id
            )
          ) ORDER BY so.sort_order NULLS LAST, so.created_at, so.title)
          FROM strategic_objectives so
          WHERE so.plan_id = sp.id
        ) as objectives
      FROM strategic_plans sp
      WHERE sp.id = $1
    `;
    const { rows } = await pool.query(query, [id]);
    return rows[0] || null;
  }
};