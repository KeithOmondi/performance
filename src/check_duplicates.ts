// src/check_duplicates.ts
import { pool } from "./config/db";

const GHOST_INDICATOR_ID  = "e7ad1bb0-ac1e-4d84-a33a-79dbd89d0e32";
const GHOST_ACTIVITY_ID   = "01ceeee3-410c-4036-8c28-560d9261067d";
const GHOST_OBJECTIVE_ID  = "42bfafbe-96de-45a6-8064-ad51c36df03c";
const KEEP_INDICATOR_ID   = "5c236e0a-a694-46cb-bc6e-92e57108ddb6";

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║           KILL GHOST INDICATOR / ACTIVITY / OBJECTIVE          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  const commit = process.argv.includes("--commit");
  console.log(commit ? "🔴 MODE: COMMIT (deletions will run)\n" : "🔒 MODE: DRY RUN (nothing will be deleted)\n");

  // ─────────────────────────────────────────────────────────────────
  // PHASE 1: Inventory — figure out exactly what's tied to the ghost
  // ─────────────────────────────────────────────────────────────────

  console.log("─── PHASE 1: INVENTORY ───────────────────────────────────────────\n");

  // 1a. Ghost indicator
  const ghostInd = await pool.query(
    `SELECT id, assignee_id, reporting_cycle, status, deleted_at
     FROM indicators WHERE id = $1`, [GHOST_INDICATOR_ID]);
  if (ghostInd.rowCount === 0) {
    console.log("✅ Ghost indicator already gone. Nothing to do.");
    await pool.end();
    return;
  }
  const gi = ghostInd.rows[0];
  console.log(`[1a] Ghost indicator:      ${gi.id}`);
  console.log(`     assignee=${gi.assignee_id ?? "NULL"}  cycle=${gi.reporting_cycle}  status=${gi.status}`);

  // 1b. Submissions on the ghost indicator
  const ghostSubs = await pool.query(
    `SELECT id, review_status FROM submissions WHERE indicator_id = $1`,
    [GHOST_INDICATOR_ID]);
  console.log(`\n[1b] Submissions on ghost: ${ghostSubs.rowCount}`);

  // 1c. Other indicators on the ghost activity
  const otherInds = await pool.query(
    `SELECT id, assignee_id, reporting_cycle, status
     FROM indicators WHERE activity_id = $1 AND id != $2`,
    [GHOST_ACTIVITY_ID, GHOST_INDICATOR_ID]);
  console.log(`[1c] Other indicators on ghost activity: ${otherInds.rowCount}`);
  for (const r of otherInds.rows) {
    console.log(`     • ${r.id}  assignee=${r.assignee_id ?? "NULL"}  cycle=${r.reporting_cycle}  status=${r.status}`);
  }

  // 1d. Other activities on the ghost objective
  const otherActs = await pool.query(
    `SELECT id, description FROM strategic_activities
     WHERE objective_id = $1 AND id != $2`,
    [GHOST_OBJECTIVE_ID, GHOST_ACTIVITY_ID]);
  console.log(`\n[1d] Other activities on ghost objective: ${otherActs.rowCount}`);
  for (const r of otherActs.rows) {
    console.log(`     • ${r.id} — ${r.description.slice(0, 70)}`);
  }

  // 1e. Anything else referencing the ghost objective
  const otherRefs: Array<{ table: string; count: number }> = [];
  const refTables = [
    { table: "examiner_folder_assignments", col: "objective_id" },
    { table: "indicator_archives",          col: "objective_id" },
  ];
  for (const { table, col } of refTables) {
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`,
        [GHOST_OBJECTIVE_ID]);
      if (r.rows[0].n > 0) otherRefs.push({ table, count: r.rows[0].n });
      console.log(`[1e] ${table}.${col} references: ${r.rows[0].n}`);
    } catch {
      console.log(`[1e] ${table}: (table/column missing, skipping)`);
    }
  }

  // 1f. Documents under ghost submissions (should be zero)
  let ghostDocCount = 0;
  if (ghostSubs.rowCount && ghostSubs.rowCount > 0) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM submission_documents
       WHERE submission_id IN (SELECT id FROM submissions WHERE indicator_id = $1)`,
      [GHOST_INDICATOR_ID]);
    ghostDocCount = r.rows[0].n;
  }
  console.log(`[1f] Documents tied to ghost submissions: ${ghostDocCount}`);

  // 1g. Confirm keep indicator is safe
  const keep = await pool.query(
    `SELECT id, status FROM indicators WHERE id = $1`, [KEEP_INDICATOR_ID]);
  console.log(`\n[1g] KEEP indicator: ${KEEP_INDICATOR_ID} → ${keep.rows[0]?.status ?? "❌ NOT FOUND"}`);

  // ─────────────────────────────────────────────────────────────────
  // PHASE 2: Decision — what's safe to delete?
  // ─────────────────────────────────────────────────────────────────

  console.log("\n─── PHASE 2: PLAN ────────────────────────────────────────────────\n");

  const safeToDeleteActivity = otherInds.rowCount === 0;
  const safeToDeleteObjective =
    otherActs.rowCount === 0 && otherRefs.length === 0;

  console.log(`  Delete ghost indicator  (${GHOST_INDICATOR_ID})       → ✅ always`);
  console.log(`  Delete ghost activity   (${GHOST_ACTIVITY_ID})        → ${safeToDeleteActivity ? "✅ no other indicators reference it" : "❌ blocked — other indicators reference it"}`);
  console.log(`  Delete ghost objective  (${GHOST_OBJECTIVE_ID})       → ${safeToDeleteObjective ? "✅ no other references" : "❌ blocked — other rows reference it"}`);

  if (ghostSubs.rowCount && ghostSubs.rowCount > 0) {
    console.log(`\n  ⚠️  Ghost has ${ghostSubs.rowCount} submission(s) — will delete them first (cascade).`);
  }
  if (ghostDocCount > 0) {
    console.log(`  ⚠️  Ghost has ${ghostDocCount} document(s) — will delete them first.`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════════");

  if (!commit) {
    console.log("\n🔒 DRY RUN COMPLETE — no changes made.");
    console.log("   Re-run with --commit to execute.\n");
    await pool.end();
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // PHASE 3: Commit — transactional deletion
  // ─────────────────────────────────────────────────────────────────

  console.log("\n🔴 PHASE 3: EXECUTING DELETIONS\n");
  await pool.query("BEGIN");
  try {
    // 3a. Delete submission_documents tied to ghost submissions
    if (ghostSubs.rowCount && ghostSubs.rowCount > 0) {
      const del = await pool.query(
        `DELETE FROM submission_documents
         WHERE submission_id IN (SELECT id FROM submissions WHERE indicator_id = $1)`,
        [GHOST_INDICATOR_ID]);
      console.log(`  ✅ Deleted ${del.rowCount} submission_documents`);
    }

    // 3b. Delete submissions
    const delSubs = await pool.query(
      `DELETE FROM submissions WHERE indicator_id = $1`, [GHOST_INDICATOR_ID]);
    console.log(`  ✅ Deleted ${delSubs.rowCount} submissions`);

    // 3c. Delete indicator_assignees (join table)
    try {
      const delAss = await pool.query(
        `DELETE FROM indicator_assignees WHERE indicator_id = $1`, [GHOST_INDICATOR_ID]);
      console.log(`  ✅ Deleted ${delAss.rowCount} indicator_assignees`);
    } catch {
      console.log(`  ℹ️  indicator_assignees: table/column missing, skipped`);
    }

    // 3d. Delete the ghost indicator
    const delInd = await pool.query(
      `DELETE FROM indicators WHERE id = $1`, [GHOST_INDICATOR_ID]);
    console.log(`  ✅ Deleted ${delInd.rowCount} indicator`);

    // 3e. Delete the activity if safe
    if (safeToDeleteActivity) {
      const delAct = await pool.query(
        `DELETE FROM strategic_activities WHERE id = $1`, [GHOST_ACTIVITY_ID]);
      console.log(`  ✅ Deleted ${delAct.rowCount} strategic_activity`);
    } else {
      console.log(`  ⏭️  Skipped activity deletion (still referenced)`);
    }

    // 3f. Delete the objective if safe
    if (safeToDeleteObjective) {
      const delObj = await pool.query(
        `DELETE FROM strategic_objectives WHERE id = $1`, [GHOST_OBJECTIVE_ID]);
      console.log(`  ✅ Deleted ${delObj.rowCount} strategic_objective`);
    } else {
      console.log(`  ⏭️  Skipped objective deletion (still referenced)`);
    }

    await pool.query("COMMIT");
    console.log("\n🎉 COMMIT SUCCESSFUL — ghost fully removed.\n");
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("\n❌ ROLLBACK — nothing was deleted.");
    console.error(err);
  }

  await pool.end();
}

main().catch((err) => { console.error("Script failed:", err); process.exit(1); });