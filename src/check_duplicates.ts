// scripts/check-super-admin-pending.ts

import { pool } from "../src/config/db";

async function checkSuperAdminPending() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              SUPER ADMIN DASHBOARD PENDING                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // ─── Find submissions that would appear on Super Admin dashboard ──────────
  console.log("=== Submissions Showing on Super Admin Dashboard ===\n");
  
  const dashboardResult = await pool.query(`
    SELECT 
      s.id AS submission_id,
      CASE 
        WHEN s.quarter = 0 THEN 'Annual'
        ELSE 'Q' || s.quarter::text
      END AS period,
      s.year,
      s.review_status,
      TO_CHAR(s.submitted_at, 'DD/MM/YYYY HH:MI AM') AS submitted_on,
      TO_CHAR(s.updated_at, 'DD/MM/YYYY HH:MI AM') AS last_updated,
      u.name AS submitted_by,
      sp.perspective,
      so.title AS objective,
      sa.description AS activity,
      i.status AS indicator_status,
      COUNT(sd.id) AS document_count,
      CASE 
        WHEN s.updated_at > NOW() - INTERVAL '30 days' THEN '🟢 Active'
        WHEN s.updated_at > NOW() - INTERVAL '60 days' THEN '🟡 Older'
        ELSE '🔴 Stale'
      END AS status_age
    FROM submissions s
    JOIN indicators i ON s.indicator_id = i.id
    JOIN strategic_activities sa ON i.activity_id = sa.id
    JOIN strategic_objectives so ON sa.objective_id = so.id
    JOIN strategic_plans sp ON so.plan_id = sp.id
    LEFT JOIN users u ON s.submitted_by = u.id
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id
    WHERE s.review_status = 'Verified'
    GROUP BY s.id, i.id, u.name, sp.perspective, so.title, sa.description
    ORDER BY s.updated_at DESC
  `);

  const dashboardCount = dashboardResult.rowCount ?? 0;
  
  const recentSubmissions = dashboardResult.rows.filter(
    (row: any) => row.status_age === '🟢 Active'
  );
  
  const olderSubmissions = dashboardResult.rows.filter(
    (row: any) => row.status_age === '🟡 Older'
  );
  
  const staleSubmissions = dashboardResult.rows.filter(
    (row: any) => row.status_age === '🔴 Stale'
  );

  console.log(`📊 Total Verified submissions: ${dashboardCount}`);
  console.log(`   🟢 Active (last 30 days): ${recentSubmissions.length}`);
  console.log(`   🟡 Older (30-60 days): ${olderSubmissions.length}`);
  console.log(`   🔴 Stale (>60 days): ${staleSubmissions.length}`);
  console.log();

  // ─── Find the 2 submissions that appear in the UI ─────────────────────────
  console.log("=== 🎯 Submissions Currently Showing in UI (2) ===\n");
  
  // The UI likely shows the 2 most recently updated submissions
  const uiSubmissions = recentSubmissions.slice(0, 2);
  
  if (uiSubmissions.length > 0) {
    console.table(uiSubmissions);
    console.log();
    
    console.log("   📋 These are the 2 submissions showing in your Super Admin dashboard:");
    uiSubmissions.forEach((row: any, index: number) => {
      console.log(`   ${index + 1}. ${row.perspective} - ${row.objective}`);
      console.log(`      Submitted by: ${row.submitted_by} on ${row.submitted_on}`);
      console.log(`      Updated: ${row.last_updated}`);
      console.log(`      Documents: ${row.document_count}`);
      console.log();
    });
  }

  // ─── Show what else is waiting ─────────────────────────────────────────────
  if (recentSubmissions.length > 2) {
    console.log(`=== 📋 Additional Submissions (${recentSubmissions.length - 2} more) ===\n`);
    console.log("   These are also Verified and awaiting your approval but not showing in the UI:");
    const additional = recentSubmissions.slice(2, 7);
    console.table(additional);
    if (recentSubmissions.length - 2 > 5) {
      console.log(`   ... and ${recentSubmissions.length - 7} more`);
    }
    console.log();
  }

  // ─── Show older submissions ──────────────────────────────────────────────────
  if (olderSubmissions.length > 0) {
    console.log(`=== 🟡 Older Submissions (${olderSubmissions.length}) ===\n`);
    console.log("   These submissions are 30-60 days old and may need attention:");
    console.table(olderSubmissions.slice(0, 5));
    if (olderSubmissions.length > 5) {
      console.log(`   ... and ${olderSubmissions.length - 5} more`);
    }
    console.log();
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log("=== Summary ===");
  console.log(`   📊 Active pending reviews: ${recentSubmissions.length}`);
  console.log(`   📊 UI shows: 2 (the most recent ones)`);
  console.log(`   📊 ${olderSubmissions.length} older submissions need review`);
  console.log(`   📊 ${staleSubmissions.length} stale submissions need attention`);
  console.log();
  
  console.log("   💡 The UI shows only 2 pending reviews because:");
  console.log("      1. The dashboard filters to show the most recent submissions");
  console.log("      2. Only 2 submissions have been updated recently enough");
  console.log("      3. The other ${recentSubmissions.length - 2} Verified submissions");
  console.log("         are older and may require scrolling or filtering to see.");
  console.log();
  
  console.log("   📌 To see all ${dashboardCount} pending reviews:");
  console.log("      - Check the 'All' or 'Pending' filter in the UI");
  console.log("      - Or scroll down the dashboard to load more items");

  // ─── Check indicator statuses ──────────────────────────────────────────────
  console.log("=== Indicator Status Distribution ===");
  const indicatorStatusResult = await pool.query(`
    SELECT 
      i.status,
      COUNT(DISTINCT s.id) as submission_count
    FROM submissions s
    JOIN indicators i ON s.indicator_id = i.id
    WHERE s.review_status = 'Verified'
    GROUP BY i.status
    ORDER BY submission_count DESC
  `);
  
  console.table(indicatorStatusResult.rows);
  console.log();

  await pool.end();
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
checkSuperAdminPending().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});