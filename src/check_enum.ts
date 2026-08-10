// Place at: server/src/check_enum.ts
// Run from server/ root with: npx ts-node src/check_enum.ts
import { pool } from "./config/db";

async function main() {
  console.log("\n=== Valid values for indicator_status enum ===");
  const result = await pool.query(`
    SELECT enumlabel
    FROM pg_enum
    JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
    WHERE pg_type.typname = 'indicator_status'
    ORDER BY enumsortorder
  `);
  console.table(result.rows);

  console.log("\n=== Valid values for review_status enum (for comparison) ===");
  const result2 = await pool.query(`
    SELECT enumlabel
    FROM pg_enum
    JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
    WHERE pg_type.typname = 'review_status'
    ORDER BY enumsortorder
  `);
  console.table(result2.rows);

  await pool.end();
}

main().catch((err) => {
  console.error("Diagnostic script failed:", err);
  process.exit(1);
});