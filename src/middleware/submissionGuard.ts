// middleware/submissionGuard.ts
import { Request, Response, NextFunction } from "express";
import { RegistryConfiguration } from "../modules/user/RegistryConfiguration";

export const validateSubmissionWindow = async (req: Request, res: Response, next: NextFunction) => {
  const { quarter } = req.body; // Quarter being submitted
  const currentYear = new Date().getFullYear();

  const config = await RegistryConfiguration.findOne({ 
    quarter, 
    year: currentYear 
  });

  if (!config) {
    return res.status(403).json({ 
      message: `Submission dates for Q${quarter} have not been set by the Registry.` 
    });
  }

  const now = new Date();
  const isWithinWindow = now >= config.startDate && now <= config.endDate;

  if (!isWithinWindow || config.isLocked) {
    return res.status(403).json({ 
      message: `The Registry for Q${quarter} is currently closed. Contact the Super Admin.` 
    });
  }

  next();
};