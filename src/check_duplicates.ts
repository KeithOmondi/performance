// scripts/delete-q3-submission.ts

import { pool } from "../src/config/db";

async function deleteQ3Submission() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              DELETE Q3 2026 SUBMISSION                         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  const submissionId = "cd8229cc-c200-4d9c-8680-728033929458"; // Q3 2026 submission

  // ─── 1. Verify the submission exists ──────────────────────────────────
  console.log(`🔍 Verifying submission: ${submissionId}\n`);

  const checkResult = await pool.query(`
    SELECT 
      s.id,
      s.quarter,
      s.year,
      s.review_status,
      s.submitted_at,
      s.notes,
      s.admin_comment,
      i.id as indicator_id,
      sa.description as activity_description,
      u.name as assignee_name,
      COUNT(sd.id) as document_count
    FROM submissions s
    JOIN indicators i ON s.indicator_id = i.id
    JOIN strategic_activities sa ON i.activity_id = sa.id
    LEFT JOIN users u ON i.assignee_id = u.id
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id AND sd.status != 'Deleted'
    WHERE s.id = $1
    GROUP BY s.id, i.id, sa.description, u.name
  `, [submissionId]);

  if (checkResult.rowCount === 0) {
    console.log(`❌ Submission ${submissionId} not found.`);
    await pool.end();
    return;
  }

  const sub = checkResult.rows[0];
  console.log(`✅ Found submission to delete:\n`);
  console.log(`   📋 Submission Details:`);
  console.log(`      ID: ${sub.id}`);
  console.log(`      Quarter: Q${sub.quarter} ${sub.year}`);
  console.log(`      Review Status: ${sub.review_status}`);
  console.log(`      Submitted: ${new Date(sub.submitted_at).toLocaleString()}`);
  console.log(`      Activity: ${sub.activity_description}`);
  console.log(`      Assignee: ${sub.assignee_name || 'N/A'}`);
  console.log(`      Documents: ${sub.document_count || 0} attached`);
  if (sub.notes) {
    console.log(`      Notes: ${sub.notes}`);
  }
  if (sub.admin_comment) {
    console.log(`      Admin Comment: ${sub.admin_comment}`);
  }
  console.log();

  // ─── 2. Get documents that will be deleted ────────────────────────────
  const docsResult = await pool.query(`
    SELECT 
      id,
      file_name,
      description,
      evidence_url,
      status
    FROM submission_documents
    WHERE submission_id = $1
      AND status != 'Deleted'
  `, [submissionId]);

  const docCount = docsResult.rowCount ?? 0;
  if (docCount > 0) {
    console.log(`   📎 Documents to be deleted (${docCount}):`);
    for (const doc of docsResult.rows) {
      console.log(`      • ${doc.file_name}`);
      if (doc.description) {
        console.log(`        Description: ${doc.description}`);
      }
      console.log(`        Status: ${doc.status}`);
    }
    console.log();
  }

  // ─── 3. Show what will remain after deletion ──────────────────────────
  console.log("═".repeat(80));
  console.log("\n📋 AFTER DELETION - REMAINING SUBMISSIONS:\n");

  const remainingResult = await pool.query(`
    SELECT 
      s.id,
      s.quarter,
      s.year,
      s.review_status,
      s.submitted_at,
      COUNT(sd.id) as document_count
    FROM submissions s
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id AND sd.status != 'Deleted'
    WHERE s.indicator_id = $1
      AND s.id != $2
    GROUP BY s.id
    ORDER BY s.year DESC, s.quarter DESC
  `, [sub.indicator_id, submissionId]);

  if (remainingResult.rowCount && remainingResult.rowCount > 0) {
    for (const rem of remainingResult.rows) {
      const periodLabel = rem.quarter === 0 ? 'Annual' : `Q${rem.quarter}`;
      console.log(`   ✅ ${periodLabel} ${rem.year} - ${rem.review_status}`);
      console.log(`      ID: ${rem.id}`);
      console.log(`      Submitted: ${new Date(rem.submitted_at).toLocaleDateString()}`);
      console.log(`      Documents: ${rem.document_count || 0}`);
      console.log();
    }
  } else {
    console.log("   ⚠️ No remaining submissions for this indicator.");
    console.log("   The indicator will have NO submissions after deletion.");
    console.log();
  }

  // ─── 4. Confirm and delete ─────────────────────────────────────────────
  console.log("═".repeat(80));
  console.log("\n⚠️  WARNING: You are about to permanently delete:");
  console.log(`   • 1 submission (Q${sub.quarter} ${sub.year})`);
  console.log(`   • ${docCount} document(s)`);
  console.log("\n   This action CANNOT be undone!\n");
  console.log("   Press ENTER to proceed with deletion, or Ctrl+C to cancel...");

  // Wait for user input
  await new Promise(resolve => process.stdin.once('data', resolve));

  console.log("\n🚀 Proceeding with deletion...\n");

  // ─── 5. Begin transaction and delete ──────────────────────────────────
  await pool.query('BEGIN');

  try {
    // Delete documents first (due to foreign key constraints)
    const deleteDocs = await pool.query(`
      DELETE FROM submission_documents
      WHERE submission_id = $1
    `, [submissionId]);

    console.log(`✅ Deleted ${deleteDocs.rowCount} document(s)`);

    // Delete the submission
    const deleteSub = await pool.query(`
      DELETE FROM submissions
      WHERE id = $1
    `, [submissionId]);

    console.log(`✅ Deleted submission: ${submissionId}`);

    // Commit transaction
    await pool.query('COMMIT');

    console.log("\n✅ Deletion completed successfully!\n");

    // ─── 6. Show final state ─────────────────────────────────────────────
    console.log("═".repeat(80));
    console.log("\n📋 FINAL STATE - REMAINING SUBMISSIONS:\n");

    const finalResult = await pool.query(`
      SELECT 
        s.id,
        s.quarter,
        s.year,
        s.review_status,
        s.submitted_at,
        COUNT(sd.id) as document_count
      FROM submissions s
      LEFT JOIN submission_documents sd ON sd.submission_id = s.id AND sd.status != 'Deleted'
      WHERE s.indicator_id = $1
      GROUP BY s.id
      ORDER BY s.year DESC, s.quarter DESC
    `, [sub.indicator_id]);

    if (finalResult.rowCount && finalResult.rowCount > 0) {
      for (const rem of finalResult.rows) {
        const periodLabel = rem.quarter === 0 ? 'Annual' : `Q${rem.quarter}`;
        console.log(`   ✅ ${periodLabel} ${rem.year} - ${rem.review_status}`);
        console.log(`      ID: ${rem.id}`);
        console.log(`      Submitted: ${new Date(rem.submitted_at).toLocaleDateString()}`);
        console.log(`      Documents: ${rem.document_count || 0}`);
        console.log();
      }
    } else {
      console.log("   ⚠️ No remaining submissions for this indicator.");
    }

    console.log("═".repeat(80));
    console.log("\n📊 SUMMARY:");
    console.log(`   • Indicator: ${sub.activity_description}`);
    console.log(`   • Deleted: Q${sub.quarter} ${sub.year} submission`);
    console.log(`   • Remaining: ${finalResult.rowCount || 0} submission(s)`);

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error("❌ Deletion failed:", error);
    throw error;
  }

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    DELETION COMPLETE                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  await pool.end();
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
deleteQ3Submission().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});