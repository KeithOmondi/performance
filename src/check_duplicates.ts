import { pool } from "./config/db";



async function main() {
  console.log("\n=== 1. Index definition ===");
  const idx = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_submissions_indicator_quarter_active'`
  );
  console.log(idx.rows);

  console.log("\n=== 2. Rows for the specific indicator/quarter/year from the error ===");
  const specific = await pool.query(
    `SELECT id, indicator_id, quarter, year, review_status, is_reviewed,
            resubmission_count, submitted_at, submitted_by
     FROM submissions
     WHERE indicator_id = $1 AND quarter = $2 AND year = $3
     ORDER BY submitted_at DESC`,
    ["fb0e86a6-b408-41d1-8026-2fef22da98de", 0, 2026]
  );
  console.table(specific.rows);

  console.log("\n=== 3. Any indicator/quarter/year combos with duplicate rows already ===");
  const dupes = await pool.query(
    `SELECT indicator_id, quarter, year, COUNT(*), array_agg(review_status) AS statuses, array_agg(id) AS submission_ids
     FROM submissions
     GROUP BY indicator_id, quarter, year
     HAVING COUNT(*) > 1`
  );
  console.table(dupes.rows);

  console.log("\n=== 4. Full constraint definition ===");
  const constraint = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = 'idx_submissions_indicator_quarter_active'`
  );
  console.log(constraint.rows);

  await pool.end();
}

main().catch((err) => {
  console.error("Diagnostic script failed:", err);
  process.exit(1);
});