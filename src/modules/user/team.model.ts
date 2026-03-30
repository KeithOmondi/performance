import mongoose, { Document, Model, Schema, Types } from "mongoose";

/* ------------------------------------------------------------------ */
/*  Interface                                                           */
/* ------------------------------------------------------------------ */
export interface ITeam extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  teamLead: Types.ObjectId;   // ref → User
  members: Types.ObjectId[];  // ref → User (always includes the lead)
  createdBy: Types.ObjectId;  // ref → User (superadmin who created it)
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                              */
/* ------------------------------------------------------------------ */
const TeamSchema = new Schema<ITeam>(
  {
    name: {
      type: String,
      required: [true, "Team name is required"],
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    teamLead: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Team lead is required"],
    },
    members: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
      validate: {
        validator(v: Types.ObjectId[]) {
          return v.length > 0;
        },
        message: "A team must have at least one member.",
      },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

/* ------------------------------------------------------------------ */
/*  Pre-save: guarantee teamLead is always inside members[]           */
/* ------------------------------------------------------------------ */
TeamSchema.pre("save", function () {
  const team = this as ITeam;
  const leadStr = team.teamLead.toString();
  const alreadyMember = team.members.some((m) => m.toString() === leadStr);
  if (!alreadyMember) {
    team.members.push(team.teamLead);
  }
});

/* ------------------------------------------------------------------ */
/*  Export                                                              */
/* ------------------------------------------------------------------ */
export const Team: Model<ITeam> =
  mongoose.models.Team || mongoose.model<ITeam>("Team", TeamSchema);