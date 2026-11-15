#!/usr/bin/env node
require('../config/env').loadEnv();
const backupService = require('../services/backup/backup.service');

async function main() {
  const args = process.argv.slice(2);
  const idIndex = args.indexOf('--id');
  const backupId = idIndex !== -1 ? args[idIndex + 1] : args[0];
  const dryRun = args.includes('--dry-run');
  const confirm = args.includes('--confirm');

  console.log('====================================================');
  console.log('ASPIRE BY ADYAPAN — DISASTER RECOVERY RESTORE CLI');
  console.log('====================================================\n');

  if (!backupId) {
    console.error('  ERROR: Backup ID is required.');
    console.log('  Usage: npm run backup:restore -- --id <backupId> [--dry-run] [--confirm]\n');
    process.exit(1);
  }

  try {
    const report = await backupService.restoreBackup({
      backupId,
      dryRun,
      confirm
    });

    if (report.dryRun) {
      console.log('  [DRY-RUN] Restore preview and verification completed successfully:\n');
      console.log(`  Source Backup:        ${report.preview.backupId}`);
      console.log(`  Backup Created:       ${report.preview.createdAt}`);
      console.log(`  Database Integrity:   ${report.preview.databaseIntegrity}`);
      console.log(`  Foreign Key Check:    ${report.preview.foreignKeyIntegrity ? 'PASSED' : 'FAILED'}`);
      console.log(`  Schema Version:       ${report.preview.stagedSchemaVersion}`);
      console.log(`  Encrypted Artifacts:  ${report.preview.isEncrypted ? 'YES' : 'NO'}`);
      console.log(`  Target Database:      ${report.preview.targetDbPath}`);
      console.log(`  Target Uploads:       ${report.preview.targetUploadsDir}\n`);

      console.log('  Table Record Counts in Restored Snapshot:');
      for (const [t, cnt] of Object.entries(report.preview.tableCounts)) {
        console.log(`   - ${t.padEnd(28)}: ${cnt}`);
      }

      console.log('\n  Notice: This was a DRY-RUN. No live files or databases were modified.');
      console.log('  To execute actual live replacement, run with the --confirm flag:');
      console.log(`  npm run backup:restore -- --id ${backupId} --confirm\n`);
      process.exit(0);
    }

    console.log('  SUCCESS  Disaster recovery restore executed successfully!\n');
    console.log(`  Restored Backup ID:   ${report.preview.backupId}`);
    console.log(`  Live Database:        ${report.preview.targetDbPath}`);
    console.log(`  Rollback Snapshot:    ${report.rollbackSnapshots?.database || 'None'}`);
    console.log(`  Database Integrity:   ${report.preview.databaseIntegrity}`);
    console.log(`  Foreign Key Check:    ${report.preview.foreignKeyIntegrity ? 'PASSED' : 'FAILED'}\n`);
    console.log('  System is now operational with the restored snapshot.\n');
    process.exit(0);

  } catch (err) {
    console.error('\n  FAILED   Restore operation failed:');
    console.error(`  Error:   ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

