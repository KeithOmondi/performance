import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { StrategicPlanService } from "./strategicPlan.service";

export const StrategicPlanController = {
  createStrategicPlan: asyncHandler(async (req: Request, res: Response) => {
    const result = await StrategicPlanService.createStrategicPlan(
      req.body,
      (req as any).user.id, // Use the UUID string from the session
    );

    res.status(201).json({
      success: true,
      message: "Strategic Plan created successfully.",
      data: result,
    });
  }),

  fetchAllStrategicPlans: asyncHandler(async (_req: Request, res: Response) => {
    const result = await StrategicPlanService.fetchAllStrategicPlans();
    res.status(200).json({
      success: true,
      count: result.length,
      data: result,
    });
  }),

  fetchStrategicPlanById: asyncHandler(async (req: Request, res: Response) => {
    // Destructure and cast to satisfy TS string requirement
    const { id } = req.params as { id: string };

    const result = await StrategicPlanService.fetchStrategicPlanById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  }),

  updateStrategicPlan: asyncHandler(async (req: Request, res: Response) => {
    // Destructure and cast to string to satisfy TS
    const { id } = req.params as { id: string };

    const result = await StrategicPlanService.updateStrategicPlan(id, req.body);
    res.status(200).json({
      success: true,
      message: "Strategic Plan updated successfully.",
      data: result,
    });
  }),

  deleteStrategicPlan: asyncHandler(async (req: Request, res: Response) => {
    // Alternative fix: Type casting inline
    const id = req.params.id as string;

    await StrategicPlanService.deleteStrategicPlan(id);
    res.status(200).json({
      success: true,
      message: "Strategic Plan deleted successfully.",
    });
  }),
};
