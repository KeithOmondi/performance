import mongoose, { Schema, Document, Model, Types } from "mongoose";

// --- FORCE MODEL REGISTRATION ---
import "./user.model"; 
import StrategicPlan from "../SPlanning/strategicPlan.model";

// ----------------- DOCUMENT INTERFACE -----------------
export interface IDocument {
  evidenceUrl: string;
  evidencePublicId: string;
  fileType: "image" | "video" | "raw";
  fileName?: string;
}

// ----------------- SUBMISSION INTERFACE -----------------
export interface ISubmission {
  _id: Types.ObjectId;
  quarter: 1 | 2 | 3 | 4;
  /** @deprecated Use documents array for multi-file support */
  evidenceUrl?: string;
  /** @deprecated Use documents array for multi-file support */
  evidencePublicId?: string;
  fileType: "image" | "video" | "raw";
  documents: IDocument[]; // Added for multiple file support
  notes: string;
  adminDescriptionEdit?: string;
  submittedAt: Date;
  achievedValue: number;
  isReviewed: boolean;
  reviewStatus: "Pending" | "Accepted" | "Rejected";
  adminComment?: string;
  resubmissionCount: number;
}

// ----------------- INDICATOR INTERFACE -----------------
export interface IIndicator extends Document {
  strategicPlanId: Types.ObjectId;
  objectiveId: Types.ObjectId;
  activityId: Types.ObjectId;
  assignee: any; 
  assignmentType: "User" | "Team"; 
  reportingCycle: "Quarterly" | "Annual";
  weight: number;
  unit: string;
  target: number;
  deadline: Date;
  submissions: mongoose.Types.DocumentArray<ISubmission & mongoose.Document>;
  currentTotalAchieved: number;
  progress: number;
  status:
    | "Pending"
    | "Active"
    | "Partially Complete"
    | "Submitted"
    | "Rejected by Admin"
    | "Awaiting Super Admin"
    | "Reviewed";
  instructions?: string;
  assignedBy: Types.ObjectId;
  adminOverallComments?: string;
  reviewHistory: Array<{
    action: string;
    reason: string;
    reviewedBy: Types.ObjectId;
    at: Date;
  }>;
}

// ----------------- SUBMISSION SCHEMA -----------------
const SubmissionSchema = new Schema<ISubmission>(
  {
    quarter: { type: Number, enum: [1, 2, 3, 4], required: true },
    evidenceUrl: String,
    evidencePublicId: String,
    fileType: {
      type: String,
      enum: ["image", "video", "raw"],
      default: "image",
    },
    // Added documents array schema to store multiple file objects
    documents: [
      {
        evidenceUrl: { type: String, required: true },
        evidencePublicId: { type: String, required: true },
        fileType: { type: String, enum: ["image", "video", "raw"], required: true },
        fileName: String,
      },
    ],
    notes: { type: String, required: true },
    adminDescriptionEdit: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    achievedValue: { type: Number, default: 0 },
    isReviewed: { type: Boolean, default: false },
    reviewStatus: {
      type: String,
      enum: ["Pending", "Accepted", "Rejected"],
      default: "Pending",
    },
    adminComment: String,
    resubmissionCount: { type: Number, default: 0 },
  },
  { _id: true },
);

// ----------------- INDICATOR SCHEMA -----------------
const IndicatorSchema = new Schema<IIndicator>(
  {
    strategicPlanId: {
      type: Schema.Types.ObjectId,
      ref: "StrategicPlan",
      required: true,
    },
    objectiveId: { type: Schema.Types.ObjectId, required: true },
    activityId: { type: Schema.Types.ObjectId, required: true },
    assignee: { 
      type: Schema.Types.Mixed, 
      required: true 
    },
    assignmentType: {
      type: String,
      required: true,
      enum: ["User", "Team"],
      default: "User",
    },
    reportingCycle: {
      type: String,
      enum: ["Quarterly", "Annual"],
      default: "Quarterly",
    },
    weight: { type: Number, default: 5 },
    unit: { type: String, default: "%" },
    target: { type: Number, default: 100 },
    deadline: { type: Date, required: true },
    submissions: [SubmissionSchema],
    currentTotalAchieved: { type: Number, default: 0 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    status: {
      type: String,
      enum: [
        "Pending",
        "Active",
        "Partially Complete",
        "Submitted",
        "Rejected by Admin",
        "Awaiting Super Admin",
        "Reviewed",
      ],
      default: "Pending",
    },
    instructions: String,
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    adminOverallComments: String,
    reviewHistory: [
      {
        action: String,
        reason: String,
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ----------------- RECALCULATION & STATUS LOGIC -----------------
IndicatorSchema.pre("save", async function () {
  if (this.isModified('submissions')) {
    this.currentTotalAchieved = this.submissions.reduce(
      (acc, curr) => acc + (curr.achievedValue || 0),
      0,
    );

    const calculatedProgress =
      this.target > 0 ? (this.currentTotalAchieved / this.target) * 100 : 0;

    this.progress = Math.min(Math.max(calculatedProgress, 0), 100);

    const protectedStatuses = ["Reviewed", "Awaiting Super Admin", "Rejected by Admin"];
    
    if (!protectedStatuses.includes(this.status)) {
      if (this.submissions.length > 0) {
        this.status = this.progress >= 100 ? "Submitted" : "Partially Complete";
      } else {
        this.status = "Active";
      }
    }
  }
});

export const Indicator: Model<IIndicator> =
  mongoose.models.Indicator ||
  mongoose.model<IIndicator>("Indicator", IndicatorSchema);