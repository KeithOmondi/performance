// src/controllers/dashboard.controller.ts
import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { DashboardService } from "./dashboard.service";

export const DashboardController = {
  getStats: asyncHandler(async (_req: Request, res: Response) => {
    const stats = await DashboardService.getDashboardStats();
    res.status(200).json({
      success: true,
      data: stats,
    });
  }),

  getRecentSubmissions: asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const submissions = await DashboardService.getRecentSubmissions(limit);
    res.status(200).json({
      success: true,
      data: submissions,
    });
  }),

  getTeamOverview: asyncHandler(async (_req: Request, res: Response) => {
    const team = await DashboardService.getTeamOverview();
    res.status(200).json({
      success: true,
      data: team,
    });
  }),
};