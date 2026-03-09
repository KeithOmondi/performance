import mongoose, { Schema, Document } from "mongoose";

// 1. Updated Activity Interface to include the optional _id from Mongoose
interface IActivity {
  _id?: mongoose.Types.ObjectId; 
  description: string;
}

interface IObjective {
  _id?: mongoose.Types.ObjectId;
  title: string;
  activities: IActivity[];
}

export interface IStrategicPlan extends Document {
  perspective: string;
  objectives: IObjective[];
}

// 2. Explicitly ensure _id is true (default is true, but good for clarity)
const ActivitySchema = new Schema<IActivity>({
  description: { type: String, required: true },
}, { _id: true }); 

const ObjectiveSchema = new Schema<IObjective>({
  title: { type: String, required: true },
  activities: [ActivitySchema],
}, { _id: true });

const StrategicPlanSchema = new Schema<IStrategicPlan>(
  {
    perspective: { type: String, required: true },
    objectives: [ObjectiveSchema],
  },
  { 
    timestamps: true,
    toJSON: { 
      virtuals: true, 
      transform: (doc, ret) => { 
        const { __v, ...rest } = ret; 
        return rest; 
      } 
    },
    toObject: { virtuals: true }
  }
);

export default mongoose.model<IStrategicPlan>(
  "StrategicPlan",
  StrategicPlanSchema,
);