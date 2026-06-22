import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { StrategicPlanService } from "./strategicPlan.service";
import { AppError } from "../../utils/AppError";

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

  // strategicPlan.controller.ts — add to StrategicPlanController object

  // ─── OBJECTIVES ─────────────────────────────────────────────────────────────

  addObjective: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string }; // planId
    const { title } = req.body;
    if (!title?.trim()) throw new AppError("Objective title is required.", 400);

    const result = await StrategicPlanService.addObjective(id, title.trim());
    res.status(201).json({ success: true, data: result });
  }),

  updateObjective: asyncHandler(async (req: Request, res: Response) => {
    const { objectiveId } = req.params as { objectiveId: string };
    const { title } = req.body;
    if (!title?.trim()) throw new AppError("Objective title is required.", 400);

    const result = await StrategicPlanService.updateObjective(objectiveId, title.trim());
    res.status(200).json({ success: true, data: result });
  }),

  // ─── ACTIVITIES ──────────────────────────────────────────────────────────────

  addActivity: asyncHandler(async (req: Request, res: Response) => {
    const { objectiveId } = req.params as { objectiveId: string };
    const { description } = req.body;
    if (!description?.trim()) throw new AppError("Activity description is required.", 400);

    const result = await StrategicPlanService.addActivity(objectiveId, description.trim());
    res.status(201).json({ success: true, data: result });
  }),

  updateActivity: asyncHandler(async (req: Request, res: Response) => {
    const { activityId } = req.params as { activityId: string };
    const { description } = req.body;
    if (!description?.trim()) throw new AppError("Activity description is required.", 400);

    const result = await StrategicPlanService.updateActivity(activityId, description.trim());
    res.status(200).json({ success: true, data: result });
  }),

  // ─── INDICATOR LOOKUP ────────────────────────────────────────────────────────

  getIndicatorByActivity: asyncHandler(async (req: Request, res: Response) => {
    const { activityId } = req.params as { activityId: string };
    const result = await StrategicPlanService.getIndicatorByActivity(activityId);

    res.status(200).json({
      success: true,
      hasIndicator: result !== null,
      data: result,   // null means no indicator assigned yet — frontend can use this
    });
  }),
};
