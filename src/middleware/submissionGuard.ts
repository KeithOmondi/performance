import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const validateSubmissionWindow = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    // Get quarter from body (for POST) or query (for GET/DELETE if needed)
    const quarter = req.body.quarter || req.query.quarter;

    if (!quarter) {
      throw new AppError("Quarter is required to validate submission window.", 400);
    }

    const parsedQuarter = Number(quarter);
    if (![1, 2, 3, 4].includes(parsedQuarter)) {
      throw new AppError("Invalid quarter. Must be 1, 2, 3, or 4.", 400);
    }

    const currentYear = new Date().getFullYear();

    // 1. Query the registry_configurations table
    const configQuery = `
      SELECT id, quarter, year, start_date, end_date, is_locked, locked_reason
      FROM registry_configurations
      WHERE quarter = $1 AND year = $2
      LIMIT 1
    `;
    
    const { rows } = await pool.query(configQuery, [parsedQuarter, currentYear]);
    const config = rows[0];

    // 2. Verification Logic
    if (!config) {
      throw new AppError(
        `Submission window for Q${parsedQuarter} ${currentYear} has not been configured by the Registry.`,
        403
      );
    }

    if (config.is_locked) {
      throw new AppError(
        `The submission window for Q${parsedQuarter} ${currentYear} has been locked. Reason: ${config.locked_reason || 'Contact Super Admin'}`,
        403
      );
    }

    const now = new Date();
    const startDate = new Date(config.start_date);
    const endDate = new Date(config.end_date);

    if (now < startDate || now > endDate) {
      throw new AppError(
        `The submission window for Q${parsedQuarter} ${currentYear} is closed. ` +
          `Open: ${startDate.toDateString()} – ${endDate.toDateString()}.`,
        403
      );
    }

    // 3. Attach mapped config to request for downstream use (controllers)
    (req as any).registryConfig = {
      id: config.id,
      quarter: config.quarter,
      year: config.year,
      startDate: startDate,
      endDate: endDate,
      isLocked: config.is_locked
    };

    next();
  }
);