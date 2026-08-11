// scripts/check-partial-approvals-history.ts

import { pool } from "../src/config/db";

async function checkPartialApprovalsHistory() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              PARTIAL APPROVALS HISTORY CHECK                   ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // ─── 1. Check for partial approvals in review_history ─────────────────────
  console.log("=== 1. Partial Approvals in Review History ===");
  const partialResult = await pool.query(`
    SELECT 
      rh.id,
      rh.indicator_id,
      rh.action,
      rh.reason,
      rh.approved_amount AS "approvedAmount",
      rh.quarter,
      rh.year,
      rh.is_partial AS "isPartial",
      TO_CHAR(rh.at, 'DD/MM/YYYY HH:MI AM') AS approved_at,
      u.name AS approved_by,
      i.status AS indicator_status,
      sa.description AS activity_description,
      sp.perspective
    FROM review_history rh
    JOIN indicators i ON rh.indicator_id = i.id
    LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
    LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
    LEFT JOIN users u ON rh.reviewed_by = u.id
    WHERE rh.is_partial = true
       OR rh.action = 'Partially Approved'
    ORDER BY rh.at DESC
  `);

  const partialCount = partialResult.rowCount ?? 0;
  console.log(`📊 Found ${partialCount} partial approval record(s):\n`);

  if (partialCount > 0) {
    console.table(partialResult.rows);
    console.log();
  } else {
    console.log("   ❌ No partial approval records found.\n");
  }

  // ─── 2. Check for submissions with 'Partially Approved' status ──────────
  console.log("=== 2. Submissions with 'Partially Approved' Status ===");
  const subResult = await pool.query(`
    SELECT 
      s.id,
      s.indicator_id,
      s.quarter,
      s.year,
      s.review_status,
      s.achieved_value,
      s.admin_comment,
      TO_CHAR(s.submitted_at, 'DD/MM/YYYY HH:MI AM') AS submitted_at,
      i.status AS indicator_status,
      sa.description AS activity_description
    FROM submissions s
    JOIN indicators i ON s.indicator_id = i.id
    LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
    WHERE s.review_status = 'Partially Approved'
    ORDER BY s.submitted_at DESC
  `);

  const subCount = subResult.rowCount ?? 0;
  console.log(`📊 Found ${subCount} submission(s) with 'Partially Approved' status:\n`);

  if (subCount > 0) {
    console.table(subResult.rows);
  } else {
    console.log("   ❌ No submissions with 'Partially Approved' status.");
  }
  console.log();

  // ─── 3. Summary by indicator ──────────────────────────────────────────────
  if (partialCount > 0) {
    console.log("=== 3. Summary by Indicator ===");
    const summaryResult = await pool.query(`
      SELECT 
        rh.indicator_id,
        sa.description AS activity_description,
        COUNT(*) as partial_count,
        SUM(rh.approved_amount) AS total_approved,
        MIN(rh.at) AS first_approval,
        MAX(rh.at) AS last_approval,
        i.current_total_achieved AS current_total,
        i.target,
        i.progress
      FROM review_history rh
      JOIN indicators i ON rh.indicator_id = i.id
      LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
      WHERE rh.is_partial = true
      GROUP BY rh.indicator_id, sa.description, i.current_total_achieved, i.target, i.progress
      ORDER BY partial_count DESC
    `);

    console.table(summaryResult.rows);
    console.log();
  }

  // ─── 4. Total approved amounts ────────────────────────────────────────────
  console.log("=== 4. Total Approved Amounts ===");
  const totalResult = await pool.query(`
    SELECT 
      COUNT(*) as total_partial_approvals,
      SUM(approved_amount) as total_approved_amount,
      AVG(approved_amount) as avg_approved_amount,
      MIN(approved_amount) as min_approved,
      MAX(approved_amount) as max_approved
    FROM review_history
    WHERE is_partial = true
  `);

  console.log(`   📊 Total Partial Approvals: ${totalResult.rows[0]?.total_partial_approvals ?? 0}`);
  console.log(`   📊 Total Approved Amount: ${totalResult.rows[0]?.total_approved_amount ?? 0}%`);
  console.log(`   📊 Average Approval: ${Math.round(totalResult.rows[0]?.avg_approved_amount ?? 0)}%`);
  console.log(`   📊 Min Approval: ${totalResult.rows[0]?.min_approved ?? 0}%`);
  console.log(`   📊 Max Approval: ${totalResult.rows[0]?.max_approved ?? 0}%`);
  console.log();

  // ─── 5. Progress progression ──────────────────────────────────────────────
  if (partialCount > 0) {
    console.log("=== 5. Progress Progression (by indicator) ===");
    const progressionResult = await pool.query(`
      SELECT 
        rh.indicator_id,
        sa.description AS activity_description,
        rh.approved_amount,
        rh.at,
        rh.is_partial,
        i.progress,
        i.target,
        i.current_total_achieved
      FROM review_history rh
      JOIN indicators i ON rh.indicator_id = i.id
      LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
      WHERE rh.is_partial = true
      ORDER BY rh.indicator_id, rh.at ASC
    `);

    console.table(progressionResult.rows);
    console.log();
  }

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║                       REPORT COMPLETE                          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  await pool.end();
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
checkPartialApprovalsHistory().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});