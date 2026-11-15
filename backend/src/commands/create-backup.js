#!/usr/bin/env node
require('../config/env').loadEnv();
const backupService = require('../services/backup/backup.service');

async function main() {
  const args = process.argv.slice(2);
  const typeIndex = args.indexOf('--type');
  const type = typeIndex !== -1 && args[typeIndex + 1] ? args[typeIndex + 1] : 'full';
  const noEncrypt = args.includes('--no-encrypt');
  const syncCloud = args.includes('--sync-cloud');

  console.log('====================================================');
  console.log('ASPIRE BY ADYAPAN — BACKUP GENERATION CLI');
  console.log('====================================================\n');
  console.log(`[backup] Mode:          ${type.toUpperCase()}`);
  console.log(`[backup] Encryption:    ${!noEncrypt ? 'AES-256-GCM (Enabled)' : 'Disabled'}`);
  console.log(`[backup] Cloud Sync:    ${syncCloud ? 'Enabled' : 'Disabled'}\n`);

  try {
    const result = await backupService.createBackup({
      type,
      encrypt: !noEncrypt,
      syncCloud
    });

    console.log('  SUCCESS  Backup created successfully!\n');
    console.log(`  Backup ID:     ${result.backupId}`);
    console.log(`  Created At:    ${result.createdAt}`);
    console.log(`  Location:      ${result.location}`);
    console.log(`  Total Size:    ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB (${result.sizeBytes} bytes)`);
    console.log(`  Files Indexed: ${result.fileCount}`);
    console.log(`  Encrypted:     ${result.encrypted ? 'YES' : 'NO'}`);

    if (result.retention && result.retention.deletedCount > 0) {
      console.log(`  Retention:     Pruned ${result.retention.deletedCount} expired backup(s)`);
    }

    process.exit(0);
  } catch (err) {
    console.error('\n  FAILED   Backup generation failed:');
    console.error(`  Error:   ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

