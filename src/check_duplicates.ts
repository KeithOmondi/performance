import { pool } from "./config/db";

async function cleanAllDescriptions() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║         CLEAN ALL DOCUMENT DESCRIPTIONS                        ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // =============================================
  // 1. Show summary of descriptions with whitespace
  // =============================================
  console.log("=== 1. Summary of descriptions with whitespace issues ===");
  const whitespaceSummary = await pool.query(`
    SELECT 
      COUNT(*) as total_with_whitespace,
      COUNT(DISTINCT description) as unique_descriptions
    FROM submission_documents
    WHERE description LIKE ' %' 
       OR description LIKE '% '
       OR description LIKE '  %'
       OR description LIKE '%  '
  `);
  
  console.log(`   Total documents with whitespace: ${whitespaceSummary.rows[0]?.total_with_whitespace ?? 0}`);
  console.log(`   Unique descriptions affected: ${whitespaceSummary.rows[0]?.unique_descriptions ?? 0}\n`);

  // =============================================
  // 2. Show sample of descriptions with whitespace
  // =============================================
  console.log("=== 2. Sample of descriptions with whitespace ===");
  const sampleResult = await pool.query(`
    SELECT 
      id,
      submission_id,
      description,
      LENGTH(description) as char_length,
      LENGTH(TRIM(description)) as trimmed_length,
      CASE 
        WHEN description LIKE '% ' THEN 'Has trailing space'
        WHEN description LIKE ' %' THEN 'Has leading space'
        WHEN description LIKE '%  %' THEN 'Has multiple spaces'
        ELSE 'Other'
      END as issue_type
    FROM submission_documents
    WHERE description LIKE ' %' 
       OR description LIKE '% '
       OR description LIKE '  %'
       OR description LIKE '%  '
    LIMIT 20
  `);
  
  if ((sampleResult.rowCount ?? 0) > 0) {
    console.table(sampleResult.rows);
  }
  console.log();

  // =============================================
  // 3. Show Wajir descriptions specifically
  // =============================================
  console.log("=== 3. Wajir descriptions with whitespace ===");
  const wajirResult = await pool.query(`
    SELECT 
      id,
      description,
      LENGTH(description) as char_length,
      LENGTH(TRIM(description)) as trimmed_length,
      TRIM(description) as trimmed_description
    FROM submission_documents
    WHERE description ILIKE '%wajir%'
       OR description ILIKE '%operationalization%'
    ORDER BY description
  `);
  
  if ((wajirResult.rowCount ?? 0) > 0) {
    console.table(wajirResult.rows);
  }
  console.log();

  // =============================================
  // 4. Fix all descriptions with whitespace
  // =============================================
  console.log("⚠️  WARNING: This will trim whitespace from ALL document descriptions");
  console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Trim whitespace from all descriptions
    const result = await client.query(`
      UPDATE submission_documents
      SET description = TRIM(description),
          updated_at = NOW()
      WHERE description LIKE ' %' 
         OR description LIKE '% '
         OR description LIKE '  %'
         OR description LIKE '%  '
      RETURNING id, description as old_description, TRIM(description) as new_description
    `);
    
    const resultCount = result.rowCount ?? 0;
    console.log(`\n✅ Trimmed whitespace from ${resultCount} documents`);
    
    if (resultCount > 0 && resultCount <= 50) {
      console.log("\n📝 Updated documents:");
      console.table(result.rows);
    } else if (resultCount > 50) {
      console.log(`\n📝 Updated ${resultCount} documents (showing first 20):`);
      console.table(result.rows.slice(0, 20));
      console.log(`   ... and ${resultCount - 20} more`);
    }
    
    await client.query('COMMIT');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ Fix failed:", error);
  } finally {
    client.release();
    await pool.end();
  }

  // =============================================
  // 5. Verify the fix
  // =============================================
  console.log("\n=== 5. Verifying Fix ===");
  const verifyResult = await pool.query(`
    SELECT COUNT(*) as count
    FROM submission_documents
    WHERE description LIKE ' %' 
       OR description LIKE '% '
       OR description LIKE '  %'
       OR description LIKE '%  '
  `);
  
  const remainingCount = verifyResult.rows[0]?.count ?? 0;
  console.log(`Remaining descriptions with whitespace: ${remainingCount}`);
  
  if (remainingCount === 0) {
    console.log("✅ All descriptions have been trimmed!");
  }
}

// =============================================
// DRY RUN - Show what will be fixed
// =============================================
async function dryRun() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║    DRY RUN - NO CHANGES WILL BE MADE                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  console.log("=== Descriptions that will be trimmed ===");
  const result = await pool.query(`
    SELECT 
      id,
      description as current_description,
      TRIM(description) as trimmed_description,
      LENGTH(description) as current_length,
      LENGTH(TRIM(description)) as trimmed_length
    FROM submission_documents
    WHERE description LIKE ' %' 
       OR description LIKE '% '
       OR description LIKE '  %'
       OR description LIKE '%  '
    ORDER BY LENGTH(description) DESC
    LIMIT 30
  `);
  
  const resultCount = result.rowCount ?? 0;
  console.log(`Found ${resultCount} descriptions with whitespace (showing up to 30)\n`);
  
  if (resultCount > 0) {
    console.table(result.rows);
  }
  
  if (resultCount > 30) {
    console.log(`\n... and ${resultCount - 30} more descriptions`);
  }

  await pool.end();
}

// =============================================
// MAIN EXECUTION
// =============================================

const args = process.argv.slice(2);

if (args.includes('--dry-run')) {
  console.log("🔍 Running dry run mode... (no changes will be made)");
  dryRun().catch((err) => {
    console.error("Dry run failed:", err);
    process.exit(1);
  });
} else if (args.includes('--fix')) {
  console.log("🚀 Running fix mode...");
  cleanAllDescriptions().catch((err) => {
    console.error("Fix script failed:", err);
    process.exit(1);
  });
} else if (args.includes('--help')) {
  console.log(`
Usage:
  npx ts-node src/check_duplicates.ts --desc-dry-run   - Show what will be fixed (no changes)
  npx ts-node src/check_duplicates.ts --desc-fix       - Trim whitespace from all descriptions
  `);
  process.exit(0);
} else {
  console.log("🔍 Running description cleanup...");
  cleanAllDescriptions().catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });
}