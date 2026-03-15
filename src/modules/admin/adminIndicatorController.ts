import { Request, Response } from "express";
import { Indicator, ISubmission } from "../user/Indicator.model";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import { User } from "../user/user.model";

/**
 * 🛠 DATA TRANSFORMER
 */
const transformIndicator = (ind: any) => {
  const indObj = typeof ind.toObject === "function" ? ind.toObject() : ind;
  const plan = indObj.strategicPlanId;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id?.toString() === indObj.objectiveId?.toString(),
  );

  const activity = objective?.activities?.find(
    (act: any) => act._id?.toString() === indObj.activityId?.toString(),
  );

  return {
    ...indObj,
    _id: indObj._id.toString(),
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName:
      indObj.assignee?.name || indObj.assignee?.groupName || "Unassigned",
    isOverdue:
      new Date() > new Date(indObj.deadline) && indObj.status !== "Completed",
  };
};

/**
 * ⚖️ ADMIN VERIFICATION PROCESS (The Audit Gate)
 * ACTION: "Verified" -> Status: "Awaiting Super Admin"
 * PROGRESS: Remains unchanged (Accepted logic not yet triggered)
 */
export const adminReviewProcess = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      decision, // "Verified" | "Rejected"
      adminOverallComments,
      submissionUpdates,
    } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator)
      return res
        .status(404)
        .json({ success: false, message: "Indicator not found" });

    const isVerified = decision === "Verified";

    // 1. Audit individual submissions
    if (Array.isArray(submissionUpdates)) {
      submissionUpdates.forEach((update: any) => {
        const sub = (indicator.submissions as any).id(update.submissionId);
        if (sub) {
          // IMPORTANT: Admin marks as 'Verified', NOT 'Accepted'
          sub.reviewStatus = isVerified ? "Verified" : "Rejected";
          sub.adminComment = update.adminComment;
          if (update.adminDescriptionEdit !== undefined) {
            sub.adminDescriptionEdit = update.adminDescriptionEdit;
          }
          sub.isReviewed = true;
        }
      });
    }

    indicator.adminOverallComments = adminOverallComments;

    // 2. Log History (Triggers Middleware Step 2)
    indicator.reviewHistory.push({
      action: isVerified ? "Verified" : "Correction Requested",
      reason:
        adminOverallComments ||
        (isVerified
          ? "Audit passed. Documentation verified."
          : "Insufficient evidence."),
      reviewerRole: "admin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    });

    await indicator.save();

    res.status(200).json({
      success: true,
      message: isVerified
        ? "Verified and sent to Super Admin."
        : "Returned for correction.",
      data: transformIndicator(indicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🛡️ SUPER ADMIN CERTIFICATION (The Value Gate)
 * ACTION: "Approved" -> Status: "Completed"
 * PROGRESS: Recalculates based on "Accepted" submissions
 */
export const superAdminReviewProcess = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { decision, reason, progressOverride } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator)
      return res
        .status(404)
        .json({ success: false, message: "Indicator not found" });

    const isApprove = decision === "Approved";

    if (isApprove) {
      // Find the specific cycle's submission that the Admin just verified
      const targetQ =
        indicator.reportingCycle === "Annual" ? 0 : indicator.activeQuarter;
      const currentSub = indicator.submissions.find(
        (s: ISubmission) =>
          s.quarter === targetQ && s.reviewStatus === "Verified",
      );

      if (currentSub) {
        // FINAL ACT: Change status to 'Accepted' to trigger progress calculation
        currentSub.reviewStatus = "Accepted";
        if (progressOverride !== undefined) {
          currentSub.achievedValue = Number(progressOverride);
        }
      }
    }

    // 2. Log Certification (Triggers Middleware Step 2 to set status "Completed")
    indicator.reviewHistory.push({
      action: isApprove ? "Approved" : "Rejected",
      reason: reason || "Performance certified and finalized.",
      reviewerRole: "superadmin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    });

    await indicator.save();

    // Re-fetch with populations for a clean UI update
    const updated = await Indicator.findById(id)
      .populate({ path: "assignee", model: User })
      .populate({ path: "strategicPlanId", model: StrategicPlan });

    res.status(200).json({
      success: true,
      message: isApprove
        ? "Performance certified at 100%"
        : "Rejection recorded",
      data: transformIndicator(updated),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🔍 DASHBOARD UTILITIES
 */

export const fetchIndicatorsForAdmin = async (req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find()
      .populate({
        path: "assignee",
        model: User,
        select: "name email role station",
      })
      .populate({ path: "strategicPlanId", model: StrategicPlan })
      .sort({ updatedAt: -1 });

    res
      .status(200)
      .json({ success: true, data: indicators.map(transformIndicator) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getIndicatorByIdAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const indicator = await Indicator.findById(id)
      .populate({ path: "assignee", model: User })
      .populate({ path: "strategicPlanId", model: StrategicPlan })
      .populate({ path: "reviewHistory.reviewedBy", model: User });

    if (!indicator)
      return res
        .status(404)
        .json({ success: false, message: "Indicator not found" });

    res
      .status(200)
      .json({ success: true, data: transformIndicator(indicator) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const fetchResubmittedIndicators = async (
  req: Request,
  res: Response,
) => {
  try {
    const indicators = await Indicator.find({
      submissions: {
        $elemMatch: {
          reviewStatus: "Pending",
          resubmissionCount: { $gt: 0 },
        },
      },
    })
      .populate({ path: "assignee", model: User })
      .populate({ path: "strategicPlanId", model: StrategicPlan });

    res.status(200).json({
      success: true,
      count: indicators.length,
      data: indicators.map(transformIndicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
