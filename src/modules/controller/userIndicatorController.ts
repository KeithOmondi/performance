import { Request, Response } from "express";
import { Indicator, IDocument } from "../user/Indicator.model";
import { uploadMultipleToCloudinary } from "../../config/cloudinary";
import StrategicPlan from "../SPlanning/strategicPlan.model";
import mongoose from "mongoose";

/**
 * Enhanced helper to transform Indicator data.
 * Handles Team vs User name resolution for the UI.
 */
const transformIndicator = (ind: any) => {
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
      const userIdString = String(req.user._id);

      const indicators = await Indicator.find({
        $or: [
          { assignee: userIdString },
          { assignee: { $in: [userIdString] } }
        ]
      })
        .populate({
          path: "assignee",
          select: "name email pjNumber teamName" 
        })
        .populate("assignedBy", "name")
        .populate({
          path: "strategicPlanId",
          model: StrategicPlan,
          select: "perspective objectives",
        })
        .sort({ deadline: 1 });

      const transformedData = indicators.map(transformIndicator);
      res.status(200).json({ success: true, data: transformedData });
    } catch (error: any) {
      console.error("Fetch Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * 2. SUBMIT PROGRESS (Multi-file enabled)
   */
  submitProgress: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { quarter, notes } = req.body;
      const userIdString = String(req.user._id);

      const indicator = await Indicator.findOne({
        _id: id,
        $or: [
          { assignee: userIdString },
          { assignee: { $in: [userIdString] } }
        ]
      });

      if (!indicator) {
        return res.status(404).json({ success: false, message: "Indicator not found" });
      }

      if (indicator.reportingCycle === "Quarterly") {
        const existingPending = indicator.submissions.find(
          (s) => s.quarter === Number(quarter) && s.reviewStatus === "Pending"
        );
        if (existingPending) {
          return res.status(400).json({
            success: false,
            message: `Quarter ${quarter} submission is already pending review.`,
          });
        }
      }

      // HANDLE MULTIPLE FILES
      let documents: IDocument[] = [];
      const files = req.files as Express.Multer.File[];

      if (files && files.length > 0) {
        const uploadResults = await uploadMultipleToCloudinary(files, "submissions");
        
        documents = uploadResults.map((result, index) => {
          // Explicitly typing the detected category to satisfy the "raw" | "image" | "video" union
          let type: "raw" | "image" | "video" = "image";
          if (result.resource_type === "video") {
            type = "video";
          } else if (files[index].mimetype === "application/pdf") {
            type = "raw";
          }

          return {
            evidenceUrl: result.secure_url,
            evidencePublicId: result.public_id,
            fileType: type,
            fileName: files[index].originalname
          };
        });
      }

      const submission = {
        _id: new mongoose.Types.ObjectId(),
        quarter: indicator.reportingCycle === "Annual" ? 1 : Number(quarter),
        notes,
        achievedValue: 0,
        // Fallback for legacy fields using the first file
        ...(documents.length > 0 ? {
            evidenceUrl: documents[0].evidenceUrl,
            evidencePublicId: documents[0].evidencePublicId,
            fileType: documents[0].fileType
        } : { fileType: "image" as const }),
        documents, 
        submittedAt: new Date(),
        isReviewed: false,
        reviewStatus: "Pending" as const,
        resubmissionCount: 0
      };

      indicator.submissions.push(submission as any);
      await indicator.save(); 

      const updated = await Indicator.findById(indicator._id)
        .populate("assignee", "name email")
        .populate({ path: "strategicPlanId", model: StrategicPlan });

      res.status(201).json({ success: true, data: transformIndicator(updated) });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * 3. RESUBMIT / EDIT (Multi-file enabled)
   */
  resubmitProgress: async (req: Request, res: Response) => {
    try {
      const indicatorId = req.params.indicatorId as string;
      const submissionId = req.params.submissionId as string;
      const { notes } = req.body;
      const userIdString = String(req.user._id);

      const indicator = await Indicator.findOne({
        _id: indicatorId,
        $or: [
          { assignee: userIdString },
          { assignee: { $in: [userIdString] } }
        ]
      });

      if (!indicator) return res.status(404).json({ message: "Indicator not found" });

      const submission = indicator.submissions.id(submissionId);
      if (!submission) return res.status(404).json({ message: "Submission not found" });

      if (submission.reviewStatus === "Accepted") {
        return res.status(400).json({ message: "Cannot edit an accepted submission" });
      }

      indicator.reviewHistory.push({
        action: "RESUBMITTED",
        reason: `User updated evidence for Q${submission.quarter}.`,
        reviewedBy: userIdString as any,
        at: new Date()
      } as any);

      if (notes) submission.notes = notes;
      
      const files = req.files as Express.Multer.File[];
      if (files && files.length > 0) {
        const uploadResults = await uploadMultipleToCloudinary(files, "submissions");
        
        const newDocuments: IDocument[] = uploadResults.map((result, index) => {
          let type: "raw" | "image" | "video" = "image";
          if (result.resource_type === "video") {
            type = "video";
          } else if (files[index].mimetype === "application/pdf") {
            type = "raw";
          }

          return {
            evidenceUrl: result.secure_url,
            evidencePublicId: result.public_id,
            fileType: type,
            fileName: files[index].originalname
          };
        });

        // Update subdocument collection
        submission.documents = newDocuments as any;
        
        // Sync legacy fields
        submission.evidenceUrl = newDocuments[0].evidenceUrl;
        submission.evidencePublicId = newDocuments[0].evidencePublicId;
        submission.fileType = newDocuments[0].fileType;
      }

      submission.reviewStatus = "Pending";
      submission.isReviewed = false;
      submission.resubmissionCount = (submission.resubmissionCount || 0) + 1;
      submission.submittedAt = new Date();
      indicator.status = "Submitted";
      
      await indicator.save();

      const updated = await Indicator.findById(indicator._id)
        .populate("assignee", "name email")
        .populate({ path: "strategicPlanId", model: StrategicPlan });

      res.status(200).json({ success: true, data: transformIndicator(updated) });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },

  getIndicatorDetails: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userIdString = String(req.user._id);

      const indicator = await Indicator.findOne({
        _id: id,
        $or: [
          { assignee: userIdString },
          { assignee: { $in: [userIdString] } }
        ]
      }).populate({
        path: "strategicPlanId",
        model: StrategicPlan,
        select: "perspective objectives",
      }).populate("assignee", "name email pjNumber teamName");

      if (!indicator) return res.status(404).json({ message: "Not found" });

      res.status(200).json({ success: true, data: transformIndicator(indicator) });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  },
};