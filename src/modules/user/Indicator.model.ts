import mongoose, { Schema, Document, Types } from "mongoose";

/* --- SUB-INTERFACES --- */

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
  reviewStatus: "Pending" | "Verified" | "Accepted" | "Rejected";
  adminComment?: string;
  resubmissionCount: number;
}

export interface IReviewHistory {
  action:
    | "Verified"
    | "Approved"
    | "Rejected"
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
  submissions: mongoose.Types.DocumentArray<ISubmission>;
  currentTotalAchieved: number;
  progress: number;
  status:
    | "Pending"
    | "Awaiting Admin Approval"
    | "Rejected by Admin"
    | "Awaiting Super Admin"
    | "Rejected by Super Admin"
    | "Completed";
  instructions?: string;
  assignedBy: Types.ObjectId; // Now defined in Schema
  activeQuarter: 0 | 1 | 2 | 3 | 4;
  reviewHistory: IReviewHistory[];
  adminOverallComments?: string;
}

/* --- SCHEMAS --- */

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
    achievedValue: { type: Number, default: 0 },
    isReviewed: { type: Boolean, default: false },
    reviewStatus: {
      type: String,
      enum: ["Pending", "Verified", "Accepted", "Rejected"],
      default: "Pending",
    },
    adminComment: String,
    resubmissionCount: { type: Number, default: 0 },
  },
  { _id: true },
);

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
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "assignmentType",
    },
    assignmentType: { type: String, enum: ["User", "Team"], default: "User" },
    reportingCycle: {
      type: String,
      enum: ["Quarterly", "Annual"],
      default: "Quarterly",
    },
    target: { type: Number, default: 100 },
    weight: { type: Number, default: 5 },
    unit: { type: String, default: "%" },
    deadline: { type: Date, required: true },
    submissions: [SubmissionSchema],
    currentTotalAchieved: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },
    activeQuarter: { type: Number, default: 1 },
    instructions: { type: String, default: "" }, // Added missing field
    assignedBy: { 
      type: Schema.Types.ObjectId, 
      ref: "User", 
      required: true 
    }, // Added missing field to fix StrictPopulateError
    status: {
      type: String,
      enum: [
        "Pending",
        "Awaiting Admin Approval",
        "Rejected by Admin",
        "Awaiting Super Admin",
        "Rejected by Super Admin",
        "Completed",
      ],
      default: "Pending",
    },
    reviewHistory: [
      {
        action: { 
          type: String, 
          enum: ["Verified", "Approved", "Rejected", "Resubmitted", "Correction Requested"] 
        },
        reason: String,
        reviewerRole: { type: String, enum: ["admin", "superadmin", "user"] },
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        at: { type: Date, default: Date.now },
      },
    ],
    adminOverallComments: String,
  },
  { timestamps: true },
);

/* --- THE LOGIC ENGINE --- */

/**
 * Sync hook handles progress math and global status transitions.
 * Since we are using Mongoose 5.x+, async/await replaces the need for next().
 */
IndicatorSchema.pre("save", async function () {
  const indicator = this as IIndicator;

  // 1. PROGRESS CALCULATION
  const certifiedSubmissions = indicator.submissions.filter(
    (s) => s.reviewStatus === "Accepted",
  );
  
  const totalAchieved = certifiedSubmissions.reduce(
    (acc, curr) => acc + (curr.achievedValue || 0),
    0,
  );

  indicator.currentTotalAchieved = totalAchieved;
  if (indicator.target > 0) {
    indicator.progress = Math.min(
      (totalAchieved / indicator.target) * 100,
      100,
    );
  }

  // 2. STATE TRANSITION MACHINE
  const latestReview = indicator.reviewHistory[indicator.reviewHistory.length - 1];

  if (latestReview) {
    switch (latestReview.action) {
      case "Verified":
        if (latestReview.reviewerRole === "admin") {
          indicator.status = "Awaiting Super Admin";
        }
        break;

      case "Approved":
        if (latestReview.reviewerRole === "superadmin") {
          indicator.status = "Completed";
        }
        break;

      case "Correction Requested":
      case "Rejected":
        indicator.status =
          latestReview.reviewerRole === "superadmin"
            ? "Rejected by Super Admin"
            : "Rejected by Admin";
        break;

      case "Resubmitted":
        indicator.status = "Awaiting Admin Approval";
        break;
    }
  }

  // 3. FRESH SUBMISSION OVERRIDE
  // If user adds a new submission but hasn't had a "Resubmitted" action logged yet
  const hasFreshUpload = indicator.submissions.some((s) => s.reviewStatus === "Pending");
  const isTerminal = ["Awaiting Super Admin", "Completed", "Rejected by Super Admin", "Rejected by Admin"].includes(indicator.status);

  if (hasFreshUpload && !isTerminal) {
    indicator.status = "Awaiting Admin Approval";
  }
});

export const Indicator =
  mongoose.models.Indicator ||
  mongoose.model<IIndicator>("Indicator", IndicatorSchema);