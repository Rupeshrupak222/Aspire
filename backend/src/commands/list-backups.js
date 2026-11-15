#!/usr/bin/env node
require('../config/env').loadEnv();
const backupService = require('../services/backup/backup.service');

async function main() {
  console.log('====================================================');
  console.log('ASPIRE BY ADYAPAN — AVAILABLE BACKUP REPOSITORY');
  console.log('====================================================\n');

  try {
    const backups = await backupService.listBackups();

    if (backups.length === 0) {
      console.log('  No backup archives found in repository.');
      process.exit(0);
    }

    console.log(`Found ${backups.length} backup archive(s):\n`);
    console.log(
      'STATUS'.padEnd(10) +
      'BACKUP ID'.padEnd(36) +
      'CREATED AT'.padEnd(26) +
      'SIZE (MB)'.padEnd(12) +
      'ENCRYPTED'.padEnd(12) +
      'SCHEMA'
    );
    console.log('-'.repeat(105));

    for (const b of backups) {
      const status = b.isValid ? 'VALID' : 'CORRUPT';
      const sizeMb = (b.sizeBytes / 1024 / 1024).toFixed(2);
      const isEncrypted = b.manifest?.encryptionMetadata?.encrypted ? 'YES' : 'NO';
      const schema = b.manifest?.databaseSchemaVersion || 'unknown';

      console.log(
        status.padEnd(10) +
        b.backupId.padEnd(36) +
        new Date(b.createdAt).toLocaleString().padEnd(26) +
        sizeMb.padEnd(12) +
        isEncrypted.padEnd(12) +
        schema
      );
    }

    console.log('');
    process.exit(0);
  } catch (err) {
    console.error('\n  FAILED   Failed to list backups:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

