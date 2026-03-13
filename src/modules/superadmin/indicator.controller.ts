import { Request, Response } from "express";
import { Indicator } from "../user/Indicator.model";
import { Types } from "mongoose";
import { RegistryConfiguration } from "../user/RegistryConfiguration";
import { User } from "../user/user.model";
import StrategicPlan from "../SPlanning/strategicPlan.model";

/**
 * HELPER: transformIndicator
 * Flattens nested strategic data and adds UI-specific flags.
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

  const displayName =
    indObj.assignee?.name || indObj.assignee?.groupName || "Unassigned";

  return {
    ...indObj,
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: displayName,
    needsAction: ["Rejected by Admin", "Rejected by Super Admin"].includes(
      indObj.status,
    ),
  };
};


/**
 * @desc 1. CREATE INDICATOR (Admin Assignment)
 */
export const createIndicator = async (req: Request, res: Response) => {
  try {
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
    } = req.body;

    const indicator = await Indicator.create({
      strategicPlanId,
      objectiveId,
      activityId,
      assignee,
      assignmentType,
      reportingCycle: reportingCycle || "Quarterly",
      weight: weight || 5,
      unit: unit || "%",
      target: target || 100,
      deadline,
      instructions,
      assignedBy: (req as any).user?._id,
      status: "Pending",
    });

    res.status(201).json({ success: true, data: indicator });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 2. UPDATE INDICATOR (Meta data & Phase Management)
 * This is now the "Gatekeeper" that opens new quarters.
 */
export const updateIndicator = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    // 1. PHASE GATE LOGIC
    // If the Admin is providing a NEW deadline or explicitly advancing the quarter,
    // we move the indicator back to "Pending" status to unlock it for the User.
    if (updateData.deadline || updateData.activeQuarter) {
      updateData.status = "Pending";
    }

    const updated = await Indicator.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate("assignee", "name email groupName")
     .populate({ path: "strategicPlanId", select: "perspective objectives" });

    if (!updated) {
      return res.status(404).json({ success: false, message: "Indicator not found" });
    }

    // 2. RECALCULATE
    // Ensure the total progress and aggregates are synced with the manual update
    const finalState = await Indicator.calculateProgress(updated._id as Types.ObjectId);

    res.status(200).json({ 
      success: true, 
      message: updateData.activeQuarter ? "Next reporting phase opened." : "Governance records updated.",
      data: transformIndicator(finalState || updated) 
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 3. DELETE INDICATOR
 */
export const deleteIndicator = async (req: Request, res: Response) => {
  try {
    await Indicator.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: "Indicator deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 4. GET ALL SUBMISSIONS (Flattened Queue for Admin)
 */
export const getAllSubmissions = async (_req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find({ "submissions.0": { $exists: true } })
      .populate("assignee", "name email groupName")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ updatedAt: -1 });

    const flatQueue = indicators.map((ind: any) => {
      const latestSub = ind.submissions[ind.submissions.length - 1];
      const transformed = transformIndicator(ind);

      return {
        _id: ind._id,
        indicatorTitle: transformed.activityDescription,
        submittedBy: transformed.assigneeDisplayName,
        submittedOn: latestSub?.submittedAt,
        status: ind.status,
        progress: ind.progress,
        quarter: latestSub?.quarter
      };
    });

    res.status(200).json({ success: true, data: flatQueue });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 5. GET REJECTED BY ADMIN (Oversight)
 */
export const getRejectedByAdmin = async (_req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find({ status: "Rejected by Admin" })
      .populate("assignee", "name email title")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ updatedAt: -1 });

    res.status(200).json({ 
      success: true, 
      count: indicators.length, 
      data: indicators.map(transformIndicator) 
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 6. SUPER ADMIN STATS (Aggregates)
 */
export const getSuperAdminStats = async (req: Request, res: Response) => {
  try {
    const [totalIndicators, statusCounts, perspectiveStats] = await Promise.all([
      Indicator.countDocuments(),
      Indicator.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Indicator.aggregate([
        { $lookup: { from: "strategicplans", localField: "strategicPlanId", foreignField: "_id", as: "plan" } },
        { $unwind: "$plan" },
        { $group: { _id: "$plan.perspective", avgProgress: { $avg: "$progress" }, count: { $sum: 1 } } },
        { $project: { name: { $toUpper: "$_id" }, val: { $round: ["$avgProgress", 0] }, count: 1, _id: 0 } }
      ])
    ]);

    const stats = statusCounts.reduce((acc: any, curr: any) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        total: totalIndicators,
        awaitingAdmin: stats["Awaiting Admin Approval"] || 0,
        awaitingSuperAdmin: stats["Awaiting Super Admin"] || 0,
        completed: stats["Completed"] || 0,
        perspectiveStats
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// --- CORE READ OPERATIONS ---

export const getIndicatorById = async (req: Request, res: Response) => {
  try {
    const indicator = await Indicator.findById(req.params.id)
      .populate("assignee", "name email title pjNumber groupName department")
      .populate("assignedBy", "name email")
      .populate({ path: "strategicPlanId", select: "perspective objectives" });

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

export const getAllIndicators = async (_req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find()
      .populate("assignee", "name email groupName")
      .populate({ path: "strategicPlanId", select: "perspective objectives" })
      .sort({ createdAt: -1 });

    res
      .status(200)
      .json({ success: true, data: indicators.map(transformIndicator) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// --- USER OPERATIONS ---

/**
 * @desc User submits or resubmits progress
 */
export const submitProgress = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      quarter,
      notes,
      evidenceUrl,
      evidencePublicId,
      achievedValue,
      fileType,
    } = req.body;

    const quarterNum = Number(quarter) as 1 | 2 | 3 | 4;
    const currentYear = new Date().getFullYear();

    // 1. Registry Gatekeeper
    const registryConfig = await RegistryConfiguration.findOne({
      quarter: quarterNum,
      year: currentYear,
    });
    if (!registryConfig)
      return res
        .status(403)
        .json({ success: false, message: "Registry not configured." });

    const now = new Date();
    if (
      now < registryConfig.startDate ||
      now > registryConfig.endDate ||
      registryConfig.isLocked
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "The Registry window is currently closed.",
        });
    }

    const indicator = await Indicator.findById(id);
    if (!indicator)
      return res
        .status(404)
        .json({ success: false, message: "Indicator not found" });

    // 2. Submission Logic
    let sub = indicator.submissions.find((s) => s.quarter === quarterNum);

    if (sub) {
      if (sub.reviewStatus === "Accepted")
        return res
          .status(400)
          .json({ success: false, message: "Approved quarters are locked." });

      sub.notes = notes;
      sub.documents = [
        { evidenceUrl, evidencePublicId, fileType: fileType || "raw" },
      ];
      sub.achievedValue = Number(achievedValue);
      sub.reviewStatus = "Pending";
      sub.isReviewed = false;
      sub.resubmissionCount += 1;
      sub.submittedAt = new Date();
    } else {
      indicator.submissions.push({
        quarter: quarterNum,
        notes,
        documents: [
          { evidenceUrl, evidencePublicId, fileType: fileType || "raw" },
        ],
        achievedValue: Number(achievedValue),
        reviewStatus: "Pending",
        submittedAt: new Date(),
      } as any);
    }

    // 3. Status Transition
    indicator.status = "Awaiting Admin Approval";
    indicator.reviewHistory.push({
      action: "Resubmitted",
      reason: `Quarter ${quarterNum} update submitted.`,
      reviewerRole: "user",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    });

    await indicator.save();
    res.status(200).json({ success: true, message: "Submission successful." });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * 🛡️ SUPER ADMIN CERTIFICATION PROCESS (Audit remains on current quarter)
 */
export const superAdminReviewProcess = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { decision, reason, progressOverride } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator) return res.status(404).json({ success: false, message: "Indicator not found" });

    const isApprove = decision === "Approved";

    // 1. Identify current submission
    const currentSub = indicator.submissions.find(s => s.quarter === indicator.activeQuarter);

    if (currentSub) {
      currentSub.reviewStatus = isApprove ? "Accepted" : "Rejected";
      currentSub.isReviewed = true;
      
      if (isApprove && progressOverride !== undefined) {
        currentSub.achievedValue = Number(progressOverride);
      } else if (!isApprove) {
        currentSub.adminComment = reason;
      }
    }

    // 2. Log History
    indicator.reviewHistory.push({
      action: isApprove ? "Approved" : "Rejected",
      reason: reason || (isApprove ? "Certified by Super Admin" : "Rejected by Super Admin"),
      reviewerRole: "superadmin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    } as any);

    // 3. Save & Recalculate 
    // (Model now stays on the current quarter and sets status to "Completed")
    await indicator.save();
    const updated = await Indicator.calculateProgress(indicator._id as Types.ObjectId);

    const finalData = await Indicator.findById(id)
      .populate("assignee", "name email groupName")
      .populate({ path: "strategicPlanId", select: "perspective objectives" });

    res.status(200).json({
      success: true,
      message: isApprove 
        ? "Performance certified. Awaiting manual opening of next phase." 
        : "Submission rejected.",
      data: transformIndicator(finalData)
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 2. Super Admin Decision (Simplified Wrapper)
 * If you have a separate "Quick Decision" button, it now uses the same logic.
 */
export const superAdminDecision = async (req: Request, res: Response) => {
  // We simply redirect to the main process to ensure logic parity
  return superAdminReviewProcess(req, res);
};

// --- SYSTEM & REGISTRY OPERATIONS ---

export const updateRegistrySettings = async (req: Request, res: Response) => {
  try {
    const { quarter, year, startDate, endDate, isLocked } = req.body;
    const config = await RegistryConfiguration.findOneAndUpdate(
      { quarter, year },
      { startDate, endDate, isLocked },
      { upsert: true, new: true },
    );
    res.status(200).json({ success: true, data: config });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getRegistryStatus = async (_req: Request, res: Response) => {
  try {
    const year = new Date().getFullYear();
    const settings = await RegistryConfiguration.find({ year });
    res.status(200).json({ success: true, data: settings });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
