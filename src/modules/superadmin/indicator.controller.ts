import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { Indicator, ISubmission } from "../user/Indicator.model";
import { RegistryConfiguration } from "../user/RegistryConfiguration";
import { User } from "../user/user.model";
import { sendMail } from "../../utils/sendMail";
import {
  submissionApprovedTemplate,
  submissionRejectedTemplate,
  taskAssignedTemplate,
} from "../../utils/mailTemplates";
import mongoose from "mongoose";

// ─── Data Transformer ─────────────────────────────────────────────────────────
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
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: indObj.assignee?.name || "Unassigned",
    needsAction: ["Rejected by Admin", "Rejected by Super Admin"].includes(
      indObj.status
    ),
    isOverdue:
      new Date() > new Date(indObj.deadline) && indObj.status !== "Completed",
  };
};

// ─── 1. Create Indicator ──────────────────────────────────────────────────────
export const createIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const {
      strategicPlanId,
      objectiveId,
      activityId,
      assignee,
      assignmentType,
      reportingCycle,
      weight,
      unit,
      target,
      deadline,
      instructions,
      activeQuarter,
    } = req.body;

    if (!strategicPlanId || !objectiveId || !activityId || !assignee || !deadline) {
      throw new AppError("Required fields missing: plan, objective, activity, assignee, or deadline.", 400);
    }

    const assigneeUser = await User.findById(assignee).select("name email role");
    if (!assigneeUser) throw new AppError("Assignee user not found.", 404);

    const parsedDeadline = new Date(deadline);
    if (parsedDeadline < new Date()) throw new AppError("Deadline cannot be in the past.", 400);

    const indicator = await Indicator.create({
      strategicPlanId,
      objectiveId,
      activityId,
      assignee,
      assignmentType: assignmentType || "User",
      reportingCycle: reportingCycle || "Quarterly",
      weight: weight || 5,
      unit: unit || "%",
      target: target || 100,
      deadline: parsedDeadline,
      instructions: instructions || "",
      activeQuarter: activeQuarter || 1,
      assignedBy: req.user!._id,
      status: "Pending",
    });

    try {
      await sendMail({
        to: assigneeUser.email,
        subject: "New Task Assigned",
        html: taskAssignedTemplate(assigneeUser.name, instructions, activeQuarter, new Date().getFullYear(), parsedDeadline.toDateString()),
      });
    } catch (err) {
      console.error("[MAIL] Notification failed:", err);
    }

    res.status(201).json({ success: true, data: indicator });
  }
);

// ─── 2. Get All Indicators ────────────────────────────────────────────────────
export const getAllIndicators = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, assignee } = req.query;
    const filter: Record<string, any> = {};

    if (status) filter.status = status;
    if (assignee && mongoose.Types.ObjectId.isValid(assignee as string)) filter.assignee = assignee;

    const indicators = await Indicator.find(filter)
      .populate("assignee", "name email pjNumber")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      data: indicators.map(transformIndicator),
    });
  }
);

// ─── 3. Get Single Indicator (Includes Files) ─────────────────────────────────
export const getIndicatorById = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const indicator = await Indicator.findById(id)
      .populate("assignee", "name email title pjNumber")
      .populate("assignedBy", "name email")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      // Ensure we fetch reviewers for the history
      .populate({ path: "reviewHistory.reviewedBy", select: "name role" })
      .lean();

    if (!indicator) throw new AppError("Indicator not found.", 404);

    res.status(200).json({ success: true, data: transformIndicator(indicator) });
  }
);

// ─── 4. Update Indicator ──────────────────────────────────────────────────────
export const updateIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    
    const indicator = await Indicator.findById(id);
    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (["Awaiting Admin Approval", "Awaiting Super Admin"].includes(indicator.status)) {
      throw new AppError("Cannot edit an indicator while it is under review.", 400);
    }

    // Protection against direct status/progress manipulation
    const protectedFields = ["submissions", "reviewHistory", "status", "progress"];
    protectedFields.forEach(field => delete req.body[field]);

    Object.assign(indicator, req.body);
    
    // Reset to pending if core targets or deadlines change
    if (req.body.deadline || req.body.target) indicator.status = "Pending";

    await indicator.save();
    res.status(200).json({ success: true, data: indicator });
  }
);

// ─── 5. Delete Indicator ──────────────────────────────────────────────────────
export const deleteIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const indicator = await Indicator.findById(req.params.id);
    if (!indicator) throw new AppError("Indicator not found.", 404);
    
    if (indicator.status === "Completed") throw new AppError("Cannot delete a completed indicator.", 400);

    await indicator.deleteOne();
    res.status(200).json({ success: true, message: "Indicator removed." });
  }
);

// ─── 6. SuperAdmin Final Review (Certification Logic) ────────────────────────
export const superAdminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { decision, reason, progressOverride, nextDeadline } = req.body;

    if (!["Approved", "Rejected"].includes(decision)) {
      throw new AppError("Invalid decision.", 400);
    }

    // --- REASON VALIDATION UPDATE ---
    // Reason is strictly required for Rejections, but optional for Approvals
    const isApprove = decision === "Approved";
    const trimmedReason = reason?.trim();

    if (!isApprove && !trimmedReason) {
      throw new AppError("A reason is required when rejecting a submission.", 400);
    }

    // Default audit text if approval reason is blank
    const finalReason = trimmedReason || (isApprove ? "Approved by Super Admin" : "");

    const indicator = await Indicator.findById(id).populate("assignee", "name email");
    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (indicator.status !== "Awaiting Super Admin") {
      throw new AppError(
        `Indicator is in '${indicator.status}' state, not awaiting certification.`,
        400
      );
    }
    
    // Find the submission for the currently active quarter
    const currentSub = indicator.submissions.find(
      (s: ISubmission) => s.quarter === indicator.activeQuarter
    );

    if (!currentSub) {
      throw new AppError(`No submission found for Quarter ${indicator.activeQuarter}.`, 404);
    }

    // 1. Update the Submission Status
    currentSub.reviewStatus = isApprove ? "Accepted" : "Rejected";
    currentSub.isReviewed = true;
    currentSub.adminComment = finalReason;

    // 2. Handle Progress Override (if provided)
    if (isApprove && progressOverride !== undefined) {
      currentSub.achievedValue = Number(progressOverride);
    }

    // 3. Push to Review History
    indicator.reviewHistory.push({
      action: isApprove ? "Approved" : "Rejected",
      reason: finalReason,
      reviewerRole: "superadmin",
      reviewedBy: req.user!._id,
      at: new Date(),
      nextDeadline: nextDeadline ? new Date(nextDeadline) : undefined,
    });

    // 4. Save triggers the Model's logic (pre-save hook for Q increment)
    await indicator.save();

    // 5. Mail Notification
    const assignee = indicator.assignee as any;
    try {
      await sendMail({
        to: assignee.email,
        subject: isApprove ? "Submission Approved" : "Submission Rejected",
        html: isApprove
          ? submissionApprovedTemplate(
              assignee.name,
              indicator.instructions,
              indicator.activeQuarter, 
              new Date().getFullYear()
            )
          : submissionRejectedTemplate(
              assignee.name,
              indicator.instructions,
              indicator.activeQuarter,
              new Date().getFullYear(),
              "Super Admin",
              finalReason // Pass the reason to the email template
            ),
      });
    } catch (err) {
      console.error("[MAIL] Notification failed:", err);
    }

    res.status(200).json({
      success: true,
      message: isApprove 
        ? (indicator.status === "Completed" ? "Indicator Completed." : `Quarterly progress approved.`)
        : "Submission Rejected.",
      data: indicator
    });
  }
);

// ─── 7. Get All Submissions (Fetching Files & Progress) ──────────────────────
export const getAllSubmissions = asyncHandler(
  async (_req: Request, res: Response) => {
    // Find indicators that have at least one submission
    const indicators = await Indicator.find({ "submissions.0": { $exists: true } })
      .populate("assignee", "name email pjNumber")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ updatedAt: -1 })
      .lean();

    const queue = indicators.map((ind: any) => {
      const latestSub = ind.submissions[ind.submissions.length - 1];
      const transformed = transformIndicator(ind);
      
      return {
        _id: ind._id,
        indicatorTitle: transformed?.activityDescription,
        submittedBy: transformed?.assigneeDisplayName,
        submittedOn: latestSub?.submittedAt,
        status: ind.status,
        progress: ind.progress,
        quarter: `Q${latestSub?.quarter}`,
        // Extracting file data for the frontend to show download buttons
        documents: latestSub?.documents || [], 
        documentsCount: latestSub?.documents?.length || 0,
        achievedValue: latestSub?.achievedValue
      };
    });

    res.status(200).json({ success: true, count: queue.length, data: queue });
  }
);

// ─── 8. Registry & Stats ──────────────────────────────────────────────────────
export const getSuperAdminStats = asyncHandler(
  async (_req: Request, res: Response) => {
    const [total, statusCounts] = await Promise.all([
      Indicator.countDocuments(),
      Indicator.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const stats = statusCounts.reduce((acc: any, curr: any) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: { total, stats },
    });
  }
);

export const updateRegistrySettings = asyncHandler(
  async (req: Request, res: Response) => {
    const { quarter, year, startDate, endDate, isLocked } = req.body;
    const config = await RegistryConfiguration.findOneAndUpdate(
      { quarter, year },
      { startDate, endDate, isLocked, createdBy: req.user!._id },
      { upsert: true, new: true }
    );
    res.status(200).json({ success: true, data: config });
  }
);

export const getRegistryStatus = asyncHandler(
  async (_req: Request, res: Response) => {
    const settings = await RegistryConfiguration.find().sort({ year: -1, quarter: 1 });
    res.status(200).json({ success: true, data: settings });
  }
);

// ─── 8. Get Rejected by Admin (Oversight for SuperAdmin) ──────────────────────
export const getRejectedByAdmin = asyncHandler(
  async (_req: Request, res: Response) => {
    // This specifically fetches indicators the Registry (Admin) rejected 
    // before they ever reached the Super Admin.
    const indicators = await Indicator.find({ status: "Rejected by Admin" })
      .populate("assignee", "name email title pjNumber")
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