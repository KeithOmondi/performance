import { pool } from "../../config/db";
import { IRegistryConfiguration, RegistryQuarter } from "../../types/registry.types";


export class RegistryService {
  /**
   * Create or Update a configuration
   * Replaces the .pre("save") hook and uniqueness logic
   */
  static async setConfiguration(data: Partial<IRegistryConfiguration>): Promise<IRegistryConfiguration> {
    // 1. Date Validation (Manual check to provide clean error messages)
    if (data.startDate && data.endDate && new Date(data.endDate) <= new Date(data.startDate)) {
      throw new Error("End date must be after start date.");
    }

    const query = `
      INSERT INTO registry_configurations 
        (quarter, year, start_date, end_date, is_locked, locked_reason, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (quarter, year) 
      DO UPDATE SET 
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        is_locked = EXCLUDED.is_locked,
        locked_reason = EXCLUDED.locked_reason,
        updated_at = NOW()
      RETURNING *;
    `;

    const values = [
      data.quarter,
      data.year,
      data.startDate,
      data.endDate,
      data.isLocked ?? false,
      data.lockedReason || "",
      data.createdBy
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
  }

  /**
   * Helper to check if a specific quarter is currently locked
   */
  static async isQuarterLocked(quarter: RegistryQuarter, year: number): Promise<boolean> {
    const query = `SELECT is_locked FROM registry_configurations WHERE quarter = $1 AND year = $2`;
    const { rows } = await pool.query(query, [quarter, year]);
    return rows.length > 0 ? rows[0].is_locked : false;
  }
}