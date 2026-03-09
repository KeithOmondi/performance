import { Request, Response } from "express";
import mongoose from "mongoose";
import { Indicator } from "../user/Indicator.model";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import { User } from "../user/user.model";

/**
 * HELPER: transformIndicator
 * Ensures data consistency for Admin Registry views.
 */
const transformIndicator = (ind: any) => {
  const indObj = typeof ind.toObject === "function" ? ind.toObject() : ind;
  const plan = indObj.strategicPlanId;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id.toString() === indObj.objectiveId?.toString(),
  );

  const activity = objective?.activities?.find(
    (act: any) => act._id.toString() === indObj.activityId?.toString(),
  );

  let displayName = "Unassigned";
  if (Array.isArray(indObj.assignee)) {
    displayName = indObj.assignee
      .map((a: any) =>
        typeof a === "object" ? a.name || a.groupName : "Team Member",
      )
      .filter(Boolean)
      .join(", ");
  } else if (indObj.assignee && typeof indObj.assignee === "object") {
    displayName =
      indObj.assignee.name || indObj.assignee.groupName || "Unassigned";
  }

  const submissionArray = indObj.submissions || [];

  // Flag for UI to show "Resubmitted" badge
  const hasResubmission = submissionArray.some(
    (sub: any) =>
      sub.reviewStatus === "Pending" && (sub.resubmissionCount || 0) > 0,
  );

  return {
    ...indObj,
    _id: indObj._id.toString(),
    activityId: indObj.activityId?.toString(),
    objectiveId: indObj.objectiveId?.toString(),

    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: displayName,

    // UI Metadata & Multi-document mapping
    isResubmission: hasResubmission,
    submissions: submissionArray.map((sub: any) => ({
      ...sub,
      // Ensure the frontend always sees an array, even if legacy data only has single URL
      documents:
        sub.documents && sub.documents.length > 0
          ? sub.documents
          : sub.evidenceUrl
            ? [
                {
                  evidenceUrl: sub.evidenceUrl,
                  fileType: sub.fileType,
                  fileName: "Legacy Attachment",
                },
              ]
            : [],
    })),
    latestSubmission:
      submissionArray.length > 0
        ? submissionArray[submissionArray.length - 1]
        : null,
    totalSubmissions: submissionArray.length,
    isOverdue:
      new Date() > new Date(indObj.deadline) && (indObj.progress || 0) < 100,
  };
};

/**
 * @desc    Admin View: Fetch all indicators
 */
export const fetchIndicatorsForAdmin = async (req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find()
      .populate({
        path: "assignee",
        model: User,
        select: "name email title pjNumber station role",
      })
      .populate({ path: "assignedBy", model: User, select: "name email title" })
      .populate({
        path: "strategicPlanId",
        model: StrategicPlan,
        select: "perspective objectives",
      })
      .populate({
        path: "reviewHistory.reviewedBy",
        model: User,
        select: "name title",
      })
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      count: indicators.length,
      data: indicators.map(transformIndicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get Specific Indicator Detail
 * @route   GET /api/admin/indicators/:id
 */
export const getIndicatorByIdAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ID format" });
    }

    const indicator = await Indicator.findById(id)
      .populate({
        path: "assignee",
        model: User,
        select: "name email title pjNumber station role",
      })
      .populate({ path: "assignedBy", model: User, select: "name email title" })
      .populate({
        path: "strategicPlanId",
        model: StrategicPlan,
        select: "perspective objectives",
      })
      .populate({
        path: "reviewHistory.reviewedBy",
        model: User,
        select: "name title",
      });

    if (!indicator) {
      return res
        .status(404)
        .json({ success: false, message: "Indicator not found" });
    }

    res.status(200).json({
      success: true,
      data: transformIndicator(indicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Admin Review Action: Now handles multi-document logic
 */
export const adminReviewProcess = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { overallDecision, adminOverallComments, documentReviews } = req.body;

  try {
    const indicator = await Indicator.findById(id);
    if (!indicator) {
      return res
        .status(404)
        .json({ success: false, message: "Indicator not found" });
    }

    if (Array.isArray(documentReviews)) {
      documentReviews.forEach((rev: any) => {
        const sub = (indicator.submissions as any).id(rev.submissionId);
        if (sub) {
          sub.reviewStatus = rev.reviewStatus;
          sub.adminComment = rev.adminComment;
          sub.isReviewed = true;

          if (rev.reviewStatus === "Rejected") {
            sub.resubmissionCount = (sub.resubmissionCount || 0) + 1;
          }
        }
      });
    }

    // Update overall indicator level status
    indicator.status = overallDecision;
    indicator.adminOverallComments = adminOverallComments;

    indicator.reviewHistory.push({
      action: overallDecision,
      reason: adminOverallComments,
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    });

    await indicator.save();

    const updatedDoc = await Indicator.findById(id)
      .populate({
        path: "assignee",
        model: User,
        select: "name email title pjNumber",
      })
      .populate({
        path: "strategicPlanId",
        model: StrategicPlan,
        select: "perspective objectives",
      })
      .populate({
        path: "reviewHistory.reviewedBy",
        model: User,
        select: "name title",
      });

    res.status(200).json({
      success: true,
      message: `Review completed: ${overallDecision}`,
      data: updatedDoc ? transformIndicator(updatedDoc) : indicator,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Fetch only indicators that contain resubmitted work
 */
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
      .populate({
        path: "assignee",
        model: User,
        select: "name email title pjNumber station role",
      })
      .populate({
        path: "strategicPlanId",
        model: StrategicPlan,
        select: "perspective objectives",
      })
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: indicators.map(transformIndicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
