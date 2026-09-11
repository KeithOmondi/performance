// src/seeds/inspectThree.ts
import { pool } from "./config/db";

const TARGET_IDS = [
  "119101a7-ba44-4d7d-91b0-9017892d0258", // Service Improvement Innovations (Annual)
  "d11f5ad2-4777-4892-b2fc-2b5ae62e35a5", // Service Improvement Innovations (Quarterly) — the ghost
  "e7ad1bb0-ac1e-4d84-a33a-79dbd89d0e32", // Implementation of Audit Report Recommendations
];

async function inspectThree() {
  console.log("\n══ DEEP DIVE: THREE INDICATORS ══\n");

  // ── 1. The indicators themselves ──
  const indicators = await pool.query(
    `
    SELECT
      i.id,
      i.name,
      i.status,
      i.progress,
      i.target,
      i.current_total_achieved,
      i.reporting_cycle,
      i.active_quarter,
      i.deadline,
      i.instructions,
      i.assignee_id,
      i.assignee_model,
      i.created_at,
      i.updated_at,
      i.deleted_at
    FROM indicators i
    WHERE i.id = ANY($1::uuid[])
    ORDER BY i.created_at
    `,
    [TARGET_IDS]
  );
  console.log("── indicators ──");
  console.dir(indicators.rows, { depth: null });

  // ── 2. Submissions for those indicators ──
  const submissions = await pool.query(
    `
    SELECT
      s.id,
      s.indicator_id,
      s.quarter,
      s.year,
      s.achieved_value,
      s.approved_amount,
      s.notes,
      s.submitted_at,
      s.submitted_by,
      s.is_reviewed,
      s.review_status,
      s.admin_comment,
      s.admin_description_edit,
      s.resubmission_count,
      s.previous_rejection_reason,
      s.previous_submission_id,
      s.resubmitted_from_rejection,
      s.reviewed_at,
      s.updated_at
    FROM submissions s
    WHERE s.indicator_id = ANY($1::uuid[])
    ORDER BY s.indicator_id, s.year, s.quarter
    `,
    [TARGET_IDS]
  );
  console.log("\n── submissions ──");
  console.dir(submissions.rows, { depth: null });

  // ── 3. Documents for those submissions (INCLUDING soft-deleted) ──
  const submissionIds = submissions.rows.map((r) => r.id);

  const documents = await pool.query(
    `
    SELECT
      sd.id,
      sd.submission_id,
      sd.file_name,
      sd.file_type,
      sd.description,
      sd.status,
      sd.review_status,
      sd.rejection_reason,
      sd.deleted_at,
      sd.deleted_by,
      sd.uploaded_at,
      sd.updated_at,
      sd.original_submission_id
    FROM submission_documents sd
    WHERE sd.submission_id = ANY($1::uuid[])
    ORDER BY sd.submission_id, sd.uploaded_at
    `,
    [submissionIds]
  );
  console.log("\n── documents (incl. soft-deleted) ──");
  console.dir(documents.rows, { depth: null });

  // ── 4. Summary per indicator: what the report filter would see ──
  const summary = await pool.query(
    `
    SELECT
      i.id             AS "indicatorId",
      i.status         AS "indicatorStatus",
      i.progress,
      COUNT(s.id)                                             AS "submissionCount",
      COUNT(s.id) FILTER (
        WHERE s.review_status NOT IN ('Rejected', 'Correction Needed')
      )                                                       AS "validSubmissions",
      COUNT(sd.id)                                            AS "docCount",
      COUNT(sd.id) FILTER (WHERE sd.deleted_at IS NULL)       AS "activeDocCount",
      COUNT(sd.id) FILTER (WHERE sd.status != 'Deleted')      AS "visibleDocCount"
    FROM indicators i
    LEFT JOIN submissions s          ON s.indicator_id = i.id
    LEFT JOIN submission_documents sd ON sd.submission_id = s.id
    WHERE i.id = ANY($1::uuid[])
    GROUP BY i.id, i.status, i.progress
    ORDER BY i.created_at
    `,
    [TARGET_IDS]
  );
  console.log("\n── per-indicator summary ──");
  console.dir(summary.rows, { depth: null });

  await pool.end();
  console.log("\n✅ done.\n");
}

inspectThree().catch((e) => {
  console.error(e);
  process.exit(1);
});