import { Request, Response } from "express";
import { Indicator, IDocument, ISubmission } from "../user/Indicator.model";
import { uploadMultipleToCloudinary } from "../../config/cloudinary";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import mongoose from "mongoose";

/**
 * 🛠 DATA TRANSFORMER
 * Refined to handle .lean() POJOs and Mongoose Documents interchangeably.
 * Uses optional chaining to prevent 500 crashes on null/undefined relations.
 */
const transformIndicator = (ind: any) => {
  if (!ind) return null;
  
  // 🛡️ Guard: Handle both Mongoose Doc and Plain Object from .lean()
  const rawData = typeof ind.toObject === "function" ? ind.toObject() : ind;
  
  const plan = rawData.strategicPlanId;
  const targetObjId = rawData.objectiveId ? String(rawData.objectiveId) : null;
  const targetActId = rawData.activityId ? String(rawData.activityId) : null;

  // 🛡️ Guard: Find the specific objective within the plan safely
  const objective = plan?.objectives?.find(
    (obj: any) => obj?._id && String(obj._id) === targetObjId
  );

  // 🛡️ Guard: Find the specific activity within that objective safely
  const activity = objective?.activities?.find(
    (act: any) => act?._id && String(act._id) === targetActId
  );

  return {
    ...rawData,
    // Provide fallbacks for UI fields to prevent "undefined" in frontend
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Strategic Objective",
    activityDescription: activity?.description || rawData.instructions || "No description provided",
    // Preserve the ID for the frontend even if populated
    strategicPlanId: plan?._id || rawData.strategicPlanId,
    // Ensure arrays exist even if DB record is sparse
    submissions: rawData.submissions || [],
    reviewHistory: rawData.reviewHistory || [],
  };
};

export const UserIndicatorController = {
  /**
   * 1. GET MY ASSIGNMENTS
   */
  getMyIndicators: async (req: Request, res: Response) => {
    try {
      console.log("🔍 Fetching assignments for user:", req.user?._id);

      if (!req.user?._id) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }

      const userId = new mongoose.Types.ObjectId(req.user._id);

      const indicators = await Indicator.find({ assignee: userId })
        .populate({ path: "assignee", select: "name email pjNumber teamName" })
        .populate("assignedBy", "name")
        .populate({
          path: "strategicPlanId",
          model: "StrategicPlan",
          select: "perspective objectives", 
        })
        .sort({ updatedAt: -1 })
        .lean();

      console.log(`📦 DB Found ${indicators.length} indicators for user ${userId}`);

      // Log the first raw indicator to see if strategicPlanId populated correctly
      if (indicators.length > 0) {
        console.log("🛠 Sample Raw Data (First Item):", {
          id: indicators[0]._id,
          hasPlan: !!indicators[0].strategicPlanId,
          planDetails: indicators[0].strategicPlanId?.perspective || "MISSING_PERSPECTIVE"
        });
      }

      const transformedData = indicators.map((ind, index) => {
        try {
          return transformIndicator(ind);
        } catch (err: any) {
          console.error(`❌ Transformation failed at index ${index} (ID: ${ind._id}):`, err.message);
          throw err; // Re-throw to trigger catch block
        }
      });

      console.log("✅ Transformation complete. Sending response...");

      res.status(200).json({ 
        success: true, 
        results: indicators.length,
        data: transformedData 
      });
    } catch (error: any) {
      console.error("🔥 GET_MY_INDICATORS_CRASH:", error); // Log full error object, not just message
      res.status(500).json({ 
        success: false, 
        message: "Error processing assignments registry data.",
        error: error.message // Temporarily sending error to frontend for debugging
      });
    }
  },

  /**
   * 2. SUBMIT PROGRESS / DOSSIER
   */
  submitProgress: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { notes, achievedValue } = req.body; 
      const userId = req.user._id;

      // Do NOT use .lean() here, we need the .save() method
      const indicator = await Indicator.findOne({ _id: id, assignee: userId });
      
      if (!indicator) {
        return res.status(404).json({ success: false, message: "Indicator dossier not found" });
      }

      const isAnnual = indicator.reportingCycle === "Annual";
      const targetQuarter = isAnnual ? 0 : indicator.activeQuarter;

      let submission = indicator.submissions.find(
        (s: ISubmission) => s.quarter === targetQuarter
      );

      // BLOCKER: State Firewall
      if (submission) {
        if (submission.reviewStatus === "Pending" || indicator.status === "Awaiting Super Admin") {
          return res.status(400).json({
            success: false,
            message: "Submission locked. Currently undergoing Registry Audit.",
          });
        }
        if (submission.reviewStatus === "Accepted") {
          return { success: false, message: "Cycle certified. No further filings allowed." };
        }
      }

      // Handle Files
      const files = req.files as Express.Multer.File[];
      let newDocuments: IDocument[] = [];
      
      if (files && files.length > 0) {
        const uploadResults = await uploadMultipleToCloudinary(files, "registry_evidence");
        newDocuments = uploadResults.map((result, index) => ({
          evidenceUrl: result.secure_url,
          evidencePublicId: result.public_id,
          fileType: result.resource_type === "video" ? "video" : 
                    files[index].mimetype === "application/pdf" ? "raw" : "image",
          fileName: files[index].originalname,
        }));
      }

      if (submission) {
        // Update existing logic
        submission.notes = notes || submission.notes;
        submission.achievedValue = Number(achievedValue) || submission.achievedValue;
        submission.documents.push(...newDocuments);
        submission.reviewStatus = "Pending";
        submission.isReviewed = false;
        submission.submittedAt = new Date();
        submission.resubmissionCount += 1;

        indicator.reviewHistory.push({
          action: "Resubmitted",
          reason: `Evidence amended for review cycle.`,
          reviewerRole: "user",
          reviewedBy: userId,
          at: new Date(),
        } as any);
      } else {
        // Fresh submission logic
        indicator.submissions.push({
          quarter: targetQuarter,
          notes,
          achievedValue: Number(achievedValue) || 0,
          documents: newDocuments,
          submittedAt: new Date(),
          isReviewed: false,
          reviewStatus: "Pending",
          resubmissionCount: 0,
        } as any);
      }

      // Trigger re-audit
      indicator.status = "Awaiting Admin Approval";
      await indicator.save(); 

      res.status(201).json({
        success: true,
        message: "Submission successful.",
      });
    } catch (error: any) {
      console.error("🔥 SUBMISSION_CRASH:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * 3. GET SINGLE DOSSIER DETAILS
   */
  getIndicatorDetails: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = req.user._id;

      const indicator = await Indicator.findOne({ _id: id, assignee: userId })
        .populate({
          path: "strategicPlanId",
          model: "StrategicPlan",
          select: "perspective objectives",
        })
        .populate("assignee", "name email pjNumber teamName")
        .populate("assignedBy", "name")
        .populate("reviewHistory.reviewedBy", "name")
        .lean(); // Faster lookup for details

      if (!indicator) {
        return res.status(404).json({ success: false, message: "Indicator not found" });
      }

      res.status(200).json({ 
        success: true, 
        data: transformIndicator(indicator) 
      });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },
};