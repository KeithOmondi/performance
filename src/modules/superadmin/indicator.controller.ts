import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { Indicator, ISubmission } from "../user/Indicator.model";
import { RegistryConfiguration } from "../user/RegistryConfiguration";
import { User } from "../user/user.model";
import { Team } from "../user/team.model";
import { sendMail } from "../../utils/sendMail";
import {
  submissionApprovedTemplate,
  submissionRejectedTemplate,
  taskAssignedTemplate,
} from "../../utils/mailTemplates";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Given an indicator, returns the list of email addresses to notify.
 *
 * - User assignment → single email
 * - Team assignment → emails of all active team members
 *
 * Also returns a display name suitable for email copy.
 */
async function resolveRecipients(indicator: {
  assignmentType: "User" | "Team";
  assignee: mongoose.Types.ObjectId | any;
}): Promise<{ emails: string[]; displayName: string }> {
  if (indicator.assignmentType === "User") {
    // assignee may already be populated
    const user =
      indicator.assignee?.email
        ? indicator.assignee
        : await User.findById(indicator.assignee).select("name email");

    if (!user) return { emails: [], displayName: "Unknown" };
    return { emails: [user.email], displayName: user.name };
  }

  // Team: fetch team + all active members
  const team =
    indicator.assignee?.name
      ? indicator.assignee
      : await Team.findById(indicator.assignee)
          .populate("members", "name email isActive")
          .lean();

  if (!team) return { emails: [], displayName: "Unknown Team" };

  const emails = (team.members as any[])
    .filter((m: any) => m.isActive !== false)
    .map((m: any) => m.email);

  return { emails, displayName: team.name };
}

// ─── Data Transformer ─────────────────────────────────────────────────────────
const transformIndicator = (ind: any) => {
  if (!ind) return null;
  const indObj = typeof ind.toObject === "function" ? ind.toObject() : ind;
  const plan = indObj.strategicPlanId;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id?.toString() === indObj.objectiveId?.toString(),
  );
  const activity = objective?.activities?.find(
    (act: any) => act._id?.toString() === indObj.activityId?.toString(),
  );

  // Works for both User (name) and Team (name)
  const assigneeName =
    indObj.assignmentType === "Team"
      ? indObj.assignee?.name ?? "Unassigned Team"
      : indObj.assignee?.name ?? "Unassigned";

  return {
    ...indObj,
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: assigneeName,
    assigneeType: indObj.assignmentType,
    needsAction: ["Rejected by Admin", "Rejected by Super Admin"].includes(
      indObj.status,
    ),
    isOverdue:
      new Date() > new Date(indObj.deadline) && indObj.status !== "Completed",
  };
};

/* ------------------------------------------------------------------ */
/*  1. Create Indicator                                                  */
/* ------------------------------------------------------------------ */
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
      throw new AppError("Required fields missing.", 400);
    }

    const type: "User" | "Team" = assignmentType === "Team" ? "Team" : "User";

    // Validate assignee exists in the correct collection
    if (type === "User") {
      const exists = await User.exists({ _id: assignee });
      if (!exists) throw new AppError("Assignee user not found.", 404);
    } else {
      const exists = await Team.exists({ _id: assignee, isActive: true });
      if (!exists) throw new AppError("Team not found or is inactive.", 404);
    }

    const parsedDeadline = new Date(deadline);
    if (parsedDeadline < new Date()) {
      throw new AppError("Deadline cannot be in the past.", 400);
    }

    const indicator = await Indicator.create({
      strategicPlanId,
      objectiveId,
      activityId,
      assignee,
      assignmentType: type,
      assigneeModel: type, // keep in sync immediately
      reportingCycle: reportingCycle || "Quarterly",
      weight: weight ?? 5,
      unit: unit || "%",
      target: target ?? 100,
      deadline: parsedDeadline,
      instructions: instructions || "",
      activeQuarter: activeQuarter || 1,
      assignedBy: req.user!._id,
      status: "Pending",
    });

    // Resolve recipients and notify
    const { emails, displayName } = await resolveRecipients({
      assignmentType: type,
      assignee,
    });

    if (emails.length > 0) {
      try {
        await Promise.all(
          emails.map((email) =>
            sendMail({
              to: email,
              subject: "New Task Assigned",
              html: taskAssignedTemplate(
                displayName,
                instructions || "—",
                activeQuarter || 1,
                new Date().getFullYear(),
                parsedDeadline.toDateString(),
              ),
            }),
          ),
        );
      } catch (err) {
        console.error("[MAIL] Assignment notification failed:", err);
      }
    }

    res.status(201).json({ success: true, data: indicator });
  },
);

/* ------------------------------------------------------------------ */
/*  2. Get All Indicators                                               */
/* ------------------------------------------------------------------ */
export const getAllIndicators = asyncHandler(
  async (req: Request, res: Response) => {
    const { status, assignee, assignmentType } = req.query;
    const filter: Record<string, any> = {};

    if (status) filter.status = status;
    if (assignmentType) filter.assignmentType = assignmentType;
    if (assignee && mongoose.Types.ObjectId.isValid(assignee as string)) {
      filter.assignee = assignee;
    }

    const indicators = await Indicator.find(filter)
      // refPath makes Mongoose look in 'User' or 'Team' automatically
      .populate("assignee", "name email pjNumber")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: indicators.length,
      data: indicators.map(transformIndicator),
    });
  },
);

/* ------------------------------------------------------------------ */
/*  3. Get Single Indicator                                             */
/* ------------------------------------------------------------------ */
export const getIndicatorById = asyncHandler(
  async (req: Request, res: Response) => {
    const indicator = await Indicator.findById(req.params.id)
      .populate("assignee", "name email title pjNumber") // works for User and Team via refPath
      .populate("assignedBy", "name email")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .populate({ path: "reviewHistory.reviewedBy", select: "name role" })
      .lean();

    if (!indicator) throw new AppError("Indicator not found.", 404);

    res.status(200).json({ success: true, data: transformIndicator(indicator) });
  },
);

/* ------------------------------------------------------------------ */
/*  4. Update Indicator                                                 */
/* ------------------------------------------------------------------ */
export const updateIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const indicator = await Indicator.findById(req.params.id);
    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (
      ["Awaiting Admin Approval", "Awaiting Super Admin"].includes(
        indicator.status,
      )
    ) {
      throw new AppError(
        "Cannot edit an indicator while it is under review.",
        400,
      );
    }

    const protectedFields = ["submissions", "reviewHistory", "status", "progress"];
    protectedFields.forEach((field) => delete req.body[field]);

    Object.assign(indicator, req.body);

    // Keep assigneeModel in sync if assignmentType is being changed
    if (req.body.assignmentType) {
      indicator.assigneeModel =
        req.body.assignmentType === "Team" ? "Team" : "User";
    }

    if (req.body.deadline || req.body.target) indicator.status = "Pending";

    await indicator.save();
    res.status(200).json({ success: true, data: indicator });
  },
);

/* ------------------------------------------------------------------ */
/*  5. Delete Indicator                                                 */
/* ------------------------------------------------------------------ */
export const deleteIndicator = asyncHandler(
  async (req: Request, res: Response) => {
    const indicator = await Indicator.findById(req.params.id);
    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (indicator.status === "Completed") {
      throw new AppError("Cannot delete a completed indicator.", 400);
    }

    await indicator.deleteOne();
    res.status(200).json({ success: true, message: "Indicator removed." });
  },
);

/* ------------------------------------------------------------------ */
/*  6. SuperAdmin Final Review                                          */
/* ------------------------------------------------------------------ */
export const superAdminReviewProcess = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { decision, reason, nextDeadline } = req.body;

    const isApprove = decision === "Approved";

    const indicator = await Indicator.findById(id)
      .populate("assignee", "name email isActive members") // Team populate also returns members array if populated deeper — see below
      .lean();

    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (indicator.status !== "Awaiting Super Admin") {
      throw new AppError(
        `Indicator is in '${indicator.status}' state, not 'Awaiting Super Admin'.`,
        400,
      );
    }

    // Reload as Mongoose document for mutation
    const indicatorDoc = await Indicator.findById(id);
    if (!indicatorDoc) throw new AppError("Indicator not found.", 404);

    const currentSub = indicatorDoc.submissions.find(
      (s: ISubmission) => s.quarter === indicatorDoc.activeQuarter,
    );
    if (!currentSub) throw new AppError("No submission found for active quarter.", 404);

    currentSub.reviewStatus = isApprove ? "Accepted" : "Rejected";
    currentSub.isReviewed = true;
    currentSub.adminComment = reason?.trim() || (isApprove ? "Approved" : "");

    (indicatorDoc.reviewHistory as any).push({
      action: isApprove ? "Approved" : "Rejected",
      reason: currentSub.adminComment,
      reviewerRole: "superadmin",
      reviewedBy: req.user!._id,
      at: new Date(),
      nextDeadline: nextDeadline ? new Date(nextDeadline) : undefined,
    });

    await indicatorDoc.save();

    // Notify assignee(s)
    const { emails, displayName } = await resolveRecipients({
      assignmentType: indicatorDoc.assignmentType,
      assignee: indicatorDoc.assignee,
    });

    if (emails.length > 0) {
      try {
        await Promise.all(
          emails.map((email) =>
            sendMail({
              to: email,
              subject: isApprove ? "Submission Approved" : "Submission Rejected",
              html: isApprove
                ? submissionApprovedTemplate(
                    displayName,
                    indicatorDoc.instructions ?? "—",
                    indicatorDoc.activeQuarter,
                    new Date().getFullYear(),
                  )
                : submissionRejectedTemplate(
                    displayName,
                    indicatorDoc.instructions ?? "—",
                    indicatorDoc.activeQuarter,
                    new Date().getFullYear(),
                    "Super Admin",
                    reason,
                  ),
            }),
          ),
        );
      } catch (err) {
        console.error("[MAIL] SuperAdmin review notification failed:", err);
      }
    }

    res.status(200).json({ success: true, data: indicatorDoc });
  },
);

/* ------------------------------------------------------------------ */
/*  7. Get All Submissions Queue                                        */
/* ------------------------------------------------------------------ */
export const getAllSubmissions = asyncHandler(
  async (_req: Request, res: Response) => {
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
        assigneeType: ind.assignmentType,
        submittedOn: latestSub?.submittedAt,
        status: ind.status,
        progress: ind.progress,
        quarter: `Q${latestSub?.quarter}`,
        documents: latestSub?.documents || [],
        documentsCount: latestSub?.documents?.length || 0,
        achievedValue: latestSub?.achievedValue,
      };
    });

    res.status(200).json({ success: true, count: queue.length, data: queue });
  },
);

/* ------------------------------------------------------------------ */
/*  8. Registry & Stats                                                 */
/* ------------------------------------------------------------------ */
export const getSuperAdminStats = asyncHandler(
  async (_req: Request, res: Response) => {
    const [total, statusCounts] = await Promise.all([
      Indicator.countDocuments(),
      Indicator.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const stats = statusCounts.reduce((acc: any, curr: any) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    res.status(200).json({ success: true, data: { total, stats } });
  },
);

export const updateRegistrySettings = asyncHandler(
  async (req: Request, res: Response) => {
    const { quarter, year, startDate, endDate, isLocked } = req.body;
    const config = await RegistryConfiguration.findOneAndUpdate(
      { quarter, year },
      { startDate, endDate, isLocked, createdBy: req.user!._id },
      { upsert: true, new: true },
    );
    res.status(200).json({ success: true, data: config });
  },
);

export const getRegistryStatus = asyncHandler(
  async (_req: Request, res: Response) => {
    const settings = await RegistryConfiguration.find().sort({
      year: -1,
      quarter: 1,
    });
    res.status(200).json({ success: true, data: settings });
  },
);

/* ------------------------------------------------------------------ */
/*  9. Get Rejected by Admin (SuperAdmin oversight)                    */
/* ------------------------------------------------------------------ */
export const getRejectedByAdmin = asyncHandler(
  async (_req: Request, res: Response) => {
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
  },
);