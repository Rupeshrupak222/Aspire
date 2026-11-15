#!/usr/bin/env node
require('../config/env').loadEnv();
const backupService = require('../services/backup/backup.service');

async function main() {
  const args = process.argv.slice(2);
  const idIndex = args.indexOf('--id');
  const backupId = idIndex !== -1 ? args[idIndex + 1] : args[0];

  console.log('====================================================');
  console.log('ASPIRE BY ADYAPAN — BACKUP INTEGRITY VERIFIER');
  console.log('====================================================\n');

  if (!backupId) {
    console.error('  ERROR: Backup ID is required.');
    console.log('  Usage: npm run backup:verify -- --id <backupId>\n');
    process.exit(1);
  }

  try {
    console.log(`[verify] Inspecting backup: ${backupId}...`);
    const result = await backupService.verifyBackup(backupId);

    if (result.valid) {
      console.log('  PASS  Manifest schema validated.');
      console.log('  PASS  All SHA-256 artifact checksums matched.');
      console.log('  PASS  Packaging integrity confirmed.\n');
      console.log(`  Backup ID:     ${result.backupId}`);
      console.log(`  Created At:    ${result.createdAt}`);
      console.log(`  Total Size:    ${(result.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  Files Count:   ${result.fileCount}`);
      console.log(`  Encrypted:     ${result.encrypted ? 'YES' : 'NO'}\n`);
      process.exit(0);
    } else {
      console.error('  FAIL  Backup integrity verification FAILED!');
      if (result.errors && result.errors.length > 0) {
        console.error('  Discrepancies found:');
        result.errors.forEach(e => console.error(`   - ${e}`));
      }
      console.log('');
      process.exit(1);
    }
  } catch (err) {
    console.error('\n  FAILED   Verification process encountered an error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

