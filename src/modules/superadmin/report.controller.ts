import { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { Indicator } from "../user/Indicator.model";
import { User } from "../user/user.model";

// ─── 1. Performance Summary (by Perspective) ──────────────────────────────────
export const getPerformanceSummary = asyncHandler(
  async (_req: Request, res: Response) => {
    const summary = await Indicator.aggregate([
      {
        $lookup: {
          from: "strategicplans",
          localField: "strategicPlanId",
          foreignField: "_id",
          as: "plan",
        },
      },
      // Fixed: was unwinding "userDetails" which doesn't exist at this stage
      { $unwind: { path: "$plan", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ["$plan.perspective", "Uncategorised"] },
          totalWeight: { $sum: "$weight" },
          totalTarget: { $sum: "$target" },
          totalAchieved: { $sum: "$currentTotalAchieved" },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          name: "$_id",
          weight: "$totalWeight",
          target: "$totalTarget",
          achieved: "$totalAchieved",
          count: 1,
          score: {
            $cond: [
              { $gt: ["$totalTarget", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$totalAchieved", "$totalTarget"] },
                      "$totalWeight",
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
          status: {
            $cond: {
              if: { $gte: ["$totalAchieved", "$totalTarget"] },
              then: "ON TRACK",
              else: "IN PROGRESS",
            },
          },
        },
      },
      { $sort: { weight: -1 } },
    ]);

    res.status(200).json({ success: true, data: summary });
  }
);

// ─── 2. Review Log ────────────────────────────────────────────────────────────
export const getReviewLog = asyncHandler(
  async (req: Request, res: Response) => {
    const { status } = req.query;

    const validStatuses = ["Pending", "Verified", "Accepted", "Rejected"];
    const statusFilter =
      status && status !== "ALL" && validStatuses.includes(status as string)
        ? { "submissions.reviewStatus": status }
        : {};

    const [logs, stats] = await Promise.all([
      Indicator.aggregate([
        { $unwind: "$submissions" },
        { $match: statusFilter },
        {
          $lookup: {
            from: "users",
            localField: "assignee",
            foreignField: "_id",
            as: "userDetails",
          },
        },
        { $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: "$submissions._id",
            indicatorTitle: {
              $ifNull: ["$instructions", "Performance Indicator"],
            },
            quarter: "$submissions.quarter",
            achievedValue: "$submissions.achievedValue",
            reviewStatus: "$submissions.reviewStatus",
            submittedAt: "$submissions.submittedAt",
            notes: "$submissions.notes",
            adminComment: "$submissions.adminComment",
            resubmissionCount: "$submissions.resubmissionCount",
            assigneeName: { $ifNull: ["$userDetails.name", "Unknown"] },
            assigneeEmail: "$userDetails.email",
            assigneePjNumber: "$userDetails.pjNumber",
          },
        },
        { $sort: { submittedAt: -1 } },
      ]),

      Indicator.aggregate([
        { $unwind: "$submissions" },
        {
          $group: {
            _id: null,
            accepted: {
              $sum: {
                $cond: [
                  { $eq: ["$submissions.reviewStatus", "Accepted"] },
                  1,
                  0,
                ],
              },
            },
            rejected: {
              $sum: {
                $cond: [
                  { $eq: ["$submissions.reviewStatus", "Rejected"] },
                  1,
                  0,
                ],
              },
            },
            pending: {
              $sum: {
                $cond: [
                  { $eq: ["$submissions.reviewStatus", "Pending"] },
                  1,
                  0,
                ],
              },
            },
            verified: {
              $sum: {
                $cond: [
                  { $eq: ["$submissions.reviewStatus", "Verified"] },
                  1,
                  0,
                ],
              },
            },
            total: { $sum: 1 },
          },
        },
        { $project: { _id: 0 } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: logs,
      stats: stats[0] || {
        accepted: 0,
        rejected: 0,
        pending: 0,
        verified: 0,
        total: 0,
      },
    });
  }
);

// ─── 3. Individual Performance ────────────────────────────────────────────────
export const getIndividualPerformance = asyncHandler(
  async (_req: Request, res: Response) => {
    const performance = await User.aggregate([
      {
        $match: {
          role: { $in: ["user", "examiner"] },
          isActive: true,
        },
      },
      {
        $lookup: {
          from: "indicators",
          localField: "_id",
          foreignField: "assignee",
          as: "indicators",
        },
      },
      {
        $project: {
          name: 1,
          pjNumber: 1,
          role: 1,
          title: 1,
          totalAssigned: { $size: "$indicators" },
          completed: {
            $size: {
              $filter: {
                input: "$indicators",
                as: "ind",
                cond: { $eq: ["$$ind.status", "Completed"] },
              },
            },
          },
          awaitingReview: {
            $size: {
              $filter: {
                input: "$indicators",
                as: "ind",
                cond: {
                  $in: [
                    "$$ind.status",
                    ["Awaiting Admin Approval", "Awaiting Super Admin"],
                  ],
                },
              },
            },
          },
          rejected: {
            $size: {
              $filter: {
                input: "$indicators",
                as: "ind",
                cond: {
                  $in: [
                    "$$ind.status",
                    ["Rejected by Admin", "Rejected by Super Admin"],
                  ],
                },
              },
            },
          },
          avgProgress: {
            $cond: [
              { $gt: [{ $size: "$indicators" }, 0] },
              { $round: [{ $avg: "$indicators.progress" }, 1] },
              0,
            ],
          },
        },
      },
      { $sort: { avgProgress: -1 } },
    ]);

    res.status(200).json({ success: true, data: performance });
  }
);