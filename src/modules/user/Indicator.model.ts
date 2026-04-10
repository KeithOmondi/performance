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
            nextStatus =
              latestReview.reviewer_role === "superadmin"
                ? "Rejected by Super Admin"
                : "Rejected by Admin";
            break;
          // ── Reopen feeds back into the state machine naturally.
          //    The review_history row written by reopenIndicator carries
          //    action = "Reopened", which lands here and sets Pending,
          //    so no extra case is needed — the default handles it.
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
      await client.query(updateQuery, [
        totalAchieved,
        progress,
        nextStatus,
        nextQuarter,
        nextDeadlineUpdate,
        indicatorId,
      ]);

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
   * Reopens a locked indicator (Completed / Deadline Passed / any Rejected state).
   *
   * Strategy:
   *  1. Validate the indicator exists and is in a reopenable state.
   *  2. Write a "Reopened" entry into review_history so the audit trail
   *     is never broken.
   *  3. Directly set status = 'Pending' and extend the deadline —
   *     we bypass syncIndicatorState here because the latest history
   *     row is now "Reopened" which the switch doesn't handle, so the
   *     machine would fall through to "Pending" anyway. Doing it
   *     explicitly is clearer and safer.
   *
   * @param indicatorId   - The indicator to reopen
   * @param adminId       - The admin performing the action (for audit log)
   * @param newDeadline   - New deadline to set (required — old one has passed)
   * @param reason        - Optional note stored in review_history
   */
  static async reopenIndicator(
    indicatorId: string,
    adminId: string,
    newDeadline: Date,
    reason?: string,
  ): Promise<IIndicator> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Fetch current indicator — must exist and be in a locked state
      const indicatorRes = await client.query(
        "SELECT * FROM indicators WHERE id = $1 FOR UPDATE",
        [indicatorId],
      );

      if (indicatorRes.rows.length === 0) {
        throw new Error("Indicator not found");
      }

      const indicator = indicatorRes.rows[0];

      const reopenableStatuses = [
        "Completed",
        "Rejected by Admin",
        "Rejected by Super Admin",
        "Pending",   // covers deadline-passed indicators whose status never changed
      ];

      if (!reopenableStatuses.includes(indicator.status)) {
        throw new Error(
          `Indicator cannot be reopened from status "${indicator.status}"`,
        );
      }

      // 2. Write audit trail entry BEFORE mutating the indicator
      await client.query(
        `INSERT INTO review_history
           (indicator_id, action, reviewer_role, reviewed_by, reason, at)
         VALUES ($1, 'Reopened', 'admin', $2, $3, NOW())`,
        [indicatorId, adminId, reason ?? "Reopened by admin"],
      );

      // 3. Reset indicator — keep active_quarter and progress intact,
      //    only unlock status and extend the deadline
      await client.query(
        `UPDATE indicators
         SET status      = 'Pending',
             deadline    = $1,
             updated_at  = NOW()
         WHERE id = $2`,
        [newDeadline, indicatorId],
      );

      await client.query("COMMIT");

      // 4. Return the full updated indicator so the controller can
      //    send it straight back to the client
      const updated = await IndicatorService.getFullIndicator(indicatorId);
      if (!updated) throw new Error("Failed to retrieve updated indicator");

      return updated;
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
    const indicatorRes = await pool.query(
      "SELECT * FROM indicators WHERE id = $1",
      [id],
    );
    if (indicatorRes.rows.length === 0) return null;

    const indicator = indicatorRes.rows[0];

    // Fetch nested submissions with their documents
    const subRes = await pool.query(
      `SELECT s.*, 
              COALESCE(
                json_agg(d.*) FILTER (WHERE d.id IS NOT NULL), 
                '[]'
              ) AS documents
       FROM submissions s
       LEFT JOIN documents d ON d.submission_id = s.id
       WHERE s.indicator_id = $1
       GROUP BY s.id
       ORDER BY s.quarter ASC`,
      [id],
    );
    indicator.submissions = subRes.rows;

    // Fetch nested history
    const histRes = await pool.query(
      "SELECT * FROM review_history WHERE indicator_id = $1 ORDER BY at DESC",
      [id],
    );
    indicator.reviewHistory = histRes.rows;

    return indicator;
  }
}