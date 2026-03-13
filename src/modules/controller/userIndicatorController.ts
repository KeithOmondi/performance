import { Request, Response } from "express";
import { Indicator, IDocument } from "../user/Indicator.model";
import { uploadMultipleToCloudinary } from "../../config/cloudinary";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import mongoose from "mongoose";

/**
 * Helper to transform Indicator data for UI consumption.
 */
const transformIndicator = (ind: any) => {
  if (!ind) return null;
  const plan = ind.strategicPlanId;
  const targetObjId = ind.objectiveId ? String(ind.objectiveId) : null;
  const targetActId = ind.activityId ? String(ind.activityId) : null;

  const objective = plan?.objectives?.find(
    (obj: any) => obj._id && String(obj._id) === targetObjId
  );

  const activity = objective?.activities?.find(
    (act: any) => act._id && String(act._id) === targetActId
  );

  const rawData = typeof ind.toObject === "function" ? ind.toObject() : ind;

  return {
    ...rawData,
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Unknown Objective",
    activityDescription:
      activity?.description || ind.instructions || "No activity text provided",
  };
};

export const UserIndicatorController = {
  /**
   * 1. FETCH ASSIGNED INDICATORS
   */
  getMyIndicators: async (req: Request, res: Response) => {
    try {
      const userId = new mongoose.Types.ObjectId(req.user._id);

      const indicators = await Indicator.find({ assignee: userId })
        .populate({ path: "assignee", select: "name email pjNumber teamName" })
        .populate("assignedBy", "name")
        .populate({
          path: "strategicPlanId",
          model: StrategicPlan,
          select: "perspective objectives",
        })
        .sort({ updatedAt: -1 });

      const transformedData = indicators.map(transformIndicator);
      res.status(200).json({ success: true, data: transformedData });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * 2. SMART SUBMISSION (Certification Aware)
   */
  submitProgress: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const userId = new mongoose.Types.ObjectId(req.user._id);

      const indicator = await Indicator.findOne({ _id: id, assignee: userId });

      if (!indicator) {
        return res.status(404).json({ success: false, message: "Registry record not found" });
      }

      const isAnnual = indicator.reportingCycle === "Annual";
      
      /**
       * 🛡️ CERTIFICATION LOGIC: 
       * Quarterly: Uses activeQuarter (1-4).
       * Annual: Uses Quarter 0 (The cumulative year bucket).
       */
      const targetQuarter = isAnnual ? 0 : indicator.activeQuarter;

      // Find existing submission for the determined target
      let submission = indicator.submissions.find((s) => s.quarter === targetQuarter);

      if (submission) {
        // Cannot modify if currently under audit by Admin/Super Admin
        if (submission.reviewStatus === "Pending") {
          return res.status(400).json({
            success: false,
            message: `The ${isAnnual ? 'Annual' : 'Q' + targetQuarter} dossier is currently in audit.`,
          });
        }
        
        // If Accepted, user must wait for next cycle opening
        if (submission.reviewStatus === "Accepted") {
          return res.status(400).json({
            success: false,
            message: `${isAnnual ? 'Annual' : 'Q' + targetQuarter} is already certified. Changes require Admin intervention.`,
          });
        }
      }

      // Handle File Uploads
      const files = req.files as Express.Multer.File[];
      const uploadResults = files?.length > 0 
        ? await uploadMultipleToCloudinary(files, "submissions") 
        : [];

      const newDocuments: IDocument[] = uploadResults.map((result, index) => ({
        evidenceUrl: result.secure_url,
        evidencePublicId: result.public_id,
        fileType: result.resource_type === "video" ? "video" : files[index].mimetype === "application/pdf" ? "raw" : "image",
        fileName: files[index].originalname,
      }));

      if (submission) {
        // AMEND EXISTING (Resubmission flow)
        submission.notes = notes;
        submission.documents = [...submission.documents, ...newDocuments];
        submission.reviewStatus = "Pending";
        submission.isReviewed = false;
        submission.submittedAt = new Date();
        submission.resubmissionCount += 1;

        indicator.reviewHistory.push({
          action: "Resubmitted",
          reason: `Amended evidence for ${isAnnual ? 'Annual Review' : 'Q' + targetQuarter}`,
          reviewerRole: "user",
          reviewedBy: userId,
          at: new Date(),
        } as any);
      } else {
        // FRESH SUBMISSION
        indicator.submissions.push({
          quarter: targetQuarter,
          notes,
          achievedValue: 0, // Admin will set this during review
          documents: newDocuments,
          submittedAt: new Date(),
          isReviewed: false,
          reviewStatus: "Pending",
          resubmissionCount: 0,
        } as any);
      }

      /**
       * 🔹 LOCKING THE STATUS
       * We explicitly set this to "Awaiting Admin Approval". 
       * This overrides any logic that might accidentally mark it "Completed" 
       * before the Super Admin sees it.
       */
      indicator.status = "Awaiting Admin Approval";
      
      await indicator.save();

      // Trigger the Model logic to sync progress (this updates total progress % but keeps status locked)
      await (Indicator as any).calculateProgress(indicator._id);

      const finalResult = await Indicator.findById(indicator._id)
        .populate("assignee", "name email")
        .populate({ path: "strategicPlanId", model: StrategicPlan });

      res.status(201).json({ 
        success: true, 
        message: `${isAnnual ? 'Annual' : 'Q' + targetQuarter} dossier submitted for certification.`,
        data: transformIndicator(finalResult) 
      });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * 3. GET SINGLE INDICATOR DETAILS
   */
  getIndicatorDetails: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = new mongoose.Types.ObjectId(req.user._id);

      const indicator = await Indicator.findOne({ _id: id, assignee: userId })
        .populate({
          path: "strategicPlanId",
          model: StrategicPlan,
          select: "perspective objectives",
        })
        .populate("assignee", "name email pjNumber teamName")
        .populate("assignedBy", "name");

      if (!indicator) return res.status(404).json({ message: "Indicator not found" });

      res.status(200).json({ success: true, data: transformIndicator(indicator) });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },
};