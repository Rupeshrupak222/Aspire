#!/usr/bin/env node
require('../config/env').loadEnv();
const backupService = require('../services/backup/backup.service');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('====================================================');
  console.log('ASPIRE BY ADYAPAN — BACKUP RETENTION CLEANUP');
  console.log('====================================================\n');
  console.log(`[cleanup] Policy: GFS (Daily 7d, Weekly 4w, Monthly 6mo)`);
  console.log(`[cleanup] Mode:   ${dryRun ? 'DRY-RUN (Simulated)' : 'ACTIVE (Pruning expired archives)'}\n`);

  try {
    const report = await backupService.cleanupBackups({ dryRun });

    console.log(`  Evaluated: ${report.evaluatedCount} backup(s)`);
    console.log(`  Retained:  ${report.retainedCount} backup(s)`);
    console.log(`  Pruned:    ${report.deletedCount} backup(s)\n`);

    if (report.deletedBackups.length > 0) {
      console.log('  Pruned Archives:');
      report.deletedBackups.forEach(id => console.log(`   - ${id}`));
      console.log('');
    }

    if (report.retainedBackups.length > 0) {
      console.log('  Retained Recovery Points:');
      report.retainedBackups.forEach(id => console.log(`   - ${id}`));
      console.log('');
    }

    process.exit(0);
  } catch (err) {
    console.error('\n  FAILED   Cleanup failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

