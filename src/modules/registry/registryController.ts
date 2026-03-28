import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { RegistryConfiguration } from "../user/RegistryConfiguration";
import mongoose from "mongoose";

/**
 * @desc    Get Registry Status for current year
 * @route   GET /api/v1/registry/status
 * @access  Private (All Authenticated)
 */
export const getRegistryStatus = asyncHandler(
  async (_req: Request, res: Response) => {
    const currentYear = new Date().getFullYear();
    const now = new Date();

    const configs = await RegistryConfiguration.find({ year: currentYear })
      .sort({ quarter: 1 })
      .populate("createdBy", "name email");

    const enriched = configs.map((c) => {
      const doc = c.toObject();
      return {
        ...doc,
        // Business Logic: Window is open ONLY if not locked AND current date is within range
        isOpen: !doc.isLocked && now >= doc.startDate && now <= doc.endDate,
        // Status helper for the UI
        isExpired: now > doc.endDate,
        isUpcoming: now < doc.startDate
      };
    });

    res.status(200).json({
      success: true,
      count: enriched.length,
      data: enriched,
    });
  }
);

/**
 * @desc    Initialize or Update Registry Window
 * @route   POST /api/v1/registry/configure
 * @access  Private (SuperAdmin)
 */
export const configureRegistry = asyncHandler(
  async (req: Request, res: Response) => {
    const { quarter, year, startDate, endDate, isLocked, lockedReason } = req.body;

    // 1. Validation
    if (quarter === undefined || !year || !startDate || !endDate) {
      throw new AppError("All configuration fields (quarter, year, dates) are required.", 400);
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new AppError("Invalid date format provided.", 400);
    }

    if (end <= start) {
      throw new AppError("Registry closing date must be after the opening date.", 400);
    }

    // 2. Database Operation (Atomic Upsert)
    // We use findOneAndUpdate with upsert:true to ensure only one config exists per Q/Year
    const config = await RegistryConfiguration.findOneAndUpdate(
      { 
        quarter: Number(quarter), 
        year: Number(year) 
      },
      {
        startDate: start,
        endDate: end,
        isLocked: isLocked ?? false,
        lockedReason: isLocked ? (lockedReason || "Administrative Lock") : "",
        createdBy: req.user!._id, // Set by auth middleware
      },
      { 
        new: true, 
        upsert: true, 
        runValidators: true,
        setDefaultsOnInsert: true 
      }
    );

    res.status(200).json({
      success: true,
      message: `Registry window for Q${quarter} ${year} has been updated.`,
      data: config,
    });
  }
);

/**
 * @desc    Toggle Registry Lock (Emergency or Audit Lock)
 * @route   PATCH /api/v1/registry/lock/:id
 * @access  Private (Admin/SuperAdmin)
 */
export const toggleRegistryLock = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { lockedReason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid Registry Configuration ID.", 400);
    }

    const config = await RegistryConfiguration.findById(id);
    if (!config) {
      throw new AppError("Registry entry not found.", 404);
    }

    // Logic: If we are locking it, we MUST have a reason
    const currentlyLocked = config.isLocked;
    if (!currentlyLocked && (!lockedReason || lockedReason.trim().length < 5)) {
      throw new AppError("Please provide a valid reason (min 5 chars) for locking this registry.", 400);
    }

    config.isLocked = !currentlyLocked;
    config.lockedReason = !currentlyLocked ? lockedReason.trim() : "";
    
    // Track who performed the last lock/unlock action
    config.createdBy = req.user!._id; 

    await config.save();

    res.status(200).json({
      success: true,
      message: `Registry Q${config.quarter} is now ${config.isLocked ? "SECURED" : "RELEASED"}.`,
      data: config,
    });
  }
);

/**
 * @desc    Delete a configuration (Only if not yet active)
 * @route   DELETE /api/v1/registry/:id
 * @access  Private (SuperAdmin)
 */
export const deleteRegistryConfig = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const config = await RegistryConfiguration.findById(id);
    if (!config) throw new AppError("Configuration not found.", 404);

    // Safety: Don't allow deleting a window that is currently "Live"
    const now = new Date();
    if (now >= config.startDate && now <= config.endDate && !config.isLocked) {
      throw new AppError("Cannot delete an active, unlocked registry window.", 400);
    }

    await RegistryConfiguration.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "Registry configuration removed successfully.",
    });
  }
);