// models/RegistryConfiguration.ts
import mongoose, { Schema, Document } from "mongoose";

export type RegistryQuarter = 0 | 1 | 2 | 3 | 4;

export interface IRegistryConfiguration extends Document {
  _id: mongoose.Types.ObjectId;
  /**
   * 0 = Annual cycle registry
   * 1–4 = Quarterly cycle registries
   */
  quarter: RegistryQuarter;
  year: number;
  startDate: Date;
  endDate: Date;
  isLocked: boolean;
  lockedReason?: string;
  createdBy: mongoose.Types.ObjectId;
}

const RegistryConfigSchema = new Schema<IRegistryConfiguration>(
  {
    quarter: { type: Number, enum: [0, 1, 2, 3, 4], required: true },
    year: {
      type: Number,
      required: true,
      min: [2020, "Year must be 2020 or later"],
      max: [2100, "Year must be 2100 or earlier"],
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isLocked: { type: Boolean, default: false },
    lockedReason: { type: String, default: "" },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// One config per quarter/year combination
RegistryConfigSchema.index({ quarter: 1, year: 1 }, { unique: true });

// Validate that endDate is always after startDate
RegistryConfigSchema.pre("save", function () {
  if (this.endDate <= this.startDate) {
    throw new Error("End date must be after start date.");
  }
});

export const RegistryConfiguration =
  mongoose.models.RegistryConfiguration ||
  mongoose.model<IRegistryConfiguration>(
    "RegistryConfiguration",
    RegistryConfigSchema
  );