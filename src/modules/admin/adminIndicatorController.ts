import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { Indicator } from "../user/Indicator.model";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import { User } from "../user/user.model";

/**
 * 🛠 DATA TRANSFORMER
 * Hydrates the raw Indicator document with virtual fields from the Strategic Plan 
 * hierarchy and computes frontend-friendly display values.
 */
const transformIndicator = (ind: any) => {
  const indObj = typeof ind.toObject === "function" ? ind.toObject() : ind;
  const plan = indObj.strategicPlanId;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id?.toString() === indObj.objectiveId?.toString()
  );

  const activity = objective?.activities?.find(
    (act: any) => act._id?.toString() === indObj.activityId?.toString()
  );

  const displayName = indObj.assignee?.name || indObj.assignee?.groupName || "Unassigned";

  return {
    ...indObj,
    _id: indObj._id.toString(),
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription: activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: displayName,
    submissions: (indObj.submissions || []).map((sub: any) => ({
      ...sub,
      documents: sub.documents || []
    })),
    isOverdue: new Date() > new Date(indObj.deadline) && (indObj.progress || 0) < 100,
  };
};

/**
 * ⚖️ ADMIN VERIFICATION PROCESS (Registry Level)
 * Validates existence/quality of evidence. 
 * Moves status to "Awaiting Super Admin" for final certification.
 */
export const adminReviewProcess = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, adminOverallComments, documentReviews } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator) {
      return res.status(404).json({ success: false, message: "Indicator not found" });
    }

    // Process individual document review statuses
    if (Array.isArray(documentReviews)) {
      documentReviews.forEach((rev: any) => {
        const sub = indicator.submissions.id(rev.submissionId);
        if (sub) {
          sub.reviewStatus = rev.reviewStatus; 
          sub.adminComment = rev.adminComment;
          sub.isReviewed = true;
          // Note: achievedValue is NOT set by Registry Admin
        }
      });
    }

    // Update Overall Status (e.g., "Awaiting Super Admin" or "Rejected by Admin")
    indicator.status = status; 
    indicator.adminOverallComments = adminOverallComments;

    indicator.reviewHistory.push({
      action: status === "Awaiting Super Admin" ? "Verified" : "Correction Requested",
      reason: adminOverallComments || "Evidence verified by Registry. Pending Final Certification.",
      reviewerRole: "admin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    } as any);

    await indicator.save();

    const finalResult = await Indicator.findById(id)
      .populate({ path: "assignee", model: User })
      .populate({ path: "strategicPlanId", model: StrategicPlan });

    res.status(200).json({
      success: true,
      message: `Registry verification complete. Status: ${status}`,
      data: transformIndicator(finalResult),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🛡️ SUPER ADMIN CERTIFICATION (Final Level)
 * Locks in achieved value and triggers the Logic Engine to recalculate progress.
 */
export const superAdminReviewProcess = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { decision, reason, progressOverride } = req.body; 

    const indicator = await Indicator.findById(id);
    if (!indicator) return res.status(404).json({ success: false, message: "Indicator not found" });

    const isApprove = decision === "Approved";

    if (isApprove) {
      // Find the submission for the current active quarter to lock it in
      const currentSub = indicator.submissions.find(s => s.quarter === indicator.activeQuarter);
      
      if (currentSub) {
        currentSub.reviewStatus = "Accepted";
        // If Super Admin provides a specific verified value, override the user's input
        if (progressOverride !== undefined) {
          currentSub.achievedValue = Number(progressOverride);
        }
        currentSub.isReviewed = true;
      }
      
      // Temporary transition state; calculateProgress() will finalize this
      indicator.status = "Partially Approved"; 
    } else {
      indicator.status = "Rejected by Super Admin";
    }

    indicator.reviewHistory.push({
      action: isApprove ? "Approved" : "Rejected",
      reason: reason || "Final performance certification complete.",
      reviewerRole: "superadmin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    } as any);

    // Save initial state changes
    await indicator.save();

    // 🚀 TRIGGER ENGINE: Recalculate %, move activeQuarter, and finalize status
    await Indicator.calculateProgress(indicator._id as Types.ObjectId);

    const updated = await Indicator.findById(id)
      .populate({ path: "assignee", model: User })
      .populate({ path: "strategicPlanId", model: StrategicPlan });

    res.status(200).json({ 
      success: true, 
      message: isApprove ? "Performance certified successfully" : "Submission rejected",
      data: transformIndicator(updated) 
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🔍 ADMIN UTILITIES
 */

// Fetch all indicators sorted by latest activity
export const fetchIndicatorsForAdmin = async (req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find()
      .populate({ path: "assignee", model: User, select: "name email title role station" })
      .populate({ path: "strategicPlanId", model: StrategicPlan })
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: indicators.map(transformIndicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Fetch single indicator details including full review history
export const getIndicatorByIdAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const indicator = await Indicator.findById(id)
      .populate({ path: "assignee", model: User })
      .populate({ path: "strategicPlanId", model: StrategicPlan })
      .populate({ path: "reviewHistory.reviewedBy", model: User });

    if (!indicator) return res.status(404).json({ success: false, message: "Not found" });

    res.status(200).json({ success: true, data: transformIndicator(indicator) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Fetch indicators where users have resubmitted after a rejection
export const fetchResubmittedIndicators = async (req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find({
      "submissions": {
        $elemMatch: {
          reviewStatus: "Pending",
          resubmissionCount: { $gt: 0 }
        }
      }
    })
    .populate({ path: "assignee", model: User })
    .populate({ path: "strategicPlanId", model: StrategicPlan })
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