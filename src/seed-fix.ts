// src/seeds/keepBatch2.ts
import { pool } from "./config/db";

const SUBMISSION_ID = "79096d97-ccb6-4cb0-b7d5-aa6f6356bfcf";
const BATCH_1_CUTOFF = new Date("2026-06-20T20:32:15Z"); // ← real Date

async function keepBatch2() {
  const client = await pool.connect();

  try {
    console.log("\n══ KEEP BATCH 2 (polished descriptions) ══\n");

    const { rows: all } = await client.query(
      `
      SELECT id, file_name, description, status, deleted_at, uploaded_at
      FROM submission_documents
      WHERE submission_id = $1
      ORDER BY uploaded_at, file_name
      `,
      [SUBMISSION_ID]
    );

    console.log("── current state ──");
    console.table(
      all.map((r) => ({
        docId: r.id.slice(0, 8),
        fileName: (r.file_name || "").slice(0, 40),
        description: (r.description || "").slice(0, 50),
        uploadedAt: r.uploaded_at,
        status: r.status,
        deleted: r.deleted_at ? "yes" : "—",
      }))
    );

    /* ── Split — coerce uploaded_at to Date for a proper comparison ── */
    const batch1 = all.filter(
      (r) => new Date(r.uploaded_at).getTime() <= BATCH_1_CUTOFF.getTime()
    );
    const batch2 = all.filter(
      (r) => new Date(r.uploaded_at).getTime() > BATCH_1_CUTOFF.getTime()
    );

    console.log(`\nBatch 1 docs to SOFT-DELETE: ${batch1.length}`);
    console.table(
      batch1.map((r) => ({
        docId: r.id.slice(0, 8),
        fileName: (r.file_name || "").slice(0, 45),
        status: r.status,
      }))
    );

    console.log(`\nBatch 2 docs to RESTORE: ${batch2.length}`);
    console.table(
      batch2.map((r) => ({
        docId: r.id.slice(0, 8),
        fileName: (r.file_name || "").slice(0, 45),
        status: r.status,
        wasDeleted: r.deleted_at ? "yes" : "—",
      }))
    );

    if (batch1.length !== 6 || batch2.length !== 6) {
      console.log(
        `\n⚠️  Expected 6 + 6 = 12 docs. Got ${batch1.length} + ${batch2.length}. Review before proceeding.`
      );
      console.log("Aborting.\n");
      return; // finally will release
    }

    const confirmed = process.argv.includes("--confirm");
    if (!confirmed) {
      console.log("\n⚠️  DRY RUN. Re-run with `-- --confirm` to apply.\n");
      return; // finally will release
    }

    await client.query("BEGIN");

    const delRes = await client.query(
      `
      UPDATE submission_documents
      SET deleted_at = NOW(), status = 'Deleted'
      WHERE id = ANY($1::uuid[])
      RETURNING id
      `,
      [batch1.map((r) => r.id)]
    );

    const restoreRes = await client.query(
      `
      UPDATE submission_documents
      SET deleted_at = NULL, status = 'Pending'
      WHERE id = ANY($1::uuid[])
      RETURNING id
      `,
      [batch2.map((r) => r.id)]
    );

    await client.query("COMMIT");

    console.log(`\n✅ Soft-deleted ${delRes.rows.length} batch-1 docs.`);
    console.log(`✅ Restored ${restoreRes.rows.length} batch-2 docs.\n`);

    /* ── Print final state ── */
    const { rows: after } = await client.query(
      `
      SELECT id, file_name, description, status, deleted_at, uploaded_at
      FROM submission_documents
      WHERE submission_id = $1
      ORDER BY uploaded_at, file_name
      `,
      [SUBMISSION_ID]
    );

    console.log("── final state ──");
    console.table(
      after.map((r) => ({
        docId: r.id.slice(0, 8),
        fileName: (r.file_name || "").slice(0, 40),
        description: (r.description || "").slice(0, 50),
        status: r.status,
        deleted: r.deleted_at ? "yes" : "—",
      }))
    );

    const activeCount = after.filter((r) => !r.deleted_at).length;
    console.log(`\n📊 Active docs remaining: ${activeCount}`);
    console.log("   Reload the report — Q2 2026 should show 6 bullets.\n");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

keepBatch2().catch((e) => {
  console.error(e);
  process.exit(1);
});