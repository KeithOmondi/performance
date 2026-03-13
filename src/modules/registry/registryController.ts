import { Request, Response } from "express";
import { RegistryConfiguration } from "../user/RegistryConfiguration";

/**
 * @desc    Get Current Registry Status (Public/User)
 * @route   GET /api/registry/status
 * @access  All Authenticated Users
 */
export const getRegistryStatus = async (req: Request, res: Response) => {
  try {
    const currentYear = new Date().getFullYear();
    // Get all configurations for the current year
    const configs = await RegistryConfiguration.find({ year: currentYear }).sort({ quarter: 1 });
    
    res.status(200).json({
      success: true,
      data: configs,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Configure Registry Window (Open/Edit Quarter)
 * @route   POST /api/registry/configure
 * @access  Super Admin Only
 */
export const configureRegistry = async (req: Request, res: Response) => {
  try {
    const { quarter, year, startDate, endDate, isLocked } = req.body;

    // Use findOneAndUpdate with upsert to create or update the config
    const config = await RegistryConfiguration.findOneAndUpdate(
      { quarter, year },
      { 
        startDate: new Date(startDate), 
        endDate: new Date(endDate), 
        isLocked: isLocked ?? false 
      },
      { new: true, upsert: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: `Quarter ${quarter} registry updated successfully.`,
      data: config
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Emergency Toggle Lock (Quick Freeze)
 * @route   PATCH /api/registry/toggle-lock/:id
 * @access  Super Admin / Admin
 */
export const toggleRegistryLock = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const config = await RegistryConfiguration.findById(id);

    if (!config) {
      return res.status(404).json({ success: false, message: "Configuration not found" });
    }

    config.isLocked = !config.isLocked;
    await config.save();

    res.status(200).json({
      success: true,
      message: `Quarter ${config.quarter} is now ${config.isLocked ? "LOCKED" : "UNLOCKED"}.`,
      data: config
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};