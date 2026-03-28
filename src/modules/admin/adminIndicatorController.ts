import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { Indicator } from "../user/Indicator.model";
import { User } from "../user/user.model";
import { sendMail } from "../../utils/sendMail";
import {
  submissionRejectedTemplate,
  superAdminReviewNeededTemplate,
} from "../../utils/mailTemplates";
import mongoose from "mongoose";

// ─── Data Transformer (Enhanced for Lean Objects & Nested Documents) ──────────
const transformIndicator = (ind: any) => {
  if (!ind) return null;
  const indObj = typeof ind.toObject === "function" ? ind.toObject() : ind;
  const plan = indObj.strategicPlanId;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id?.toString() === indObj.objectiveId?.toString()
  );

  const activity = objective?.activities?.find(
    (act: any) => act._id?.toString() === indObj.activityId?.toString()
  );

  return {
    ...indObj,
    _id: indObj._id.toString(),
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: indObj.assignee?.name || "Unassigned",
    // FIX: Deep map submissions to ensure documents array is always present
    submissions: (indObj.submissions || []).map((sub: any) => ({
      ...sub,
      _id: sub._id?.toString(),
      documents: sub.documents || [],
    })),
    isOverdue:
      new Date() > new Date(indObj.deadline) && indObj.status !== "Completed",
  };
};

// ─── 1. Get All Indicators (Admin Dashboard) ──────────────────────────────────
export const fetchIndicatorsForAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, search } = req.query;
    const filter: Record<string, any> = {};

    if (status && typeof status === "string" && status !== "all") {
      filter.status = status;
    }

    if (search && typeof search === "string") {
      const matchingUsers = await User.find({
        $or: [
          { name: { $regex: search, $options: "i" } },
          { pjNumber: { $regex: search, $options: "i" } },
        ],
      }).select("_id");
      filter.assignee = { $in: matchingUsers.map((u) => u._id) };
    }

    const indicators = await Indicator.find(filter)
      .populate({ path: "assignee", select: "name email pjNumber" })
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .populate({ path: "assignedBy", select: "name" })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: indicators.length,
      data: indicators.map(transformIndicator),
    });
  }
);

// ─── 2. Get Single Indicator (Admin View) ─────────────────────────────────────
export const getIndicatorByIdAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid indicator ID.", 400);
    }

    const indicator = await Indicator.findById(id)
      .populate({ path: "assignee", select: "name email pjNumber" })
      .populate({ path: "assignedBy", select: "name" })
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .populate({ path: "reviewHistory.reviewedBy", select: "name role" })
      .lean();

    if (!indicator) throw new AppError("Indicator not found.", 404);

    res.status(200).json({
      success: true,
      data: transformIndicator(indicator),
    });
  }
);

// ─── 3. Get Resubmitted Indicators ────────────────────────────────────────────
export const fetchResubmittedIndicators = asyncHandler(
  async (_req: Request, res: Response) => {
    const indicators = await Indicator.find({
      status: "Awaiting Admin Approval",
      submissions: {
        $elemMatch: {
          reviewStatus: "Pending",
          resubmissionCount: { $gt: 0 },
        },
      },
    })
      .populate({ path: "assignee", select: "name email pjNumber" })
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: indicators.length,
      data: indicators.map(transformIndicator),
    });
  }
);

// ─── 4. Admin Review (Verify or Reject) ───────────────────────────────────────
export const adminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { decision, adminOverallComments, submissionUpdates } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid indicator ID.", 400);
    }

    if (!["Verified", "Rejected"].includes(decision)) {
      throw new AppError('Decision must be "Verified" or "Rejected".', 400);
    }

    if (!adminOverallComments?.trim()) {
      throw new AppError("Admin comments are required.", 400);
    }

    const indicator = await Indicator.findById(id).populate(
      "assignee",
      "name email"
    );
    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (indicator.status !== "Awaiting Admin Approval") {
      throw new AppError(`Indicator is not in review status.`, 400);
    }

    let finalUpdates = submissionUpdates;
    if (!Array.isArray(finalUpdates) || finalUpdates.length === 0) {
      finalUpdates = indicator.submissions
        .filter((s: any) => s.reviewStatus === "Pending")
        .map((s: any) => ({ submissionId: s._id }));
    }

    if (finalUpdates.length === 0) {
      throw new AppError("At least one submission update is required.", 400);
    }

    const isVerified = decision === "Verified";

    // Update Sub-documents
    finalUpdates.forEach((update: any) => {
      if (!update.submissionId) return;
      const sub = (indicator.submissions as any).id(update.submissionId);
      if (sub) {
        sub.reviewStatus = isVerified ? "Verified" : "Rejected";
        sub.adminComment = update.adminComment?.trim() || adminOverallComments.trim();
        sub.isReviewed = true;
      }
    });

    // Parent status and logs
    indicator.status = isVerified ? "Awaiting Super Admin" : "Rejected by Admin";
    indicator.adminOverallComments = adminOverallComments.trim();
    
    // Explicitly tell Mongoose that nested array has changed
    indicator.markModified("submissions");

    indicator.reviewHistory.push({
      action: isVerified ? "Verified" : "Correction Requested",
      reason: adminOverallComments.trim(),
      reviewerRole: "admin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    } as any);

    await indicator.save();

    // Async Notifications
    const assignee = indicator.assignee as any;
    const taskTitle = indicator.instructions || "Performance Indicator";
    const year = new Date().getFullYear();

    if (isVerified) {
      User.find({ role: "superadmin", isActive: true })
        .select("email")
        .then((superAdmins) => {
          superAdmins.forEach((sa) => {
            sendMail({
              to: sa.email,
              subject: "Submission Ready for Final Approval",
              html: superAdminReviewNeededTemplate(
                taskTitle,
                assignee?.name || "Staff",
                (req as any).user?.name,
                indicator.activeQuarter,
                year
              ),
            }).catch((e) => console.error("Mail Error:", e));
          });
        });
    } else if (assignee?.email) {
      sendMail({
        to: assignee.email,
        subject: "Submission Returned for Correction",
        html: submissionRejectedTemplate(
          assignee.name,
          taskTitle,
          indicator.activeQuarter,
          year,
          "Admin",
          adminOverallComments.trim()
        ),
      }).catch((e) => console.error("Mail Error:", e));
    }

    res.status(200).json({
      success: true,
      message: isVerified ? "Verified successfully." : "Rejected for correction.",
      data: transformIndicator(indicator),
    });
  }
);