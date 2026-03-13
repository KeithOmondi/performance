import mongoose, { Schema, Document, Model, Types } from "mongoose";

// --- REGISTRY CONFIGURATION ---

export interface IRegistryConfiguration extends Document {
  quarter: 0 | 1 | 2 | 3 | 4; // 0 for Annual
  year: number;
  startDate: Date;
  endDate: Date;
  isLocked: boolean;
}

const RegistryConfigurationSchema = new Schema<IRegistryConfiguration>({
  quarter: { type: Number, enum: [0, 1, 2, 3, 4], required: true },
  year: { type: Number, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  isLocked: { type: Boolean, default: false },
});

export const RegistryConfiguration =
  mongoose.models.RegistryConfiguration ||
  mongoose.model<IRegistryConfiguration>(
    "RegistryConfiguration",
    RegistryConfigurationSchema,
  );

// --- INDICATOR INTERFACES ---

export interface IDocument {
  evidenceUrl: string;
  evidencePublicId: string;
  fileType: "image" | "video" | "raw";
  fileName?: string;
}

export interface ISubmission {
  _id: Types.ObjectId;
  quarter: 0 | 1 | 2 | 3 | 4;
  documents: IDocument[];
  notes: string;
  adminDescriptionEdit?: string;
  submittedAt: Date;
  achievedValue: number;
  isReviewed: boolean;
  reviewStatus: "Pending" | "Accepted" | "Rejected";
  adminComment?: string;
  resubmissionCount: number;
}

export interface IReviewHistory {
  action:
    | "Approved"
    | "Rejected"
    | "Verified"
    | "Resubmitted"
    | "Correction Requested";
  reason: string;
  reviewerRole: "admin" | "superadmin" | "user";
  reviewedBy: Types.ObjectId;
  at: Date;
}

export interface IIndicator extends Document {
  strategicPlanId: Types.ObjectId;
  objectiveId: Types.ObjectId;
  activityId: Types.ObjectId;
  assignee: Types.ObjectId;
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
    | "Awaiting Admin Approval"
    | "Rejected by Admin"
    | "Awaiting Super Admin"
    | "Rejected by Super Admin"
    | "Partially Approved"
    | "Completed";
  instructions?: string;
  assignedBy: Types.ObjectId;
  activeQuarter: 0 | 1 | 2 | 3 | 4;
  reviewHistory: IReviewHistory[];
  adminOverallComments?: string;
}

interface IIndicatorModel extends Model<IIndicator> {
  calculateProgress(indicatorId: Types.ObjectId): Promise<IIndicator | null>;
}

// --- SCHEMAS ---

const SubmissionSchema = new Schema<ISubmission>(
  {
    quarter: { type: Number, enum: [0, 1, 2, 3, 4], required: true },
    documents: [
      {
        evidenceUrl: { type: String, required: true },
        evidencePublicId: { type: String, required: true },
        fileType: {
          type: String,
          enum: ["image", "video", "raw"],
          required: true,
        },
        fileName: String,
      },
    ],
    notes: { type: String, required: true },
    adminDescriptionEdit: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    achievedValue: { type: Number, default: 0, min: 0 },
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

const IndicatorSchema = new Schema<IIndicator, IIndicatorModel>(
  {
    strategicPlanId: {
      type: Schema.Types.ObjectId,
      ref: "StrategicPlan",
      required: true,
      index: true,
    },
    objectiveId: { type: Schema.Types.ObjectId, required: true, index: true },
    activityId: { type: Schema.Types.ObjectId, required: true },
    assignee: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "assignmentType",
      index: true,
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
    activeQuarter: { type: Number, enum: [0, 1, 2, 3, 4], default: 1 },
    status: {
      type: String,
      enum: [
        "Pending",
        "Awaiting Admin Approval",
        "Rejected by Admin",
        "Awaiting Super Admin",
        "Rejected by Super Admin",
        "Partially Approved",
        "Completed",
      ],
      default: "Pending",
      index: true,
    },
    instructions: String,
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reviewHistory: [
      {
        action: String,
        reason: String,
        reviewerRole: String,
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        at: { type: Date, default: Date.now },
      },
    ],
    adminOverallComments: String,
  },
  { timestamps: true },
);

// --- LOGIC ENGINE ---

IndicatorSchema.statics.calculateProgress = async function (
  indicatorId: Types.ObjectId,
) {
  const indicator = await this.findById(indicatorId);
  if (!indicator) return null;

  // 1. Only count values that have been formally accepted by the registry
  const acceptedSubmissions = indicator.submissions.filter(
    (s) => s.reviewStatus === "Accepted",
  );

  const totalAchieved = acceptedSubmissions.reduce(
    (acc, curr) => acc + (curr.achievedValue || 0),
    0,
  );

  indicator.currentTotalAchieved = totalAchieved;
  const rawProgress =
    indicator.target > 0 ? (totalAchieved / indicator.target) * 100 : 0;
  indicator.progress = Math.min(Math.round(rawProgress * 100) / 100, 100);

  // 2. Certification Chain Logic
  const latestReview =
    indicator.reviewHistory[indicator.reviewHistory.length - 1];

  if (latestReview) {
    if (latestReview.action === "Approved") {
      // 🔹 Only the Super Admin can move an indicator to "Completed"
      if (latestReview.reviewerRole === "superadmin") {
        indicator.status = "Completed";
      } else {
        // Admin approval moves it to the next desk in the hierarchy
        indicator.status = "Awaiting Super Admin";
      }
    } else if (latestReview.action === "Rejected") {
      indicator.status =
        latestReview.reviewerRole === "superadmin"
          ? "Rejected by Super Admin"
          : "Rejected by Admin";
    }
  }

  // 🔹 Guard: If there are pending submissions and no final approval,
  // ensure the status stays in the review pipeline.
  const hasPendingSubmissions = indicator.submissions.some(
    (s) => s.reviewStatus === "Pending",
  );
  if (hasPendingSubmissions && indicator.status === "Pending") {
    indicator.status = "Awaiting Admin Approval";
  }

  return await indicator.save();
};

export const Indicator =
  (mongoose.models.Indicator as IIndicatorModel) ||
  mongoose.model<IIndicator, IIndicatorModel>("Indicator", IndicatorSchema);
