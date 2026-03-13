// models/RegistryConfiguration.ts
import mongoose, { Schema, Document } from "mongoose";

export interface IRegistryConfiguration extends Document {
  /** * 0 = Annual cycle registry
   * 1-4 = Quarterly cycle registries 
   */
  quarter: 0 | 1 | 2 | 3 | 4; 
  year: number;
  startDate: Date;
  endDate: Date;
  isLocked: boolean; // Manual emergency lock
}

const RegistryConfigSchema = new Schema<IRegistryConfiguration>({
  // 🔹 Added 0 to the enum to support Annual logic
  quarter: { type: Number, enum: [0, 1, 2, 3, 4], required: true },
  year: { type: Number, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  isLocked: { type: Boolean, default: false },
});

// Ensure only one config exists per quarter/year (e.g., only one "2026 Q0")
RegistryConfigSchema.index({ quarter: 1, year: 1 }, { unique: true });

export const RegistryConfiguration = 
  mongoose.models.RegistryConfiguration || 
  mongoose.model<IRegistryConfiguration>(
    "RegistryConfiguration", 
    RegistryConfigSchema
  );