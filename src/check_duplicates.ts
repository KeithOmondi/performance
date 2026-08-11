// scripts/check-indicator-submissions.ts

import { pool } from "../src/config/db";

async function checkIndicatorSubmissions() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║           INDICATOR SUBMISSIONS DETAILED CHECK                ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // ─── Get the indicator ID for "Conduct 10 virtual and 5 physical sensitization" ──
  const indicatorResult = await pool.query(`
    SELECT 
      i.id,
      i.status,
      i.progress,
      i.target,
      i.unit,
      i.reporting_cycle,
      i.active_quarter,
      sa.description AS activity_description,
      so.title AS objective_title,
      sp.perspective
    FROM indicators i
    LEFT JOIN strategic_activities sa ON i.activity_id = sa.id
    LEFT JOIN strategic_objectives so ON i.objective_id = so.id
    LEFT JOIN strategic_plans sp ON i.strategic_plan_id = sp.id
    WHERE i.assignee_id = 'dd20e88a-3820-4ec7-80c1-dcdf212e8769'
      AND sa.description ILIKE '%sensitization%'
    ORDER BY i.created_at DESC
  `);

  if (indicatorResult.rowCount === 0) {
    console.log("❌ No indicator found with that description.");
    await pool.end();
    return;
  }

  const indicator = indicatorResult.rows[0];
  
  console.log("=== 1. Indicator Details ===");
  console.log(`   📌 ID: ${indicator.id}`);
  console.log(`   📌 Activity: ${indicator.activity_description}`);
  console.log(`   📌 Objective: ${indicator.objective_title || 'N/A'}`);
  console.log(`   📌 Perspective: ${indicator.perspective || 'N/A'}`);
  console.log(`   📌 Status: ${indicator.status}`);
  console.log(`   📌 Progress: ${indicator.progress}%`);
  console.log(`   📌 Target: ${indicator.target} ${indicator.unit}`);
  console.log(`   📌 Reporting Cycle: ${indicator.reporting_cycle}`);
  console.log(`   📌 Active Quarter: ${indicator.active_quarter}`);
  console.log();

  // ─── Get all submissions for this indicator ──────────────────────────────
  console.log("=== 2. All Submissions for this Indicator ===");
  const submissionsResult = await pool.query(`
    SELECT 
      s.id,
      s.quarter,
      s.year,
      s.achieved_value,
      s.review_status,
      s.notes,
      s.admin_comment,
      s.resubmission_count,
      s.is_reviewed,
      TO_CHAR(s.submitted_at, 'DD/MM/YYYY HH:MI AM') AS submitted_at,
      u.name AS submitted_by_name,
      COALESCE(
        (SELECT json_agg(
          json_build_object(
            'id', sd.id,
            'fileName', sd.file_name,
            'fileType', sd.file_type,
            'description', sd.description,
            'evidenceUrl', sd.evidence_url,
            'status', sd.status,
            'rejectionReason', sd.rejection_reason
          )
          ORDER BY sd.uploaded_at
        ) FROM submission_documents sd 
          WHERE sd.submission_id = s.id 
          AND sd.status != 'Deleted'
        ),
        '[]'::json
      ) AS documents
    FROM submissions s
    LEFT JOIN users u ON s.submitted_by = u.id
    WHERE s.indicator_id = $1
    ORDER BY s.year ASC, s.quarter ASC, s.submitted_at DESC
  `, [indicator.id]);

  const subCount = submissionsResult.rowCount ?? 0;
  console.log(`📊 Found ${subCount} submission(s):\n`);

  if (subCount > 0) {
    for (const row of submissionsResult.rows) {
      const quarterLabel = row.quarter === 0 ? 'Annual' : `Q${row.quarter}`;
      const docCount = row.documents?.length || 0;
      
      console.log(`   ─── ${quarterLabel} ${row.year} ───`);
      console.log(`   📌 Submission ID: ${row.id.substring(0, 8)}`);
      console.log(`   📌 Review Status: ${row.review_status}`);
      console.log(`   📌 Achieved Value: ${row.achieved_value || 'N/A'} ${indicator.unit}`);
      console.log(`   📌 Submitted By: ${row.submitted_by_name || 'Unknown'}`);
      console.log(`   📌 Submitted At: ${row.submitted_at}`);
      console.log(`   📌 Resubmission Count: ${row.resubmission_count || 0}`);
      console.log(`   📌 Is Reviewed: ${row.is_reviewed ? '✅ Yes' : '❌ No'}`);
      
      if (row.admin_comment) {
        console.log(`   📌 Admin Comment: ${row.admin_comment}`);
      }
      
      if (row.notes) {
        console.log(`   📌 Notes: ${row.notes}`);
      }
      
      console.log(`   📌 Documents (${docCount}):`);
      
      if (docCount > 0) {
        for (const doc of row.documents) {
          console.log(`      ────────────────────────────────`);
          console.log(`      📄 ${doc.fileName || 'Unnamed'}`);
          console.log(`         Type: ${doc.fileType || 'unknown'}`);
          console.log(`         Status: ${doc.status || 'N/A'}`);
          if (doc.description) {
            console.log(`         📝 Description: ${doc.description}`);
          }
          if (doc.rejectionReason) {
            console.log(`         ❌ Rejection Reason: ${doc.rejectionReason}`);
          }
          console.log(`         🔗 URL: ${doc.evidenceUrl?.substring(0, 80) || 'No URL'}...`);
        }
      } else {
        console.log(`         ❌ No documents attached`);
      }
      console.log();
    }
  } else {
    console.log("   ❌ No submissions found for this indicator.\n");
  }

  // ─── Summary by quarter ──────────────────────────────────────────────────
  console.log("=== 3. Summary by Quarter ===");
  const summaryResult = await pool.query(`
    SELECT 
      s.quarter,
      s.year,
      COUNT(*) AS submission_count,
      COUNT(sd.id) FILTER (WHERE sd.status != 'Deleted') AS total_documents,
      STRING_AGG(DISTINCT s.review_status::text, ', ') AS statuses,
      MAX(s.submitted_at) AS latest_submission
    FROM submissions s
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id
    WHERE s.indicator_id = $1
    GROUP BY s.quarter, s.year
    ORDER BY s.year ASC, s.quarter ASC
  `, [indicator.id]);

  const summaryCount = summaryResult.rowCount ?? 0;
  console.log(`📊 Summary by quarter:\n`);

  if (summaryCount > 0) {
    console.table(summaryResult.rows.map((row: any) => ({
      'Period': row.quarter === 0 ? 'Annual' : `Q${row.quarter}`,
      'Year': row.year,
      'Submissions': row.submission_count,
      'Documents': row.total_documents || 0,
      'Statuses': row.statuses,
      'Latest Submission': new Date(row.latest_submission).toLocaleDateString()
    })));
    console.log();
  }

  // ─── Check if Q3 has the data we expect ──────────────────────────────────
  console.log("=== 4. Q3 Specific Check ===");
  const q3Result = await pool.query(`
    SELECT 
      s.id,
      s.quarter,
      s.year,
      s.review_status,
      s.notes,
      COUNT(sd.id) FILTER (WHERE sd.status != 'Deleted') AS doc_count,
      COALESCE(
        (SELECT json_agg(
          json_build_object(
            'fileName', sd.file_name,
            'description', sd.description,
            'evidenceUrl', sd.evidence_url
          )
        ) FROM submission_documents sd 
          WHERE sd.submission_id = s.id 
          AND sd.status != 'Deleted'
        ),
        '[]'::json
      ) AS documents
    FROM submissions s
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id
    WHERE s.indicator_id = $1
      AND s.quarter = 3
      AND s.year = 2026
    GROUP BY s.id, s.quarter, s.year, s.review_status, s.notes
  `, [indicator.id]);

  const q3Count = q3Result.rowCount ?? 0;
  console.log(`📊 Q3 2026: Found ${q3Count} submission(s)\n`);

  if (q3Count > 0) {
    for (const row of q3Result.rows) {
      console.log(`   ✅ Q3 Submission Found:`);
      console.log(`      ID: ${row.id.substring(0, 8)}`);
      console.log(`      Review Status: ${row.review_status}`);
      console.log(`      Notes: ${row.notes || 'N/A'}`);
      console.log(`      Document Count: ${row.doc_count || 0}`);
      if (row.documents && row.documents.length > 0) {
        console.log(`      Documents:`);
        for (const doc of row.documents) {
          console.log(`         - ${doc.fileName || 'Unnamed'}`);
          console.log(`           📝 ${doc.description || 'No description'}`);
          console.log(`           🔗 ${doc.evidenceUrl?.substring(0, 60) || 'No URL'}...`);
        }
      }
      console.log();
    }
  } else {
    console.log("   ❌ No Q3 2026 submissions found.\n");
  }

  // ─── 5. Check what the report would see ──────────────────────────────────
  console.log("=== 5. What the Report Query Would See ===");
  const reportQueryResult = await pool.query(`
    SELECT 
      s.id,
      s.quarter,
      s.year,
      s.review_status,
      s.notes,
      COUNT(sd.id) FILTER (WHERE sd.status != 'Deleted') AS doc_count,
      COALESCE(
        (SELECT json_agg(
          json_build_object(
            'fileName', sd.file_name,
            'description', sd.description
          )
        ) FROM submission_documents sd 
          WHERE sd.submission_id = s.id 
          AND sd.status != 'Deleted'
        ),
        '[]'::json
      ) AS documents
    FROM submissions s
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id
    WHERE s.indicator_id = $1
      AND s.review_status NOT IN ('Rejected', 'Correction Needed')
    GROUP BY s.id, s.quarter, s.year, s.review_status, s.notes
    ORDER BY s.year ASC, s.quarter ASC, s.submitted_at DESC
  `, [indicator.id]);

  const reportCount = reportQueryResult.rowCount ?? 0;
  console.log(`📊 Report would see ${reportCount} submission(s):\n`);

  for (const row of reportQueryResult.rows) {
    const quarterLabel = row.quarter === 0 ? 'Annual' : `Q${row.quarter}`;
    console.log(`   ${quarterLabel} ${row.year}: ${row.review_status}`);
    console.log(`      Document Count: ${row.doc_count || 0}`);
    if (row.documents && row.documents.length > 0) {
      for (const doc of row.documents) {
        console.log(`         - ${doc.fileName || 'Unnamed'}`);
        console.log(`           📝 ${doc.description || 'No description'}`);
      }
    }
    console.log();
  }

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║                       REPORT COMPLETE                          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  await pool.end();
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
checkIndicatorSubmissions().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});