import { Request, Response } from "express";
import { Indicator, ISubmission } from "../user/Indicator.model";
import { Types } from "mongoose";
import { RegistryConfiguration } from "../user/RegistryConfiguration";
import mongoose from "mongoose";

/**
 * HELPER: transformIndicator
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
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription: activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: displayName,
    // UI Logic: Needs action if rejected at any level
    needsAction: ["Rejected by Admin", "Rejected by Super Admin"].includes(indObj.status),
  };
};


/**
 * @desc 1. CREATE INDICATOR (Super Admin / Management)
 */
export const createIndicator = async (req: Request, res: Response) => {
  try {
    const {
      strategicPlanId, objectiveId, activityId, assignee,
      assignmentType, reportingCycle, weight, unit, target,
      deadline, instructions
    } = req.body;

    // Default activeQuarter to 0 if Annual, else 1
    const initialQuarter = reportingCycle === "Annual" ? 0 : 1;

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
      activeQuarter: initialQuarter,
      assignedBy: (req as any).user?._id,
      status: "Pending",
    });

    res.status(201).json({ success: true, data: indicator });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc 2. UPDATE INDICATOR
 * Refined to let the Model Hook handle status transitions.
 */
export const updateIndicator = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const indicator = await Indicator.findById(id);
    
    if (!indicator) return res.status(404).json({ success: false, message: "Not found" });

    // Apply updates via Object.assign to trigger 'save' middleware correctly
    Object.assign(indicator, req.body);

    // If core tracking parameters change, we manually reset status to Pending
    // to force a fresh review cycle, then save triggers the logic engine.
    if (req.body.deadline || req.body.activeQuarter !== undefined || req.body.target) {
      indicator.status = "Pending";
    }

    await indicator.save();
    
    const populated = await indicator.populate([
      { path: "assignee", select: "name email groupName" },
      { path: "strategicPlanId", select: "perspective objectives" }
    ]);

    res.status(200).json({ success: true, data: transformIndicator(populated) });
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
 * @desc 4. GET ALL SUBMISSIONS (Work Queue for Super Admin)
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
        quarter: latestSub?.quarter === 0 ? "Annual" : `Q${latestSub?.quarter}`,
        // 🔹 New field: Count of attached evidence files
        documentsCount: latestSub?.documents?.length || 0 
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
 * @desc 5. SUPER ADMIN STATS (Aggregates)
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
    res.status(500).json({ success: false, message: "Internal server error" });
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

/**
 * @desc 3. SUBMIT PROGRESS (User)
 * Aligned with IDocument[] array and Registry validation
 */
export const submitProgress = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { notes, evidenceUrl, evidencePublicId, achievedValue, fileType, fileName } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator) return res.status(404).json({ message: "Indicator not found" });

    const targetQuarter = indicator.reportingCycle === "Annual" ? 0 : indicator.activeQuarter;
    const currentYear = new Date().getFullYear();

    // 1. Registry Validation
    const registryConfig = await RegistryConfiguration.findOne({ 
      quarter: targetQuarter, 
      year: currentYear 
    });

    if (!registryConfig || registryConfig.isLocked) {
      return res.status(403).json({ message: "Reporting window is currently closed or locked for this period." });
    }

    // 2. Document Construction (Matches IDocument interface)
    const newDocument = {
      evidenceUrl,
      evidencePublicId,
      fileType: fileType || "raw",
      fileName: fileName || "Attachment"
    };

   // 3. Update or Push Submission
let sub = indicator.submissions.find((s: ISubmission) => s.quarter === targetQuarter);

    if (sub) {
      if (sub.reviewStatus === "Accepted") {
        return res.status(400).json({ message: "Approved cycles are locked for editing." });
      }
      sub.notes = notes;
      sub.achievedValue = Number(achievedValue);
      sub.documents = [newDocument]; // Replaces current docs with new upload
      sub.reviewStatus = "Pending";
      sub.submittedAt = new Date();
      sub.resubmissionCount += 1;
    } else {
      indicator.submissions.push({
        quarter: targetQuarter,
        notes,
        achievedValue: Number(achievedValue),
        documents: [newDocument],
        reviewStatus: "Pending",
        submittedAt: new Date(),
        isReviewed: false,
        resubmissionCount: 0
      } as any);
    }

    // 4. Trigger Model Middleware
    // This will automatically:
    // - Recalculate progress based on 'Accepted' subs
    // - Set status to 'Awaiting Admin Approval'
    await indicator.save();

    res.status(200).json({ success: true, message: "Progress submitted successfully." });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * @desc 4. SUPER ADMIN REVIEW (Atomic Transaction)
 * Ensures history and status updates are atomic.
 */
export const superAdminReviewProcess = async (req: Request, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { decision, reason, progressOverride } = req.body;

    const indicator = await Indicator.findById(id).session(session);
    if (!indicator) throw new Error("Indicator not found");

    const isApprove = decision === "Approved";
    const targetQ = indicator.reportingCycle === "Annual" ? 0 : indicator.activeQuarter;
    const currentSub = indicator.submissions.find((s: ISubmission) => s.quarter === targetQ);

    // Update specific submission status
    if (currentSub) {
      currentSub.reviewStatus = isApprove ? "Accepted" : "Rejected";
      currentSub.isReviewed = true;
      if (isApprove && progressOverride !== undefined) {
          currentSub.achievedValue = Number(progressOverride);
      }
      if (!isApprove) currentSub.adminComment = reason;
    }

    // Append to History
    indicator.reviewHistory.push({
      action: isApprove ? "Approved" : "Rejected",
      reason: reason || (isApprove ? "Performance Certified" : "Criteria not met"),
      reviewerRole: "superadmin",
      reviewedBy: (req as any).user?._id,
      at: new Date(),
    } as any);

    // Save triggers the logic engine hook to set indicator.status to "Completed" or "Rejected..."
    await indicator.save({ session });
    
    await session.commitTransaction();
    
    const final = await indicator.populate([
        { path: "assignee", select: "name email groupName" },
        { path: "strategicPlanId", select: "perspective objectives" }
    ]);

    res.status(200).json({ success: true, data: transformIndicator(final) });
  } catch (error: any) {
    await session.abortTransaction();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
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
