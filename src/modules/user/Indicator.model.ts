import mongoose, { Schema, Document, Types } from "mongoose";

/* --- SUB-INTERFACES --- */

export interface IDocument {
  evidenceUrl: string;
  evidencePublicId: string;
  fileType: "image" | "video" | "raw";
  fileName?: string;
  uploadedAt: Date;
}

export interface ISubmission {
  _id: Types.ObjectId;
  quarter: 1 | 2 | 3 | 4;
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
    | "Submitted"
    | "Verified"
    | "Approved"
    | "Rejected"
    | "Resubmitted"
    | "Correction Requested";
  reason?: string;
  reviewerRole: "user" | "admin" | "superadmin" | "examiner";
  reviewedBy: Types.ObjectId;
  at: Date;
  // NEW: Allow admin to propose a new deadline for the subsequent period
  nextDeadline?: Date;
}

export interface IIndicator extends Document {
  _id: Types.ObjectId;
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
  assignedBy: Types.ObjectId;
  activeQuarter: 1 | 2 | 3 | 4;
  reviewHistory: IReviewHistory[];
  adminOverallComments?: string;
}

/* --- SCHEMAS --- */

const DocumentSchema = new Schema<IDocument>(
  {
    evidenceUrl: { type: String, required: true },
    evidencePublicId: { type: String, required: true },
    fileType: { type: String, enum: ["image", "video", "raw"], required: true },
    fileName: { type: String, default: "" },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const SubmissionSchema = new Schema<ISubmission>(
  {
    quarter: { type: Number, enum: [1, 2, 3, 4], required: true },
    documents: { type: [DocumentSchema], default: [] },
    notes: { type: String, required: true, trim: true },
    adminDescriptionEdit: { type: String, default: "" },
    submittedAt: { type: Date, default: Date.now },
    achievedValue: { type: Number, default: 0, min: 0 },
    isReviewed: { type: Boolean, default: false },
    reviewStatus: {
      type: String,
      enum: ["Pending", "Verified", "Accepted", "Rejected"],
      default: "Pending",
    },
    adminComment: { type: String, default: "" },
    resubmissionCount: { type: Number, default: 0, min: 0 },
  },
  { _id: true },
);

const ReviewHistorySchema = new Schema<IReviewHistory>(
  {
    action: {
      type: String,
      enum: [
        "Submitted",
        "Verified",
        "Approved",
        "Rejected",
        "Resubmitted",
        "Correction Requested",
      ],
      required: true,
    },
    reason: { type: String, default: "" },
    reviewerRole: {
      type: String,
      enum: ["user", "admin", "superadmin", "examiner"],
      required: true,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
    nextDeadline: { type: Date }, // Stores the date chosen by Super Admin for the next phase
  },
  { _id: true },
);

const IndicatorSchema = new Schema<IIndicator>(
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
      ref: "User",
      required: true,
      index: true,
    },
    assignmentType: { type: String, enum: ["User", "Team"], default: "User" },
    reportingCycle: {
      type: String,
      enum: ["Quarterly", "Annual"],
      default: "Quarterly",
    },
    target: { type: Number, default: 100, min: 0 },
    weight: { type: Number, default: 5, min: 0, max: 100 },
    unit: { type: String, default: "%" },
    deadline: { type: Date, required: true },
    submissions: { type: [SubmissionSchema], default: [] },
    currentTotalAchieved: { type: Number, default: 0, min: 0 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    activeQuarter: { type: Number, enum: [1, 2, 3, 4], default: 1 },
    instructions: { type: String, default: "" },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
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
      index: true,
    },
    reviewHistory: { type: [ReviewHistorySchema], default: [] },
    adminOverallComments: { type: String, default: "" },
  },
  { timestamps: true },
);

/* --- LOGIC ENGINE --- */

IndicatorSchema.pre("save", function () {
  const indicator = this as unknown as IIndicator;

  // 1. CALCULATE PROGRESS
  const acceptedSubmissions = indicator.submissions.filter(
    (s) => s.reviewStatus === "Accepted",
  );
  const totalAchieved = acceptedSubmissions.reduce(
    (acc, curr) => acc + (curr.achievedValue || 0),
    0,
  );

  indicator.currentTotalAchieved = totalAchieved;
  indicator.progress =
    indicator.target > 0
      ? Math.min(Math.round((totalAchieved / indicator.target) * 100), 100)
      : 0;

  // 2. STATE MACHINE
  const latestReview =
    indicator.reviewHistory[indicator.reviewHistory.length - 1];

  if (latestReview) {
    switch (latestReview.action) {
      case "Submitted":
      case "Resubmitted":
        indicator.status = "Awaiting Admin Approval";
        break;

      case "Verified":
        if (latestReview.reviewerRole === "admin") {
          indicator.status = "Awaiting Super Admin";
        }
        break;

      case "Approved":
        if (latestReview.reviewerRole === "superadmin") {
          // LOGIC: Check Cycle & Quarter
          if (indicator.reportingCycle === "Quarterly") {
            if (indicator.activeQuarter < 4) {
              // Reset for next quarter
              indicator.activeQuarter = (indicator.activeQuarter + 1) as
                | 1
                | 2
                | 3
                | 4;
              indicator.status = "Pending"; // Revert to Pending for the new quarter

              // Apply new deadline if provided by Super Admin
              if (latestReview.nextDeadline) {
                indicator.deadline = latestReview.nextDeadline;
              }
            } else {
              // If Q4 is approved, it is finally complete
              indicator.status = "Completed";
            }
          } else {
            // Annual indicators complete immediately
            indicator.status = "Completed";
          }
        }
        break;

      case "Correction Requested":
      case "Rejected":
        indicator.status =
          latestReview.reviewerRole === "superadmin"
            ? "Rejected by Super Admin"
            : "Rejected by Admin";
        break;
    }
  }
});

export const Indicator =
  mongoose.models.Indicator ||
  mongoose.model<IIndicator>("Indicator", IndicatorSchema);
