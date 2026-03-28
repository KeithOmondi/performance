import StrategicPlan, { IStrategicPlan } from "./strategicPlan.model";
import { AppError } from "../../utils/AppError";
import mongoose from "mongoose";

const createStrategicPlan = async (
  payload: Partial<IStrategicPlan>,
  createdBy: string
) => {
  return await StrategicPlan.create({ ...payload, createdBy });
};

const fetchAllStrategicPlans = async () => {
  return await StrategicPlan.find()
    .populate("createdBy", "name")
    .sort({ createdAt: -1 })
    .lean();
};

const fetchStrategicPlanById = async (id: string) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid strategic plan ID.", 400);
  }

  const plan = await StrategicPlan.findById(id)
    .populate("createdBy", "name")
    .lean();

  if (!plan) throw new AppError("Strategic Plan not found.", 404);
  return plan;
};

const updateStrategicPlan = async (
  id: string,
  payload: Partial<IStrategicPlan>
) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid strategic plan ID.", 400);
  }

  // Prevent overwriting createdBy
  delete (payload as any).createdBy;

  const updatedPlan = await StrategicPlan.findByIdAndUpdate(
    id,
    { $set: payload },
    { new: true, runValidators: true }
  ).lean();

  if (!updatedPlan) throw new AppError("Strategic Plan not found.", 404);
  return updatedPlan;
};

const deleteStrategicPlan = async (id: string) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid strategic plan ID.", 400);
  }

  const deleted = await StrategicPlan.findByIdAndDelete(id).lean();
  if (!deleted) throw new AppError("Strategic Plan not found.", 404);
};

export const StrategicPlanService = {
  createStrategicPlan,
  fetchAllStrategicPlans,
  fetchStrategicPlanById,
  updateStrategicPlan,
  deleteStrategicPlan,
};