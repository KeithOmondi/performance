import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { StrategicPlanService } from "./strategicPlan.service";

const createStrategicPlan = asyncHandler(async (req: Request, res: Response) => {
  const result = await StrategicPlanService.createStrategicPlan(
    req.body,
    req.user!._id.toString()
  );

  res.status(201).json({
    success: true,
    message: "Strategic Plan created successfully.",
    data: result,
  });
});

const fetchAllStrategicPlans = asyncHandler(async (_req: Request, res: Response) => {
  const result = await StrategicPlanService.fetchAllStrategicPlans();

  res.status(200).json({
    success: true,
    count: result.length,
    data: result,
  });
});

const fetchStrategicPlanById = asyncHandler(async (req: Request, res: Response) => {
  const result = await StrategicPlanService.fetchStrategicPlanById(
    req.params.id as string
  );

  res.status(200).json({
    success: true,
    data: result,
  });
});

const updateStrategicPlan = asyncHandler(async (req: Request, res: Response) => {
  const result = await StrategicPlanService.updateStrategicPlan(
    req.params.id as string,
    req.body
  );

  res.status(200).json({
    success: true,
    message: "Strategic Plan updated successfully.",
    data: result,
  });
});

const deleteStrategicPlan = asyncHandler(async (req: Request, res: Response) => {
  await StrategicPlanService.deleteStrategicPlan(req.params.id as string);

  res.status(200).json({
    success: true,
    message: "Strategic Plan deleted successfully.",
  });
});

export const StrategicPlanController = {
  createStrategicPlan,
  fetchAllStrategicPlans,
  fetchStrategicPlanById,
  updateStrategicPlan,
  deleteStrategicPlan,
};