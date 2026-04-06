import { pool } from "../../config/db";
import { IIndicator } from "../../types/indicator.types";


export class IndicatorService {
  /**
   * REPLACES: IndicatorSchema.pre("save") logic
   * Recalculates progress and updates the State Machine
   */
  static async syncIndicatorState(indicatorId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. CALCULATE PROGRESS & TOTAL ACHIEVED
      const statsQuery = `
        SELECT COALESCE(SUM(achieved_value), 0) as total_achieved 
        FROM submissions 
        WHERE indicator_id = $1 AND review_status = 'Accepted'
      `;
      const statsRes = await client.query(statsQuery, [indicatorId]);
      const totalAchieved = parseFloat(statsRes.rows[0].total_achieved);

      // Get target and current metadata
      const metaRes = await client.query(
        "SELECT target, reporting_cycle, active_quarter FROM indicators WHERE id = $1",
        [indicatorId]
      );
      const { target, reporting_cycle, active_quarter } = metaRes.rows[0];

      const progress = target > 0 
        ? Math.min(Math.round((totalAchieved / target) * 100), 100) 
        : 0;

      // 2. STATE MACHINE (Based on latest review history)
      const historyQuery = `
        SELECT action, reviewer_role, next_deadline 
        FROM review_history 
        WHERE indicator_id = $1 
        ORDER BY at DESC LIMIT 1
      `;
      const historyRes = await client.query(historyQuery, [indicatorId]);
      const latestReview = historyRes.rows[0];

      let nextStatus = "Pending";
      let nextQuarter = active_quarter;
      let nextDeadlineUpdate = null;

      if (latestReview) {
        switch (latestReview.action) {
          case "Submitted":
          case "Resubmitted":
            nextStatus = "Awaiting Admin Approval";
            break;
          case "Verified":
            if (latestReview.reviewer_role === "admin") nextStatus = "Awaiting Super Admin";
            break;
          case "Approved":
            if (latestReview.reviewer_role === "superadmin") {
              if (reporting_cycle === "Quarterly" && active_quarter < 4) {
                nextQuarter = active_quarter + 1;
                nextStatus = "Pending";
                if (latestReview.next_deadline) nextDeadlineUpdate = latestReview.next_deadline;
              } else {
                nextStatus = "Completed";
              }
            }
            break;
          case "Correction Requested":
          case "Rejected":
            nextStatus = latestReview.reviewer_role === "superadmin" ? "Rejected by Super Admin" : "Rejected by Admin";
            break;
        }
      }

      // 3. APPLY UPDATES
      const updateQuery = `
        UPDATE indicators 
        SET current_total_achieved = $1, 
            progress = $2, 
            status = $3, 
            active_quarter = $4,
            deadline = COALESCE($5, deadline),
            updated_at = NOW()
        WHERE id = $6
      `;
      await client.query(updateQuery, [totalAchieved, progress, nextStatus, nextQuarter, nextDeadlineUpdate, indicatorId]);

      await client.query("COMMIT");
      console.log(`✅ Indicator ${indicatorId} synced: ${progress}% - ${nextStatus}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Helper to fetch the "Full" Indicator (including nested submissions/history)
   */
  static async getFullIndicator(id: string): Promise<IIndicator | null> {
    const indicatorRes = await pool.query("SELECT * FROM indicators WHERE id = $1", [id]);
    if (indicatorRes.rows.length === 0) return null;

    const indicator = indicatorRes.rows[0];

    // Fetch nested submissions
    const subRes = await pool.query("SELECT * FROM submissions WHERE indicator_id = $1", [id]);
    indicator.submissions = subRes.rows;

    // Fetch nested history
    const histRes = await pool.query("SELECT * FROM review_history WHERE indicator_id = $1 ORDER BY at DESC", [id]);
    indicator.reviewHistory = histRes.rows;

    return indicator;
  }
}