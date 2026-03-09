import StrategicPlan, { IStrategicPlan } from "./strategicPlan.model";

const createStrategicPlan = async (payload: IStrategicPlan) => {
  return await StrategicPlan.create(payload);
};

const fetchAllStrategicPlans = async () => {
  return await StrategicPlan.find()
    .sort({ createdAt: -1 })
    .lean();
};

const fetchStrategicPlanById = async (id: string) => {
  const plan = await StrategicPlan.findById(id).lean();
  if (!plan) throw new Error("Strategic Plan not found");
  return plan;
};

const updateStrategicPlan = async (id: string, payload: Partial<IStrategicPlan>) => {
  const updatedPlan = await StrategicPlan.findByIdAndUpdate(
    id,
    { $set: payload }, // Use $set for atomic updates
    {
      new: true,
      runValidators: true,
    }
  ).lean();

  if (!updatedPlan) throw new Error("Strategic Plan not found");
  return updatedPlan;
};

const deleteStrategicPlan = async (id: string) => {
  const deletedPlan = await StrategicPlan.findByIdAndDelete(id).lean();
  if (!deletedPlan) throw new Error("Strategic Plan not found");
  return deletedPlan;
};

export const StrategicPlanService = {
  createStrategicPlan,
  fetchAllStrategicPlans,
  fetchStrategicPlanById,
  updateStrategicPlan,
  deleteStrategicPlan,
};