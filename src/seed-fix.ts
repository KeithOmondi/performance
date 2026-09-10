// src/scripts/inspect-enums.ts

import { pool } from "./config/db";


async function main() {
  console.log("🐘 Connected to Neon. Inspecting enums and statuses...\n");

  const client = await pool.connect();

  try {
    /* ────────────────────────────────────────────────────────────────
       1. What values does the `indicator_status` enum actually have?
       ──────────────────────────────────────────────────────────────── */
    console.log("=== 1. indicator_status enum values ===");
    const indStatus = await client.query(`
      SELECT unnest(enum_range(NULL::indicator_status)) AS value
    `);
    indStatus.rows.forEach((r) => console.log(`  • ${r.value}`));

    /* ────────────────────────────────────────────────────────────────
       2. What values does the `review_status` enum have?
          (this is where "Verified" actually lives)
       ──────────────────────────────────────────────────────────────── */
    console.log("\n=== 2. review_status enum values ===");
    const revStatus = await client.query(`
      SELECT unnest(enum_range(NULL::review_status)) AS value
    `);
    revStatus.rows.forEach((r) => console.log(`  • ${r.value}`));

    /* ────────────────────────────────────────────────────────────────
       3. What indicator_status values are actually used in the data,
          and how many rows per value?
       ──────────────────────────────────────────────────────────────── */
    console.log("\n=== 3. Actual indicator.status distribution ===");
    const indDist = await client.query(`
      SELECT status::text AS status, COUNT(*)::int AS count
      FROM indicators
      WHERE deleted_at IS NULL
      GROUP BY status
      ORDER BY count DESC
    `);
    indDist.rows.forEach((r) =>
      console.log(`  ${r.status.padEnd(32)} ${r.count}`)
    );

    /* ────────────────────────────────────────────────────────────────
       4. What review_status values are actually used in submissions?
       ──────────────────────────────────────────────────────────────── */
    console.log("\n=== 4. Actual submissions.review_status distribution ===");
    const subDist = await client.query(`
      SELECT review_status::text AS "reviewStatus", COUNT(*)::int AS count
      FROM submissions
      GROUP BY review_status
      ORDER BY count DESC
    `);
    subDist.rows.forEach((r) =>
      console.log(`  ${r.reviewStatus.padEnd(32)} ${r.count}`)
    );

    /* ────────────────────────────────────────────────────────────────
       5. Sanity check: are there any indicator rows with a status
          that would map to "Incomplete" per the frontend grouping?
       ──────────────────────────────────────────────────────────────── */
    console.log("\n=== 5. Counts per semantic group (as the frontend sees them) ===");
    const grouped = await client.query(`
      SELECT
        CASE
          WHEN status = 'Completed' THEN 'Complete'
          WHEN status IN ('Partially Approved', 'Awaiting Super Admin') THEN 'Partial'
          ELSE 'Incomplete'
        END AS "group",
        COUNT(*)::int AS count
      FROM indicators
      WHERE deleted_at IS NULL
      GROUP BY 1
      ORDER BY 1
    `);
    grouped.rows.forEach((r) =>
      console.log(`  ${r.group.padEnd(15)} ${r.count}`)
    );

    /* ────────────────────────────────────────────────────────────────
       6. Indicators that are "Incomplete" but currently excluded by
          the report controller's hard-coded NOT IN (...).
       ──────────────────────────────────────────────────────────────── */
    console.log("\n=== 6. Incomplete-status rows currently excluded by report WHERE ===");
    const excluded = await client.query(`
      SELECT status::text AS status, COUNT(*)::int AS count
      FROM indicators
      WHERE deleted_at IS NULL
        AND status NOT IN (
          'Completed',
          'Partially Approved',
          'Awaiting Super Admin'
        )
        AND status IN (
          'Awaiting Admin Approval',
          'Rejected by Admin',
          'Rejected by Super Admin',
          'Correction Needed'
        )
      GROUP BY status
      ORDER BY count DESC
    `);
    if (excluded.rows.length === 0) {
      console.log("  (none — nothing being silently excluded)");
    } else {
      excluded.rows.forEach((r) =>
        console.log(`  ${r.status.padEnd(32)} ${r.count}`)
      );
    }

    /* ────────────────────────────────────────────────────────────────
       7. Double-check the enum type name on the indicators.status column
       ──────────────────────────────────────────────────────────────── */
    console.log("\n=== 7. indicators.status column type ===");
    const colType = await client.query(`
      SELECT data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'indicators' AND column_name = 'status'
    `);
    colType.rows.forEach((r) =>
      console.log(`  data_type=${r.data_type}  udt_name=${r.udt_name}`)
    );

    console.log("\n✅ Inspection complete.");
  } catch (err) {
    console.error("❌ Inspection failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();