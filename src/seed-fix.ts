// src/seed-constraints.ts
import { pool } from "./config/db";

async function main() {
  console.log("🐘 Applying schema constraints...");
  const client = await pool.connect();

  try {
    /* ──────────────────────────────────────────────────────────────────
       Guard: don't add the constraint if nulls still exist — it would
       fail mid-migration and leave you in a half-applied state.
       ────────────────────────────────────────────────────────────────── */
    const nullCheck = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM submissions
      WHERE achieved_value IS NULL
    `);

    if (nullCheck.rows[0].count > 0) {
      console.error(
        `❌ ${nullCheck.rows[0].count} submissions still have NULL achieved_value.`
      );
      console.error("   Run seed-fix.ts first, then re-run this script.");
      process.exitCode = 1;
      return;
    }

    /* ──────────────────────────────────────────────────────────────────
       Apply NOT NULL. Use IF NOT EXISTS pattern via DO block since
       Postgres doesn't support ADD CONSTRAINT IF NOT EXISTS directly.
       ────────────────────────────────────────────────────────────────── */
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'submissions_achieved_value_not_null'
        ) THEN
          ALTER TABLE submissions
            ALTER COLUMN achieved_value SET NOT NULL;
        END IF;
      END
      $$;
    `);

    console.log("✅ submissions.achieved_value is now NOT NULL");

    /* ──────────────────────────────────────────────────────────────────
       Same treatment for approved_amount on review_history, but ONLY
       for actions where it must exist ('Partially Approved', 'Approved',
       'Rejected' is excluded because rejections don't have amounts).
       We use a CHECK constraint instead of NOT NULL so rejections can
       still be inserted.
       ────────────────────────────────────────────────────────────────── */
    const nullAmounts = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM review_history
      WHERE approved_amount IS NULL
        AND action IN ('Partially Approved', 'Approved')
    `);

    if (nullAmounts.rows[0].count > 0) {
      console.warn(
        `⚠️  ${nullAmounts.rows[0].count} review_history rows still have NULL approved_amount — skipping CHECK constraint.`
      );
    } else {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'review_history_approved_amount_check'
          ) THEN
            ALTER TABLE review_history
              ADD CONSTRAINT review_history_approved_amount_check
              CHECK (
                action NOT IN ('Partially Approved', 'Approved')
                OR approved_amount IS NOT NULL
              );
          END IF;
        END
        $$;
      `);
      console.log("✅ review_history.approved_amount CHECK constraint applied");
    }

    console.log("\n🎉 Schema constraints applied.");
  } catch (err) {
    console.error("❌ Constraint script failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();