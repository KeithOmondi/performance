// src/scripts/diagnose-review-queue.ts
import { pool } from "./config/db";

const DEFAULT_INDICATOR_ID = "e7ad1bb0-ac1e-4d84-a33a-79dbd89d0e32";

async function main() {
  const indicatorId = process.argv[2] ?? DEFAULT_INDICATOR_ID;

  console.log("Connected to Neon. Diagnosing review queue...");
  console.log("Focus indicator: " + indicatorId);
  console.log("");

  const client = await pool.connect();

  try {
    console.log("=== 1. Indicators grouped by status ===");
    const statusCounts = await client.query(
      "SELECT status::text AS status, COUNT(*)::int AS count " +
      "FROM indicators WHERE deleted_at IS NULL " +
      "GROUP BY status ORDER BY count DESC"
    );
    console.table(statusCounts.rows);

    console.log("");
    console.log("=== 2. Admin review queue (verbatim query) ===");
    const queue = await client.query(
      "SELECT i.id, i.status, i.reporting_cycle, i.active_quarter, " +
      "COALESCE(ps.pending_count, 0) AS pendingSubmissionCount " +
      "FROM indicators i " +
      "LEFT JOIN ( " +
      "  SELECT indicator_id, COUNT(*) AS pending_count " +
      "  FROM submissions " +
      "  WHERE review_status = 'Pending' AND is_reviewed = false " +
      "  GROUP BY indicator_id " +
      ") ps ON ps.indicator_id = i.id " +
      "WHERE i.status = 'Awaiting Super Admin' " +
      "   OR (i.status = 'Awaiting Admin Approval' AND ps.pending_count > 0) " +
      "ORDER BY i.updated_at DESC"
    );

    if (queue.rows.length === 0) {
      console.log("REVIEW QUERY RETURNS ZERO INDICATORS.");
    } else {
      console.log("Review query returns " + queue.rows.length + " indicator(s):");
      console.table(queue.rows);
    }

    console.log("");
    console.log("=== 3. Target indicator ===");
    const target = await client.query(
      "SELECT i.id, i.status AS indicatorStatus, i.reporting_cycle AS reportingCycle, " +
      "i.active_quarter AS activeQuarter, i.progress, i.updated_at AS updatedAt " +
      "FROM indicators i WHERE i.id = $1",
      [indicatorId]
    );

    if (target.rows.length === 0) {
      console.log("Indicator not found.");
      return;
    }

    console.table(target.rows[0]);

    console.log("");
    console.log("=== 4. Submissions on target indicator ===");
    const submissions = await client.query(
      "SELECT s.id, s.quarter, s.year, " +
      "s.review_status AS reviewStatus, s.is_reviewed AS isReviewed, " +
      "s.submitted_at AS submittedAt, " +
      "(SELECT COUNT(*)::int FROM submission_documents d " +
      " WHERE d.submission_id = s.id AND d.deleted_at IS NULL) AS ownDocs, " +
      "(SELECT COUNT(*)::int FROM submission_spot_check_links l " +
      " WHERE l.submission_id = s.id) AS linkedDocs " +
      "FROM submissions s WHERE s.indicator_id = $1 " +
      "ORDER BY s.submitted_at DESC",
      [indicatorId]
    );
    console.table(submissions.rows);

    console.log("");
    console.log("=== 5. Diagnosis ===");
    const indStatus = target.rows[0].indicatorStatus;

    if (indStatus === "Awaiting Super Admin") {
      console.log("OK: status is Awaiting Super Admin, should be in queue.");
    } else if (indStatus === "Awaiting Admin Approval") {
      const pendingCount = submissions.rows.filter(
        (r: any) => r.reviewStatus === "Pending" && r.isReviewed === false
      ).length;

      if (pendingCount > 0) {
        console.log(
          "OK: status Awaiting Admin Approval and " +
          pendingCount +
          " pending submission(s). Should be in queue."
        );
      } else {
        console.log(
          "FAIL: status Awaiting Admin Approval but no pending submission."
        );
        console.log("Submissions in this state are filtered out.");
      }
    } else if (indStatus === "Pending") {
      console.log(
        "FAIL: status is Pending. The queue only matches Awaiting Super Admin " +
        "or Awaiting Admin Approval with pending submissions."
      );
      console.log("");
      console.log("To unstick, run:");
      console.log("  UPDATE indicators");
      console.log("  SET status = 'Awaiting Admin Approval', updated_at = NOW()");
      console.log("  WHERE id = '" + indicatorId + "';");
    } else {
      console.log("FAIL: status is " + indStatus + ", not queue-eligible.");
    }

    console.log("");
    console.log("=== 6. Stuck indicators (Pending status with pending subs) ===");
    const stuck = await client.query(
      "SELECT i.id, i.status, i.reporting_cycle AS reportingCycle, " +
      "COUNT(s.id)::int AS pendingSubs " +
      "FROM indicators i " +
      "JOIN submissions s ON s.indicator_id = i.id " +
      "WHERE i.status = 'Pending' " +
      "  AND s.review_status = 'Pending' " +
      "  AND s.is_reviewed = false " +
      "  AND i.deleted_at IS NULL " +
      "GROUP BY i.id, i.status, i.reporting_cycle " +
      "ORDER BY i.updated_at DESC"
    );

    if (stuck.rows.length === 0) {
      console.log("(none)");
    } else {
      console.log(stuck.rows.length + " stuck indicator(s):");
      console.table(stuck.rows);
    }

    console.log("");
    console.log("Diagnosis complete.");
  } catch (err) {
    console.error("Diagnosis failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Unhandled error in main():", err);
  process.exit(1);
});