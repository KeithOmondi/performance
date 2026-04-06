import { Request, Response } from "express";
import { pool } from "../../config/db";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";

/**
 * @desc    Get Registry Status for current year
 */
export const getRegistryStatus = asyncHandler(async (_req: Request, res: Response) => {
  const currentYear = new Date().getFullYear();
  const now = new Date();

  const query = `
    SELECT 
      rc.*, 
      u.name as "createdByName", 
      u.email as "createdByEmail"
    FROM registry_configurations rc
    LEFT JOIN users u ON rc.created_by = u.id
    WHERE rc.year = $1
    ORDER BY rc.quarter ASC
  `;

  const { rows } = await pool.query(query, [currentYear]);

  const enriched = rows.map((doc) => {
    const startDate = new Date(doc.start_date);
    const endDate = new Date(doc.end_date);

    return {
      ...doc,
      // Map snake_case to camelCase for frontend consistency
      startDate,
      endDate,
      isLocked: doc.is_locked,
      lockedReason: doc.locked_reason,
      // Business Logic
      isOpen: !doc.is_locked && now >= startDate && now <= endDate,
      isExpired: now > endDate,
      isUpcoming: now < startDate,
    };
  });

  res.status(200).json({
    success: true,
    count: enriched.length,
    data: enriched,
  });
});

/**
 * @desc    Initialize or Update Registry Window (Upsert)
 */
export const configureRegistry = asyncHandler(async (req: Request, res: Response) => {
  const { quarter, year, startDate, endDate, isLocked, lockedReason } = req.body;
  const adminId = (req as any).user.id;

  if (quarter === undefined || !year || !startDate || !endDate) {
    throw new AppError("All configuration fields are required.", 400);
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new AppError("Invalid date format.", 400);
  if (end <= start) throw new AppError("Closing date must be after opening date.", 400);

  // PostgreSQL Upsert using ON CONFLICT
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
      created_by = EXCLUDED.created_by,
      updated_at = NOW()
    RETURNING *
  `;

  const { rows } = await pool.query(query, [
    Number(quarter),
    Number(year),
    start,
    end,
    isLocked ?? false,
    isLocked ? (lockedReason || "Administrative Lock") : "",
    adminId
  ]);

  res.status(200).json({
    success: true,
    message: `Registry window for Q${quarter} ${year} updated.`,
    data: rows[0],
  });
});

/**
 * @desc    Toggle Registry Lock
 */
export const toggleRegistryLock = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { lockedReason } = req.body;
  const adminId = (req as any).user.id;

  const { rows } = await pool.query("SELECT * FROM registry_configurations WHERE id = $1", [id]);
  const config = rows[0];

  if (!config) throw new AppError("Registry entry not found.", 404);

  const currentlyLocked = config.is_locked;
  if (!currentlyLocked && (!lockedReason || lockedReason.trim().length < 5)) {
    throw new AppError("A reason (min 5 chars) is required to lock the registry.", 400);
  }

  const updateQuery = `
    UPDATE registry_configurations 
    SET is_locked = $1, locked_reason = $2, created_by = $3, updated_at = NOW()
    WHERE id = $4 
    RETURNING *
  `;

  const updated = await pool.query(updateQuery, [
    !currentlyLocked,
    !currentlyLocked ? lockedReason.trim() : "",
    adminId,
    id
  ]);

  res.status(200).json({
    success: true,
    message: `Registry Q${config.quarter} is now ${!currentlyLocked ? "SECURED" : "RELEASED"}.`,
    data: updated.rows[0],
  });
});

/**
 * @desc    Delete a configuration
 */
export const deleteRegistryConfig = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows } = await pool.query("SELECT * FROM registry_configurations WHERE id = $1", [id]);
  const config = rows[0];

  if (!config) throw new AppError("Configuration not found.", 404);

  const now = new Date();
  const start = new Date(config.start_date);
  const end = new Date(config.end_date);

  if (now >= start && now <= end && !config.is_locked) {
    throw new AppError("Cannot delete an active, unlocked registry window.", 400);
  }

  await pool.query("DELETE FROM registry_configurations WHERE id = $1", [id]);

  res.status(200).json({
    success: true,
    message: "Registry configuration removed successfully.",
  });
});