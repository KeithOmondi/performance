import { Request, Response } from "express";
import { Indicator } from "../user/Indicator.model";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import { User } from "../user/user.model";

/**
 * HELPER: transformIndicator
 * Ensures consistent data structure across all admin/super-admin views.
 */
const transformIndicator = (ind: any) => {
  const indObj = typeof ind.toObject === 'function' ? ind.toObject() : ind;
  const plan = indObj.strategicPlanId;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id.toString() === indObj.objectiveId?.toString()
  );
  const activity = objective?.activities?.find(
    (act: any) => act._id.toString() === indObj.activityId?.toString()
  );

  let displayName = "Unassigned";
  if (Array.isArray(indObj.assignee)) {
    displayName = indObj.assignee
      .map((a: any) => (typeof a === 'object' ? (a.name || a.groupName) : 'Team Member'))
      .filter(Boolean)
      .join(", ");
  } else if (indObj.assignee && typeof indObj.assignee === 'object') {
    displayName = indObj.assignee.name || indObj.assignee.groupName || "Unassigned";
  }

  return {
    ...indObj,
    _id: indObj._id.toString(),
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription: activity?.description || indObj.instructions || "No activity text",
    assigneeDisplayName: displayName,
    isResubmission: indObj.submissions?.some((s: any) => (s.resubmissionCount || 0) > 0 && s.reviewStatus === "Pending")
  };
};


/**
 * @desc    Create Indicator (Admin assigns KPI to User or Team)
 */
export const createIndicator = async (req: Request, res: Response) => {
  try {
    const {
      strategicPlanId,
      objectiveId,
      activityId,
      assignee, // This comes as a string (User) or string[] (Team)
      assignmentType,
      reportingCycle,
      weight,
      unit,
      target,
      deadline,
      instructions,
      assignedBy
    } = req.body;

    if (!strategicPlanId || !objectiveId || !activityId || !assignee || !assignmentType || !deadline) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing.",
      });
    }

    // SANITIZATION LOGIC:
    // If the frontend sent an array for a single User, extract the first ID.
    // If the frontend sent a string for a Team, wrap it in an array.
    let finalAssignee = assignee;
    if (assignmentType === "Team" && !Array.isArray(assignee)) {
      finalAssignee = [assignee];
    } else if (assignmentType === "User" && Array.isArray(assignee)) {
      finalAssignee = assignee[0];
    }

    const indicator = await Indicator.create({
      strategicPlanId,
      objectiveId,
      activityId,
      assignee: finalAssignee,
      assignmentType,
      reportingCycle: reportingCycle || "Quarterly",
      weight: weight || 5,
      unit: unit || "%",
      target: target || 100,
      deadline,
      instructions,
      assignedBy,
      status: "Active"
    });

    res.status(201).json({
      success: true,
      message: `Indicator assigned successfully to ${assignmentType}`,
      data: indicator,
    });
  } catch (error: any) {
    // If you still see "Cast to ObjectId failed", the Schema itself MUST be updated to:
    // assignee: { type: Schema.Types.Mixed } OR assignee: [{ type: Schema.Types.ObjectId }]
    res.status(500).json({ success: false, message: error.message });
  }
};


export const getSuperAdminStats = async (req: Request, res: Response) => {
  try {
    // 1. Basic Counts
    const [totalIndicators, totalUsers] = await Promise.all([
      Indicator.countDocuments(),
      User.countDocuments(),
    ]);

    // 2. Status Aggregation
    const statusCounts = await Indicator.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    const statsByStatus = statusCounts.reduce((acc: any, curr: any) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    // 3. Perspective Progress (The 500 Fixer)
    const perspectiveStats = await Indicator.aggregate([
      // Ensure we have a valid ID and convert it to ObjectId for the join
      { $match: { strategicPlanId: { $ne: null } } },
      {
        $addFields: {
          strategicPlanId: { $toObjectId: "$strategicPlanId" }
        }
      },
      {
        $group: {
          _id: "$strategicPlanId",
          avgProgress: { $avg: { $ifNull: ["$progress", 0] } },
          activityCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: "strategicplans", // Exact Mongoose pluralization
          localField: "_id",
          foreignField: "_id",
          as: "planDetails"
        }
      },
      // preserveNullAndEmptyArrays prevents the crash if a plan is missing
      { $unwind: { path: "$planDetails", preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: "$planDetails.perspective",
          val: { $avg: "$avgProgress" },
          count: { $sum: "$activityCount" }
        }
      },
      {
        $project: {
          _id: 0,
          name: { $toUpper: "$_id" },
          val: { $round: ["$val", 0] },
          count: 1
        }
      }
    ]);

    // 4. Manual Overdue Count
    const overdueCount = await Indicator.countDocuments({
      deadline: { $lt: new Date() },
      status: { $ne: "Reviewed" }
    });

    res.status(200).json({
      success: true,
      data: {
        general: {
          total: totalIndicators,
          users: totalUsers,
          awaitingReview: (statsByStatus["Submitted"] || 0) + (statsByStatus["Awaiting Super Admin"] || 0),
          approved: statsByStatus["Reviewed"] || 0,
          rejected: statsByStatus["Rejected by Admin"] || 0,
          overdue: overdueCount,
          assigned: await Indicator.countDocuments({ assignee: { $exists: true, $ne: null } })
        },
        perspectiveStats
      }
    });
  } catch (error: any) {
    console.error("STATS_ERROR >>", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get Single Indicator (Handles dynamic population)
 */
export const getIndicatorById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (typeof id !== 'string') {
        return res.status(400).json({ message: "Invalid ID format" });
    }

    const indicator = await Indicator.findById(id)
      // Mongoose automatically uses 'assignmentType' to decide which collection to populate from
      .populate("assignee", "name email title pjNumber groupName department")
      .populate("assignedBy", "name email")
      .populate({
        path: "strategicPlanId",
        select: "perspective objectives",
      });

    if (!indicator) {
      return res.status(404).json({ success: false, message: "Indicator not found" });
    }

    res.status(200).json({ success: true, data: transformIndicator(indicator) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get All Indicators (Populated for Admin view)
 */
export const getAllIndicators = async (_req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find()
      .populate("assignee", "name email title pjNumber groupName")
      .populate("assignedBy", "name email")
      .populate({
        path: "strategicPlanId",
        model: StrategicPlan,
        select: "perspective objectives"
      })
      .sort({ createdAt: -1 });

    const transformedData = indicators.map(transformIndicator);

    res.status(200).json({
      success: true,
      count: indicators.length,
      data: transformedData,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get All Submissions Queue (Flattened for UI table)
 */
export const getAllSubmissions = async (_req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find({ "submissions.0": { $exists: true } })
      .populate("assignee", "name email title groupName")
      .populate({
        path: "strategicPlanId",
        select: "perspective objectives",
      })
      .sort({ "submissions.submittedAt": -1 });

    const flatQueue = indicators.map((ind: any) => {
      const latestSub = ind.submissions[ind.submissions.length - 1];
      const plan = ind.strategicPlanId;
      const objective = plan?.objectives?.find(
        (obj: any) => obj._id.toString() === ind.objectiveId?.toString()
      );
      const activity = objective?.activities?.find(
        (act: any) => act._id.toString() === ind.activityId?.toString()
      );

      return {
        _id: ind._id,
        indicatorTitle: activity?.description || ind.instructions || "KPI",
        // Dynamic name resolution
        submittedBy: ind.assignee?.name || ind.assignee?.groupName || "Unknown",
        isTeam: ind.assignmentType === "Team",
        documentsCount: latestSub?.evidenceUrl ? 1 : 0,
        submittedOn: latestSub?.submittedAt,
        status: ind.status,
        latestSubmission: latestSub
      };
    });

    res.status(200).json({
      success: true,
      data: flatQueue,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Submit Progress (Handles both Quarterly and Annual)
 * @route   POST /api/indicators/:id/submit
 */
export const submitProgress = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { quarter, notes, evidenceUrl, achievedValue, fileType } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator) return res.status(404).json({ success: false, message: "Indicator not found" });

    // 1. If Quarterly, check for duplicate quarter
    if (indicator.reportingCycle === "Quarterly") {
      const existingQuarter = indicator.submissions.find((sub) => sub.quarter === Number(quarter));
      if (existingQuarter) {
        return res.status(400).json({
          success: false,
          message: `Progress for Quarter ${quarter} has already been submitted.`,
        });
      }
    }

    // 2. Push submission (Using the new ISubmission structure from your model)
    indicator.submissions.push({
      quarter: indicator.reportingCycle === "Annual" ? 1 : (Number(quarter) as 1 | 2 | 3 | 4),
      notes,
      evidenceUrl,
      fileType: fileType || "image",
      achievedValue: Number(achievedValue),
      submittedAt: new Date(),
      isReviewed: false,
      reviewStatus: "Pending"
    } as any);

    await indicator.save();

    res.status(200).json({ success: true, message: "Progress submitted successfully", data: indicator });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Update Indicator Meta
 * @route   PATCH /api/indicators/:id
 */
export const updateIndicator = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updatedIndicator = await Indicator.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    ).populate("assignee", "name email groupName");

    if (!updatedIndicator) return res.status(404).json({ message: "Indicator not found" });

    res.status(200).json({ success: true, data: updatedIndicator });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Delete Indicator
 * @route   DELETE /api/indicators/:id
 */
export const deleteIndicator = async (req: Request, res: Response) => {
  try {
    const indicator = await Indicator.findByIdAndDelete(req.params.id);
    if (!indicator) return res.status(404).json({ success: false, message: "Indicator not found" });
    res.status(200).json({ success: true, message: "Indicator deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    General Process Review (Admin/Reviewer level)
 */
export const processReview = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { decision, reason, reviewerRole, progressOverride } = req.body;

    const indicator = await Indicator.findById(id);
    if (!indicator) return res.status(404).json({ success: false, message: "Indicator not found" });

    const latestSub = indicator.submissions[indicator.submissions.length - 1];
    
    // Optional progress update during standard review
    if (typeof progressOverride === 'number') {
      indicator.progress = progressOverride;
    }

    if (decision === "Approved") {
      indicator.status = reviewerRole === "SuperAdmin" ? "Reviewed" : "Awaiting Super Admin";
      if (latestSub) {
        latestSub.isReviewed = true;
        latestSub.reviewStatus = "Accepted";
      }
    } else {
      indicator.status = "Rejected by Admin";
      if (latestSub) {
        latestSub.isReviewed = false;
        latestSub.reviewStatus = "Rejected";
        latestSub.adminComment = reason;
      }
    }

    indicator.reviewHistory.push({
      action: `${decision} by ${reviewerRole}`,
      reason: reason,
      reviewedBy: (req as any).user?._id, 
      at: new Date()
    } as any);

    await indicator.save();

    res.status(200).json({
      success: true,
      data: transformIndicator(indicator),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Final Decision by Super Admin (Finalize or Reject)
 * @route   POST /api/indicators/super-admin/decision/:id
 * @logic   Allows Super Admin to set the final Progress % and Decision
 */
export const superAdminDecision = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { decision, reason, progressOverride } = req.body; 

    if (!decision || !reason) {
      return res.status(400).json({ 
        success: false, 
        message: "Decision and justification are required." 
      });
    }

    const indicator = await Indicator.findById(id);
    if (!indicator) return res.status(404).json({ success: false, message: "Indicator not found" });

    const latestSub = indicator.submissions[indicator.submissions.length - 1];

    // 1. Update Progress if Super Admin provided a percentage (0-100)
    if (typeof progressOverride === 'number') {
      indicator.progress = Math.min(100, Math.max(0, progressOverride));
    }

    // 2. Handle Decision
    if (decision === "Approve") {
      indicator.status = "Reviewed"; 
      if (latestSub) {
        latestSub.isReviewed = true;
        latestSub.reviewStatus = "Accepted";
      }
    } else {
      indicator.status = "Rejected by Admin"; // Sends it back to the user/admin flow
      if (latestSub) {
        latestSub.isReviewed = false;
        latestSub.reviewStatus = "Rejected";
        latestSub.adminComment = `Super Admin Decision: ${reason}`;
      }
    }

    // 3. Log to Audit Trail
    indicator.reviewHistory.push({
      action: decision === "Approve" ? "Final Approval (Super Admin)" : "Final Rejection (Super Admin)",
      reason: reason,
      reviewedBy: (req as any).user?._id,
      at: new Date()
    } as any);

    await indicator.save();

    const updated = await Indicator.findById(id)
      .populate("assignee", "name email title")
      .populate({ path: "strategicPlanId", model: StrategicPlan });

    res.status(200).json({
      success: true,
      message: `Super Admin decision processed. Progress set to ${indicator.progress}%`,
      data: transformIndicator(updated),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * @desc    Get All Indicators Rejected by Admin (For Super Admin oversight)
 * @route   GET /api/admin/indicators/rejected-by-admin
 */
export const getRejectedByAdmin = async (req: Request, res: Response) => {
  try {
    const indicators = await Indicator.find({ status: "Rejected by Admin" })
      .populate("assignee", "name email title pjNumber groupName")
      .populate("assignedBy", "name email")
      .populate({ path: "strategicPlanId", model: StrategicPlan, select: "perspective objectives" })
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




