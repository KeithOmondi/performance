// middleware/submissionGuard.ts
import { Request, Response, NextFunction } from "express";
import { RegistryConfiguration } from "../modules/user/RegistryConfiguration";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

export const validateSubmissionWindow = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const { quarter } = req.body;

    // Validate quarter value
    if (!quarter) {
      throw new AppError("Quarter is required to validate submission window.", 400);
    }

    const parsedQuarter = Number(quarter);
    if (![1, 2, 3, 4].includes(parsedQuarter)) {
      throw new AppError("Invalid quarter. Must be 1, 2, 3, or 4.", 400);
    }

    const currentYear = new Date().getFullYear();

    const config = await RegistryConfiguration.findOne({
      quarter: parsedQuarter,
      year: currentYear,
    });

    if (!config) {
      throw new AppError(
        `Submission window for Q${parsedQuarter} ${currentYear} has not been configured by the Registry.`,
        403
      );
    }

    if (config.isLocked) {
      throw new AppError(
        `The submission window for Q${parsedQuarter} ${currentYear} has been locked. Contact the Super Admin.`,
        403
      );
    }

    const now = new Date();
    if (now < config.startDate || now > config.endDate) {
      throw new AppError(
        `The submission window for Q${parsedQuarter} ${currentYear} is closed. ` +
          `Open: ${config.startDate.toDateString()} – ${config.endDate.toDateString()}.`,
        403
      );
    }

    // Attach config to request for downstream use
    (req as any).registryConfig = config;

    next();
  }
);