// Place at: server/src/check_triggers.ts
// Run from server/ root with: npx ts-node src/check_triggers.ts
import { pool } from "./config/db";

async function main() {
  console.log("\n=== 1. All triggers on the submissions table ===");
  const triggers = await pool.query(`
    SELECT
      t.tgname AS trigger_name,
      t.tgenabled AS enabled,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'submissions'
      AND NOT t.tgisinternal
  `);
  console.log(triggers.rows.length === 0 ? "No triggers found on submissions table." : "");
  triggers.rows.forEach((r) => {
    console.log(`\n--- ${r.trigger_name} (enabled: ${r.enabled}) ---`);
    console.log(r.definition);
  });

  console.log("\n=== 2. All functions that reference the submissions table ===");
  const funcs = await pool.query(`
    SELECT
      p.proname AS function_name,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND prosrc ILIKE '%submissions%'
  `);
  console.log(funcs.rows.length === 0 ? "No functions referencing submissions found." : "");
  funcs.rows.forEach((r) => {
    console.log(`\n--- FUNCTION: ${r.function_name} ---`);
    console.log(r.definition);
  });

  console.log("\n=== 3. Any rules on the submissions table (older Postgres feature, less common but worth checking) ===");
  const rules = await pool.query(`
    SELECT rulename, definition
    FROM pg_rules
    WHERE tablename = 'submissions'
  `);
  console.log(rules.rows.length === 0 ? "No rules found." : "");
  rules.rows.forEach((r) => {
    console.log(`\n--- RULE: ${r.rulename} ---`);
    console.log(r.definition);
  });

  await pool.end();
}

main().catch((err) => {
  console.error("Diagnostic script failed:", err);
  process.exit(1);
});