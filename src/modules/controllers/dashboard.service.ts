// src/services/dashboard.service.ts
import { pool } from "../../config/db";

export interface DashboardStats {
  totalIndicators: number;
  assignedIndicators: number;
  unassignedIndicators: number;
  overdueIndicators: number;
  pendingReviewIndicators: number;
  returnedForCorrection: number;
  reviewedAndApproved: number;
  completionPipeline: {
    assigned: number;
    pendingReview: number;
    reviewedAndApproved: number;
    returned: number;
  };
  distribution: {
    overdue: number;
    pendingReview: number;
    returned: number;
    onTrack: number;
  };
}

export interface RecentSubmission {
  id: string;
  submitterName: string;
  submitterId: string;
  indicatorTitle: string;
  indicatorId: string;
  submittedAt: Date;
  achieved: number;
  documentCount: number;
}

export interface TeamMemberOverview {
  id: string;
  name: string;
  pjNumber: string;
  title: string;
  assignedIndicatorsCount: number;
}

export class DashboardService {
  static async getDashboardStats(): Promise<DashboardStats> {
    const client = await pool.connect();
    try {
      const totalRes = await client.query(`SELECT COUNT(*) FROM indicators`);
      const totalIndicators = parseInt(totalRes.rows[0].count, 10);

      const assignedRes = await client.query(
        `SELECT COUNT(*) FROM indicators WHERE assigned_by IS NOT NULL`
      );
      const assignedIndicators = parseInt(assignedRes.rows[0].count, 10);
      const unassignedIndicators = totalIndicators - assignedIndicators;

      const overdueRes = await client.query(
        `SELECT COUNT(*) FROM indicators 
         WHERE deadline < NOW() 
         AND status NOT IN ('Completed', 'Rejected by Admin', 'Rejected by Super Admin')`
      );
      const overdueIndicators = parseInt(overdueRes.rows[0].count, 10);

      const pendingReviewRes = await client.query(
        `SELECT COUNT(*) FROM indicators WHERE status = 'Awaiting Admin Approval'`
      );
      const pendingReviewIndicators = parseInt(pendingReviewRes.rows[0].count, 10);

      const returnedRes = await client.query(
        `SELECT COUNT(*) FROM indicators WHERE status = 'Rejected by Admin'`
      );
      const returnedForCorrection = parseInt(returnedRes.rows[0].count, 10);

      const approvedRes = await client.query(
        `SELECT COUNT(*) FROM indicators WHERE status = 'Completed'`
      );
      const reviewedAndApproved = parseInt(approvedRes.rows[0].count, 10);

      const completionPipeline = {
        assigned: assignedIndicators,
        pendingReview: pendingReviewIndicators,
        reviewedAndApproved: reviewedAndApproved,
        returned: returnedForCorrection,
      };

      const onTrackRes = await client.query(
        `SELECT COUNT(*) FROM indicators 
         WHERE (deadline >= NOW() OR deadline IS NULL)
         AND status NOT IN ('Awaiting Admin Approval', 'Rejected by Admin', 'Completed', 'Rejected by Super Admin')
         AND status IN ('Pending', 'Awaiting Super Admin')`
      );
      const onTrack = parseInt(onTrackRes.rows[0].count, 10);

      const distribution = {
        overdue: overdueIndicators,
        pendingReview: pendingReviewIndicators,
        returned: returnedForCorrection,
        onTrack: onTrack,
      };

      return {
        totalIndicators,
        assignedIndicators,
        unassignedIndicators,
        overdueIndicators,
        pendingReviewIndicators,
        returnedForCorrection,
        reviewedAndApproved,
        completionPipeline,
        distribution,
      };
    } finally {
      client.release();
    }
  }

  static async getRecentSubmissions(limit: number = 10): Promise<RecentSubmission[]> {
    // Using i.description as the indicator title – adjust if your column is different
    const query = `
      SELECT 
        s.id,
        u.name AS submitter_name,
        u.id AS submitter_id,
        i.description AS indicator_title,
        i.id AS indicator_id,
        s.created_at AS submitted_at,
        s.achieved_value AS achieved,
        (
          SELECT COUNT(*) FROM documents d WHERE d.submission_id = s.id
        ) AS document_count
      FROM submissions s
      JOIN users u ON s.submitted_by = u.id
      JOIN indicators i ON s.indicator_id = i.id
      ORDER BY s.created_at DESC
      LIMIT $1
    `;
    const { rows } = await pool.query(query, [limit]);
    return rows.map((row) => ({
      id: row.id,
      submitterName: row.submitter_name,
      submitterId: row.submitter_id,
      indicatorTitle: row.indicator_title,
      indicatorId: row.indicator_id,
      submittedAt: row.submitted_at,
      achieved: parseFloat(row.achieved) || 0,
      documentCount: parseInt(row.document_count, 10),
    }));
  }

  static async getTeamOverview(): Promise<TeamMemberOverview[]> {
    const query = `
      SELECT 
        u.id,
        u.name,
        u.pj_number,
        u.title,
        COALESCE(COUNT(i.assigned_by), 0) AS assigned_indicators_count
      FROM users u
      LEFT JOIN indicators i ON i.assigned_by = u.id
      GROUP BY u.id, u.name, u.pj_number, u.title
      ORDER BY assigned_indicators_count DESC, u.name ASC
    `;
    const { rows } = await pool.query(query);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pjNumber: row.pj_number || "",
      title: row.title || "Staff",
      assignedIndicatorsCount: parseInt(row.assigned_indicators_count, 10),
    }));
  }
}