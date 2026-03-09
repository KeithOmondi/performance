import { Request, Response, NextFunction } from "express";
import { StrategicPlanService } from "./strategicPlan.service";

const createStrategicPlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await StrategicPlanService.createStrategicPlan(req.body);

    res.status(201).json({
      success: true,
      message: "Strategic Plan created",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const fetchAllStrategicPlans = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await StrategicPlanService.fetchAllStrategicPlans();

    res.status(200).json({
      success: true,
      count: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const fetchStrategicPlanById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const result = await StrategicPlanService.fetchStrategicPlanById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const updateStrategicPlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const result = await StrategicPlanService.updateStrategicPlan(id, req.body);

    res.status(200).json({
      success: true,
      message: "Strategic Plan updated",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const deleteStrategicPlan = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    await StrategicPlanService.deleteStrategicPlan(id);

    res.status(200).json({
      success: true,
      message: "Strategic Plan deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const StrategicPlanController = {
  createStrategicPlan,
  fetchAllStrategicPlans,
  fetchStrategicPlanById,
  updateStrategicPlan,
  deleteStrategicPlan,
};