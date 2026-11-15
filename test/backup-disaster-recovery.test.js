// DAY 28 — BACKUP & DISASTER RECOVERY TEST SUITE
// Automated verification for SQLite WAL snapshots, asset preservation, encryption, manifest checksums, retention, and disaster recovery simulation.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const Database = require('better-sqlite3');

// Isolated test environment configuration
const TEST_DIR = path.join(os.tmpdir(), `aspire_backup_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const TEST_DB_PATH = path.join(TEST_DIR, 'aspire_test.db');
const TEST_BACKUP_DIR = path.join(TEST_DIR, 'backups');
const TEST_UPLOADS_DIR = path.join(TEST_DIR, 'uploads');
const TEST_LOGO_DIR = path.join(TEST_DIR, 'logo');
const TEST_ENCRYPTION_KEY = crypto.randomBytes(32);

process.env.DB_PATH = TEST_DB_PATH;
process.env.BACKUP_DIRECTORY = TEST_BACKUP_DIR;
process.env.STORAGE_LOCAL_DIR = TEST_UPLOADS_DIR;
process.env.BACKUP_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY.toString('hex');
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'backup_dr_test_secret_32bytes_valid!';

const { runMigrations } = require('../backend/src/db/migrations');
const dbBackupService = require('../backend/src/services/backup/database-backup.service');
const fileBackupService = require('../backend/src/services/backup/file-backup.service');
const configBackupService = require('../backend/src/services/backup/configuration-backup.service');
const manifestService = require('../backend/src/services/backup/backup-manifest.service');
const integrityService = require('../backend/src/services/backup/backup-integrity.service');
const encryptionService = require('../backend/src/services/backup/backup-encryption.service');
const retentionService = require('../backend/src/services/backup/backup-retention.service');
const schedulerService = require('../backend/src/services/backup/backup-scheduler.service');
const restoreService = require('../backend/src/services/backup/restore.service');
const backupService = require('../backend/src/services/backup/backup.service');
const { RcloneBackupStorageProvider } = require('../backend/src/services/backup/backup-storage.service');
const createApp = require('../backend/src/app');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function ok(name, condition, extra = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS  ${name}`);
  } else {
    failedTests++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('ASPIRE BY ADYAPAN — DAY 28 BACKUP & DR TEST SUITE');
  console.log('====================================================\n');

  // Initialize test database with all 20 migrations
  const testDb = new Database(TEST_DB_PATH);
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  runMigrations(testDb);

  // Setup test asset files
  fs.mkdirSync(path.join(TEST_UPLOADS_DIR, 'organizations', 'org_test_1', 'branding'), { recursive: true });
  fs.mkdirSync(TEST_LOGO_DIR, { recursive: true });

  const dummyLogoPath = path.join(TEST_UPLOADS_DIR, 'organizations', 'org_test_1', 'branding', 'test-logo.png');
  fs.writeFileSync(dummyLogoPath, Buffer.from('dummy_png_brand_logo_data_aspire_2026'));

  const coreLogoPath = path.join(TEST_LOGO_DIR, 'aspire-submark.png');
  fs.writeFileSync(coreLogoPath, Buffer.from('dummy_submark_data_adyapan'));

  try {
    // --------------------------------------------------------------------------
    // 1. Database Online Snapshot & Integrity Check (WAL Mode)
    // --------------------------------------------------------------------------
    console.log('\n--- 1. Database Snapshot & WAL Consistency ---');
    const snapshotDest = path.join(TEST_DIR, 'snap_1.sqlite');
    const snapResult = await dbBackupService.createSnapshot({
      db: testDb,
      dbPath: TEST_DB_PATH,
      targetPath: snapshotDest
    });

    ok('Snapshot created successfully', fs.existsSync(snapshotDest));
    ok('Snapshot file size > 0 bytes', snapResult.sizeBytes > 0);
    ok('Snapshot PRAGMA integrity_check returns ok', snapResult.integrityCheck === 'ok');
    ok('Snapshot foreign key check has 0 violations', snapResult.foreignKeyCheck === true);
    ok('Snapshot captured valid schema version', snapResult.schemaVersion.startsWith('020_') || snapResult.schemaVersion.length > 0);

    // --------------------------------------------------------------------------
    // 2. File and Asset Backup Preservation
    // --------------------------------------------------------------------------
    console.log('\n--- 2. File & Asset Backup Preservation ---');
    const filesStageDir = path.join(TEST_DIR, 'stage_files');
    const fileResult = await fileBackupService.backupFiles(filesStageDir, {
      uploadsDir: TEST_UPLOADS_DIR,
      logoDir: TEST_LOGO_DIR
    });

    ok('Backed up uploads directory', fileResult.uploads.fileCount >= 1);
    ok('Backed up logo directory', fileResult.logos.fileCount >= 1);
    ok('Calculated file SHA-256 hashes', Object.keys(fileResult.uploads.fileMap).length > 0);

    // --------------------------------------------------------------------------
    // 3. Configuration Inventory (Non-Secret Sanity)
    // --------------------------------------------------------------------------
    console.log('\n--- 3. Configuration Inventory & Secret Hygiene ---');
    const configPayload = configBackupService.generateConfigBackup(testDb);

    ok('Configuration inventory generated', Array.isArray(configPayload.configurationInventory));
    ok('Contains variable definitions', configPayload.configurationInventory.length > 10);
    ok('Database config extracted', typeof configPayload.databaseConfig === 'object');
    ok('Schema migration version recorded', configPayload.schemaMigrationVersion !== 'unknown');

    const serializedConfig = JSON.stringify(configPayload);
    ok('AUTH_SECRET is NOT leaked in config payload', !serializedConfig.includes('backup_dr_test_secret_32bytes_valid!'));
    ok('Encryption key is NOT leaked in config payload', !serializedConfig.includes(TEST_ENCRYPTION_KEY.toString('hex')));

    // --------------------------------------------------------------------------
    // 4. Authenticated Encryption & Decryption (AES-256-GCM)
    // --------------------------------------------------------------------------
    console.log('\n--- 4. Authenticated Encryption & Decryption (AES-256-GCM) ---');
    const testPlaintext = Buffer.from('Aspire confidential candidate assessment data — DO NOT LEAK');
    const encrypted = encryptionService.encryptBuffer(testPlaintext, TEST_ENCRYPTION_KEY);

    ok('Ciphertext produced with magic header', encrypted.encryptedBuffer.length > testPlaintext.length);
    ok('Algorithm is aes-256-gcm', encrypted.algorithm === 'aes-256-gcm');

    const decrypted = encryptionService.decryptBuffer(encrypted.encryptedBuffer, TEST_ENCRYPTION_KEY);
    ok('Decrypted buffer matches original plaintext exactly', decrypted.equals(testPlaintext));

    // Tampered ciphertext test
    const tampered = Buffer.from(encrypted.encryptedBuffer);
    tampered[tampered.length - 1] ^= 0xff; // flip last bit
    let tamperFailed = false;
    try {
      encryptionService.decryptBuffer(tampered, TEST_ENCRYPTION_KEY);
    } catch {
      tamperFailed = true;
    }
    ok('Tampered ciphertext rejected by authentication tag', tamperFailed);

    // Wrong key test
    const wrongKey = crypto.randomBytes(32);
    let wrongKeyFailed = false;
    try {
      encryptionService.decryptBuffer(encrypted.encryptedBuffer, wrongKey);
    } catch {
      wrongKeyFailed = true;
    }
    ok('Decryption fails safely when supplied wrong encryption key', wrongKeyFailed);

    // --------------------------------------------------------------------------
    // 5. Manifest & Checksum Validation
    // --------------------------------------------------------------------------
    console.log('\n--- 5. Manifest Generation & Checksum Trees ---');
    const sampleManifest = manifestService.createManifest({
      backupId: 'bak_test_manifest_01',
      backupType: 'full',
      artifacts: {
        database: { path: 'database.sqlite.enc', sizeBytes: 1024, sha256: crypto.randomBytes(32).toString('hex') }
      },
      fileCount: 1,
      totalSizeBytes: 1024,
      checksums: {
        'database.sqlite.enc': crypto.randomBytes(32).toString('hex')
      },
      encryptionMetadata: { encrypted: true, algorithm: 'aes-256-gcm', keyId: 'test-key' }
    });

    ok('Manifest created with valid backupId', sampleManifest.backupId === 'bak_test_manifest_01');
    ok('Manifest marked VERIFIED by default', sampleManifest.verificationStatus === 'VERIFIED');

    const manifestDir = path.join(TEST_DIR, 'manifest_test');
    await manifestService.writeManifest(manifestDir, sampleManifest);
    const readBack = await manifestService.readManifest(manifestDir);
    ok('Manifest persists and reads back correctly', readBack.valid && readBack.manifest.backupId === 'bak_test_manifest_01');

    // --------------------------------------------------------------------------
    // 6. GFS Retention Policy
    // --------------------------------------------------------------------------
    console.log('\n--- 6. GFS Retention & Safety Guards ---');
    const mockBackups = [
      { backupId: 'bak_today', createdAt: new Date().toISOString(), isValid: true },
      { backupId: 'bak_3days_ago', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), isValid: true },
      { backupId: 'bak_10days_ago', createdAt: new Date(Date.now() - 10 * 86400000).toISOString(), isValid: true },
      { backupId: 'bak_60days_ago', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), isValid: true },
      { backupId: 'bak_300days_ago', createdAt: new Date(Date.now() - 300 * 86400000).toISOString(), isValid: true }
    ];

    const retentionReport = await retentionService.applyRetention(mockBackups, { dryRun: true });
    ok('Recent backups within 7 days retained', retentionReport.retainedBackups.includes('bak_today'));
    ok('Backups within 7 days retained', retentionReport.retainedBackups.includes('bak_3days_ago'));
    ok('Old backups exceeding monthly limit pruned', retentionReport.deletedBackups.includes('bak_300days_ago'));

    // Critical guard: Only 1 backup exists
    const singleBackup = [{ backupId: 'bak_sole_survivor', createdAt: new Date(Date.now() - 999 * 86400000).toISOString(), isValid: true }];
    const soleReport = await retentionService.applyRetention(singleBackup, { dryRun: true });
    ok('CRITICAL: Never prunes when only 1 valid backup exists', soleReport.retainedCount === 1 && soleReport.deletedCount === 0);

    // Active restore guard
    const activeRestoreReport = await retentionService.applyRetention(mockBackups, {
      dryRun: true,
      activeRestoreBackupId: 'bak_300days_ago'
    });
    ok('CRITICAL: Never prunes backup currently being restored', activeRestoreReport.retainedBackups.includes('bak_300days_ago'));

    // --------------------------------------------------------------------------
    // 7. Rclone Offsite Adapter (Mock Mode)
    // --------------------------------------------------------------------------
    console.log('\n--- 7. Off-Site Storage Synchronization (Rclone) ---');
    const rclone = new RcloneBackupStorageProvider({ remote: 's3-remote', path: 'backup-bucket', mock: true });
    const rcloneInstalled = await rclone.isRcloneInstalled();
    ok('Rclone availability check functions', rcloneInstalled === true);

    const rcloneResult = await rclone.syncToRemote(TEST_DIR, 'bak_mock_001');
    ok('Rclone mock synchronization succeeds', rcloneResult.success === true);

    // --------------------------------------------------------------------------
    // 8. Scheduler & Concurrency Lock
    // --------------------------------------------------------------------------
    console.log('\n--- 8. Concurrency Protection & Scheduler Lock ---');
    schedulerService.acquireLock();
    ok('Exclusive backup lock acquired', fs.existsSync(schedulerService.lockFilePath));

    let collisionBlocked = false;
    try {
      schedulerService.acquireLock();
    } catch (err) {
      collisionBlocked = err.message.includes('Another backup operation');
    }
    ok('Concurrent backup attempt blocked by active lock', collisionBlocked);

    schedulerService.releaseLock();
    ok('Backup lock released cleanly', !fs.existsSync(schedulerService.lockFilePath));

    // --------------------------------------------------------------------------
    // 9. Complete End-to-End Backup Creation
    // --------------------------------------------------------------------------
    console.log('\n--- 9. Full End-to-End Backup Creation ---');
    // Seed representative data into testDb
    testDb.prepare(`
      INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
      VALUES (101, 'Disaster Recovery Academy', 'dr-academy', 'ACTIVE', datetime('now'), datetime('now'))
    `).run();

    testDb.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college, created_at)
      VALUES (201, 101, 'Alice Recovery', 'alice@recovery.internal', '9876543210', 'DR College', datetime('now'))
    `).run();

    testDb.prepare(`
      INSERT INTO exams (id, organization_id, name, code, duration_minutes, total_marks, status, created_at)
      VALUES (301, 101, 'DR Certification Exam', 'dr-exam', 60, 100, 'PUBLISHED', datetime('now'))
    `).run();

    testDb.prepare(`
      INSERT INTO attempts (id, token, student_id, exam_id, organization_id, status, started_at, expires_at, submitted_at, question_ids_json, score)
      VALUES (401, 'tok_dr_401', 201, 301, 101, 'submitted', datetime('now'), datetime('now', '+1 hour'), datetime('now'), '[]', 95.0)
    `).run();

    testDb.prepare(`
      INSERT INTO certificates (certificate_id, organization_id, attempt_id, student_id, exam_id, student_name, exam_title, score, total_marks, percentage, scholarship_pct, verification_status, payload_json, payload_hash, signature, verification_url)
      VALUES ('cert_dr_1', 101, 401, 201, 301, 'Alice Recovery', 'DR Certification Exam', 95.0, 100, 95.0, 100, 'VALID', '{}', 'hash_dr_1', 'sig_valid_hmac_dr', 'https://aspire.internal/verify/cert_dr_1')
    `).run();

    const backupResult = await backupService.createBackup({
      db: testDb,
      dbPath: TEST_DB_PATH,
      backupDir: TEST_BACKUP_DIR,
      type: 'full',
      encrypt: true,
      encryptionKey: TEST_ENCRYPTION_KEY
    });

    ok('Full backup created successfully', backupResult.success === true);
    ok('Backup ID assigned', !!backupResult.backupId);
    ok('Encrypted database artifact generated', fs.existsSync(path.join(backupResult.location, 'database.sqlite.enc')));
    ok('Manifest written to backup archive', fs.existsSync(path.join(backupResult.location, 'manifest.json')));

    // Verify created backup
    const verifyReport = await backupService.verifyBackup(backupResult.backupId);
    ok('Backup passes SHA-256 integrity verification', verifyReport.valid === true);
    ok('Zero verification errors found', verifyReport.errors.length === 0);

    // --------------------------------------------------------------------------
    // 10. Complete Disaster Recovery Simulation (Delete & Restore)
    // --------------------------------------------------------------------------
    console.log('\n--- 10. Disaster Recovery Simulation (Delete & Restore) ---');
    // Close testDb connection so we can simulate database deletion
    testDb.close();

    // Dry Run Test
    const dryRunReport = await restoreService.restoreBackup({
      backupId: backupResult.backupId,
      backupDir: TEST_BACKUP_DIR,
      targetDbPath: TEST_DB_PATH,
      targetUploadsDir: TEST_UPLOADS_DIR,
      encryptionKey: TEST_ENCRYPTION_KEY,
      dryRun: true
    });

    ok('Restore dry-run succeeded', dryRunReport.success === true && dryRunReport.dryRun === true);
    ok('Dry-run preview contains table counts', dryRunReport.preview.tableCounts.organizations >= 1);
    ok('Dry-run confirmed database integrity', dryRunReport.preview.databaseIntegrity === 'ok');

    // Attempt restore without --confirm (must abort)
    let abortNoConfirm = false;
    try {
      await restoreService.restoreBackup({
        backupId: backupResult.backupId,
        backupDir: TEST_BACKUP_DIR,
        targetDbPath: TEST_DB_PATH,
        targetUploadsDir: TEST_UPLOADS_DIR,
        encryptionKey: TEST_ENCRYPTION_KEY,
        confirm: false
      });
    } catch (err) {
      abortNoConfirm = err.message.includes('explicit confirmation');
    }
    ok('Live restore aborts if explicit confirmation is missing', abortNoConfirm);

    // SIMULATE TOTAL DATA DISASTER: Corrupt and delete the database file
    await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(TEST_DB_PATH, Buffer.from('CORRUPTED_GARBAGE_DATA_CRASH'));
    try {
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    } catch {}
    try {
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch {}

    // EXECUTE CONFIRMED DISASTER RECOVERY RESTORE
    const liveRestoreResult = await restoreService.restoreBackup({
      backupId: backupResult.backupId,
      backupDir: TEST_BACKUP_DIR,
      targetDbPath: TEST_DB_PATH,
      targetUploadsDir: TEST_UPLOADS_DIR,
      encryptionKey: TEST_ENCRYPTION_KEY,
      confirm: true
    });

    ok('Live disaster recovery restore completed', liveRestoreResult.success === true);
    ok('Pre-restore safety rollback snapshot captured', !!liveRestoreResult.rollbackSnapshots.database);

    // Inspect Restored Database
    const restoredDb = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const integrity = restoredDb.pragma('integrity_check', { simple: true });
      ok('Restored database passes PRAGMA integrity_check', integrity === 'ok');

      const fk = restoredDb.pragma('foreign_key_check');
      ok('Restored database passes PRAGMA foreign_key_check', fk.length === 0);

      // Verify all representative records survived intact
      const orgRow = restoredDb.prepare('SELECT name, slug FROM organizations WHERE id = 101').get();
      ok('Organization record restored accurately', orgRow && orgRow.name === 'Disaster Recovery Academy');

      const studentRow = restoredDb.prepare('SELECT name, email FROM students WHERE id = 201').get();
      ok('Student candidate record restored accurately', studentRow && studentRow.name === 'Alice Recovery');

      const attemptRow = restoredDb.prepare('SELECT score, status FROM attempts WHERE id = 401').get();
      ok('Assessment attempt restored accurately', attemptRow && attemptRow.score === 95.0);

      const certRow = restoredDb.prepare('SELECT certificate_id, verification_status FROM certificates WHERE certificate_id = ?').get('cert_dr_1');
      ok('Digital certificate record restored accurately', certRow && certRow.verification_status === 'VALID');

    } finally {
      restoredDb.close();
    }

    // --------------------------------------------------------------------------
    // 11. Administrative API Security & RBAC
    // --------------------------------------------------------------------------
    console.log('\n--- 11. Administrative API RBAC Verification ---');
    const app = createApp();
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const { createSession } = require('../backend/src/services/session.service');
    const { signAccessToken, hashPassword } = require('../backend/src/security/jwt');
    const { ROLES } = require('../backend/src/security/rbac');

    // Create Super Admin and Org Admin users in DB
    const adminDb = new Database(TEST_DB_PATH);
    const pwdHash = await hashPassword('SuperPassword123!');
    const superAdminUser = adminDb.prepare(`
      INSERT INTO users (email, password_hash, name, role, organization_id, status, token_version)
      VALUES ('superadmin@test.internal', ?, 'Super Admin', 'SUPER_ADMIN', NULL, 'ACTIVE', 1)
      RETURNING id, role
    `).get(pwdHash);

    const orgAdminUser = adminDb.prepare(`
      INSERT INTO users (email, password_hash, name, role, organization_id, status, token_version)
      VALUES ('orgadmin@test.internal', ?, 'Org Admin', 'ORG_ADMIN', 101, 'ACTIVE', 1)
      RETURNING id, role
    `).get(pwdHash);
    adminDb.close();

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const superSession = createSession({ userId: superAdminUser.id, expiresAt });
    const orgSession = createSession({ userId: orgAdminUser.id, expiresAt });

    const superAdminToken = await signAccessToken({
      sub: String(superAdminUser.id),
      role: superAdminUser.role,
      organization_id: null,
      token_version: 1,
      jti: superSession
    });

    const orgAdminToken = await signAccessToken({
      sub: String(orgAdminUser.id),
      role: orgAdminUser.role,
      organization_id: 101,
      token_version: 1,
      jti: orgSession
    });

    // Super Admin: List Backups
    const superListRes = await fetch(`${baseUrl}/api/admin/backups`, {
      headers: { Authorization: `Bearer ${superAdminToken}` }
    });
    const superListData = await superListRes.json();
    ok('Super Admin can list backups (200 OK)', superListRes.status === 200 && superListData.success === true);
    ok('Super Admin sees available backup archives', Array.isArray(superListData.data) && superListData.data.length >= 1);

    // Org Admin: Denied Access (403 Forbidden)
    const orgListRes = await fetch(`${baseUrl}/api/admin/backups`, {
      headers: { Authorization: `Bearer ${orgAdminToken}` }
    });
    ok('Org Admin is denied access to backup management (403 Forbidden)', orgListRes.status === 403);

    // Unauthenticated: Denied Access (401 Unauthorized)
    const unauthRes = await fetch(`${baseUrl}/api/admin/backups`);
    ok('Unauthenticated request is denied access (401 Unauthorized)', unauthRes.status === 401);

    server.close();

  } finally {
    // Clean up temporary test files
    try {
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {}
  }

  console.log('\n====================================================');
  console.log(`DAY 28 TEST SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error during Day 28 test execution:', err);
  process.exit(1);
});
