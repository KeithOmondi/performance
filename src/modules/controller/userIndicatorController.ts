import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { AppError } from "../../utils/AppError";
import { Indicator, IDocument, ISubmission } from "../user/Indicator.model";
import { uploadMultipleToCloudinary } from "../../config/cloudinary";
import mongoose from "mongoose";
import { sendMail } from "../../utils/sendMail";
import { User } from "../user/user.model";
import {
  submissionReceivedTemplate,
  adminReviewNeededTemplate,
} from "../../utils/mailTemplates";
import axios from "axios";

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Returns every Indicator that the requesting user can act on:
 *   - Directly assigned to them (assigneeModel = "User")
 *   - Assigned to a Team the user belongs to (assigneeModel = "Team")
 */
const buildUserQuery = (
  userId: mongoose.Types.ObjectId,
  teamId: mongoose.Types.ObjectId | null | undefined,
) => {
  const conditions: Record<string, unknown>[] = [
    { assignee: userId, assigneeModel: "User" },
  ];

  if (teamId) {
    conditions.push({ assignee: teamId, assigneeModel: "Team" });
  }

  return { $or: conditions };
};

// ─── DATA TRANSFORMER ────────────────────────────────────────────────────────
const transformIndicator = (ind: any) => {
  if (!ind) return null;
  const rawData = typeof ind.toObject === "function" ? ind.toObject() : ind;
  const plan = rawData.strategicPlanId;
  const targetObjId = rawData.objectiveId ? String(rawData.objectiveId) : null;
  const targetActId = rawData.activityId ? String(rawData.activityId) : null;

  const objective = plan?.objectives?.find(
    (obj: any) => obj?._id && String(obj._id) === targetObjId,
  );

  const activity = objective?.activities?.find(
    (act: any) => act?._id && String(act._id) === targetActId,
  );

  return {
    ...rawData,
    perspective: plan?.perspective || "N/A",
    objectiveTitle: objective?.title || "Strategic Objective",
    activityDescription:
      activity?.description || rawData.instructions || "No description provided",
    strategicPlanId: plan?._id || rawData.strategicPlanId,
    submissions: (rawData.submissions || []).map((sub: any) => ({
      ...sub,
      documents: sub.documents || [],
    })),
  };
};

// ─── CONTROLLER ──────────────────────────────────────────────────────────────
export const UserIndicatorController = {
  // 1. Get My Assignments (user-direct + team-assigned)
  getMyIndicators: asyncHandler(async (req: Request, res: Response) => {
    const userId = new mongoose.Types.ObjectId(req.user!._id);

    // Resolve the team this user belongs to (if any)
    const userDoc = await User.findById(userId).select("team").lean();
    const teamId = userDoc?.team ?? null;

    const query = buildUserQuery(userId, teamId);

    const indicators = await Indicator.find(query)
      .populate({
        path: "assignee",
        select: "name email pjNumber",   // works for both User and Team (Team has .name)
      })
      .populate("assignedBy", "name")
      .populate({
        path: "strategicPlanId",
        model: "StrategicPlan",
        select: "perspective objectives",
      })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      results: indicators.length,
      data: indicators.map((ind) => transformIndicator(ind)),
    });
  }),

  // 2. Get Single Indicator Details
  getIndicatorDetails: asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = new mongoose.Types.ObjectId(req.user!._id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError("Invalid indicator ID.", 400);
    }

    const userDoc = await User.findById(userId).select("team").lean();
    const teamId = userDoc?.team ?? null;

    const query = { _id: id, ...buildUserQuery(userId, teamId) };

    const indicator = await Indicator.findOne(query)
      .populate({
        path: "strategicPlanId",
        model: "StrategicPlan",
        select: "perspective objectives",
      })
      .populate("assignee", "name email pjNumber")
      .populate("assignedBy", "name")
      .populate("reviewHistory.reviewedBy", "name")
      .lean();

    if (!indicator) throw new AppError("Indicator not found.", 404);

    res.status(200).json({
      success: true,
      data: transformIndicator(indicator),
    });
  }),

  // 3. Submit / Resubmit Progress
  submitProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { notes, achievedValue } = req.body;
    const userId = new mongoose.Types.ObjectId(req.user!._id);

    if (!notes?.trim()) throw new AppError("Notes are required.", 400);
    if (achievedValue === undefined) throw new AppError("Achieved value is required.", 400);

    const userDoc = await User.findById(userId).select("team").lean();
    const teamId = userDoc?.team ?? null;

    const query = { _id: id, ...buildUserQuery(userId, teamId) };
    const indicator = await Indicator.findOne(query);

    if (!indicator) throw new AppError("Indicator not found.", 404);

    if (indicator.status === "Completed")
      throw new AppError("Filing period is closed.", 400);
    if (indicator.status === "Awaiting Super Admin")
      throw new AppError("Locked for certification.", 400);

    const targetQuarter =
      indicator.reportingCycle === "Annual" ? 1 : indicator.activeQuarter;

    const existingSubmission = indicator.submissions.find(
      (s: ISubmission) => s.quarter === targetQuarter,
    );

    if (
      existingSubmission &&
      !["Rejected", "Pending"].includes(existingSubmission.reviewStatus)
    ) {
      throw new AppError(
        `Q${targetQuarter} submission is already under review.`,
        400,
      );
    }

    const files = req.files as Express.Multer.File[];
    let newDocs: IDocument[] = [];
    if (files?.length) {
      const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
      newDocs = uploads.map((res, i) => ({
        evidenceUrl: res.secure_url,
        evidencePublicId: res.public_id,
        fileType:
          res.resource_type === "video"
            ? "video"
            : files[i].mimetype === "application/pdf"
              ? "raw"
              : "image",
        fileName: files[i].originalname,
        uploadedAt: new Date(),
      }));
    }

    if (existingSubmission) {
      existingSubmission.notes = notes.trim();
      existingSubmission.achievedValue = Number(achievedValue);
      existingSubmission.documents.push(...newDocs);
      existingSubmission.reviewStatus = "Pending";
      existingSubmission.isReviewed = false;
      existingSubmission.submittedAt = new Date();
      existingSubmission.resubmissionCount += 1;

      indicator.reviewHistory.push({
        action: "Resubmitted",
        reason: `Officer updated filing for Q${targetQuarter}`,
        reviewerRole: "user",
        reviewedBy: userId,
        at: new Date(),
      } as any);
    } else {
      indicator.submissions.push({
        quarter: targetQuarter,
        notes: notes.trim(),
        achievedValue: Number(achievedValue),
        documents: newDocs,
        submittedAt: new Date(),
        isReviewed: false,
        reviewStatus: "Pending",
        resubmissionCount: 0,
      } as any);

      indicator.reviewHistory.push({
        action: "Submitted",
        reason: `Initial filing for Q${targetQuarter}`,
        reviewerRole: "user",
        reviewedBy: userId,
        at: new Date(),
      } as any);
    }

    indicator.markModified("submissions");
    await indicator.save();

    if (req.user) {
      UserIndicatorController._sendAlerts(req.user, indicator, targetQuarter);
    }

    res.status(201).json({ success: true, message: "Filing processed." });
  }),

  // 4. Add Documents to an existing submission
  addDocuments: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { quarter } = req.body;
    const userId = new mongoose.Types.ObjectId(req.user!._id);

    const files = req.files as Express.Multer.File[];
    if (!files?.length) throw new AppError("Files required.", 400);

    const userDoc = await User.findById(userId).select("team").lean();
    const teamId = userDoc?.team ?? null;

    const query = { _id: id, ...buildUserQuery(userId, teamId) };
    const indicator = await Indicator.findOne(query);

    if (!indicator) throw new AppError("Indicator not found.", 404);

    const targetQ = Number(quarter) || indicator.activeQuarter;

    const submission = indicator.submissions.find(
      (s: ISubmission) => s.quarter === targetQ,
    );

    if (!submission) throw new AppError("No submission found for that quarter.", 404);
    if (submission.reviewStatus === "Accepted")
      throw new AppError("Record is certified and cannot be modified.", 400);

    const uploads = await uploadMultipleToCloudinary(files, "registry_evidence");
    const docs: IDocument[] = uploads.map((res, i) => ({
      evidenceUrl: res.secure_url,
      evidencePublicId: res.public_id,
      fileType:
        res.resource_type === "video"
          ? "video"
          : files[i].mimetype === "application/pdf"
            ? "raw"
            : "image",
      fileName: files[i].originalname,
      uploadedAt: new Date(),
    }));

    submission.documents.push(...docs);
    indicator.markModified("submissions");
    await indicator.save();

    res.status(200).json({ success: true, documents: docs });
  }),

  // 5. Stream file through proxy (avoids CORS + download prompt)
  streamFile: asyncHandler(async (req: Request, res: Response) => {
    const url = decodeURIComponent(req.query.url as string);

    if (!url || !url.includes("cloudinary.com")) {
      throw new AppError("Invalid or missing file URL.", 400);
    }

    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
    });

    const contentType =
      response.headers["content-type"] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline");
    res.removeHeader("X-Frame-Options");

    response.data.pipe(res);
  }),

  // ─── Internal Helper ────────────────────────────────────────────────────────
  _sendAlerts: async (user: any, indicator: any, q: number) => {
    try {
      sendMail({
        to: user.email,
        subject: `Registry Filing: Q${q}`,
        html: submissionReceivedTemplate(
          user.name,
          indicator.instructions || "Indicator",
          q,
          new Date().getFullYear(),
        ),
      });

      const admins = await User.find({ role: "admin", isActive: true }).select(
        "email name",
      );
      admins.forEach((admin) => {
        sendMail({
          to: admin.email,
          subject: "Verification Required",
          html: adminReviewNeededTemplate(
            admin.name,
            user.name,
            indicator.instructions || "Indicator",
            q,
            new Date().getFullYear(),
          ),
        });
      });
    } catch (e) {
      console.error("Mail Failure:", e);
    }
  },
};