import { Request, Response } from 'express';
import { Indicator } from '../user/Indicator.model';
import { User } from '../user/user.model';


/**
 * @desc    Get Overall Summary Performance (Aggregated by Perspective)
 * @route   GET /api/reports/summary
 */
export const getPerformanceSummary = async (req: Request, res: Response) => {
  try {
    const summary = await Indicator.aggregate([
      {
        $group: {
          _id: "$perspective", // Ensure your Indicator schema has a 'perspective' field
          totalWeight: { $sum: "$weight" },
          target: { $sum: "$target" },
          achieved: { $sum: "$currentTotalAchieved" },
        }
      },
      {
        $project: {
          name: "$_id",
          weight: "$totalWeight",
          target: 1,
          achieved: 1,
          // Weighted score calculation
          score: { 
            $cond: [
              { $gt: ["$target", 0] },
              { $multiply: [{ $divide: ["$achieved", "$target"] }, "$totalWeight"] },
              0
            ]
          },
          status: {
            $cond: { if: { $gte: ["$achieved", "$target"] }, then: "ON TRACK", else: "IN PROGRESS" }
          }
        }
      },
      { $sort: { weight: -1 } }
    ]);

    res.status(200).json(summary);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};



/**
 * @desc    Get Review Log (Extracts embedded submissions from Indicators)
 * @route   GET /api/reports/review-log
 */
export const getReviewLog = async (req: Request, res: Response) => {
  try {
    const { status } = req.query; // status can be "Accepted" or "Rejected" (matching your enum)

    const logs = await Indicator.aggregate([
      // 1. Unwind the submissions array so each submission is its own document
      { $unwind: "$submissions" },
      
      // 2. Filter by status if requested
      {
        $match: status && status !== 'ALL' 
          ? { "submissions.reviewStatus": status } 
          : {}
      },

      // 3. Project the data into a flat structure for the frontend table
      {
        $project: {
          _id: "$submissions._id",
          indicatorTitle: "$instructions", // Or another descriptive field
          quarter: "$submissions.quarter",
          achievedValue: "$submissions.achievedValue",
          reviewStatus: "$submissions.reviewStatus",
          submittedAt: "$submissions.submittedAt",
          notes: "$submissions.notes",
          adminComment: "$submissions.adminComment",
          assignee: "$assignee"
        }
      },
      
      // 4. Populate assignee details
      {
        $lookup: {
          from: "users",
          localField: "assignee",
          foreignField: "_id",
          as: "userDetails"
        }
      },
      { $unwind: "$userDetails" },
      { $sort: { submittedAt: -1 } }
    ]);

    // Calculate stats for the Metric Cards
    const stats = await Indicator.aggregate([
      { $unwind: "$submissions" },
      {
        $group: {
          _id: null,
          approved: { 
            $sum: { $cond: [{ $eq: ["$submissions.reviewStatus", "Accepted"] }, 1, 0] } 
          },
          rejected: { 
            $sum: { $cond: [{ $eq: ["$submissions.reviewStatus", "Rejected"] }, 1, 0] } 
          }
        }
      }
    ]);

    res.status(200).json({ 
      logs, 
      stats: stats[0] || { approved: 0, rejected: 0 } 
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc    Get Individual Performance (Calculates from sub-documents)
 */
export const getIndividualPerformance = async (req: Request, res: Response) => {
  try {
    const performance = await User.aggregate([
      { $match: { role: { $ne: 'SUPER_ADMIN' } } },
      {
        $lookup: {
          from: 'indicators',
          localField: '_id',
          foreignField: 'assignee',
          as: 'indicators'
        }
      },
      {
        $project: {
          name: 1,
          pfNumber: 1,
          role: 1,
          subIndicatorsCount: { $size: "$indicators" },
          // Count approvals across all nested submissions
          approved: {
            $size: {
              $filter: {
                input: "$indicators",
                as: "ind",
                cond: { $eq: ["$$ind.status", "Reviewed"] }
              }
            }
          },
          // Aggregate total rejections from the resubmissionCount field in sub-docs
          totalRejections: {
            $reduce: {
              input: "$indicators",
              initialValue: 0,
              in: { 
                $add: ["$$value", { $sum: "$$this.submissions.resubmissionCount" }] 
              }
            }
          }
        }
      }
    ]);

    res.status(200).json(performance);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};