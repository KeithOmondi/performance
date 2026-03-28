import mongoose, { Schema, Document } from "mongoose";

export interface IActivity {
  _id?: mongoose.Types.ObjectId;
  description: string;
}

export interface IObjective {
  _id?: mongoose.Types.ObjectId;
  title: string;
  activities: IActivity[];
}

export interface IStrategicPlan extends Document {
  _id: mongoose.Types.ObjectId;
  perspective: string;
  objectives: IObjective[];
  createdBy: mongoose.Types.ObjectId;
}

const ActivitySchema = new Schema<IActivity>(
  {
    description: { type: String, required: true, trim: true },
  },
  { _id: true }
);

const ObjectiveSchema = new Schema<IObjective>(
  {
    title: { type: String, required: true, trim: true },
    activities: { type: [ActivitySchema], default: [] },
  },
  { _id: true }
);

const StrategicPlanSchema = new Schema<IStrategicPlan>(
  {
    perspective: {
      type: String,
      required: [true, "Perspective is required"],
      trim: true,
      // Removed 'index: true' here to stop the duplicate warning
    },
    objectives: { type: [ObjectiveSchema], default: [] },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, any>) {
        ret.__v = undefined;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// This single line handles both the indexing and the unique constraint
StrategicPlanSchema.index({ perspective: 1 }, { unique: true });

export default mongoose.models.StrategicPlan ||
  mongoose.model<IStrategicPlan>("StrategicPlan", StrategicPlanSchema);