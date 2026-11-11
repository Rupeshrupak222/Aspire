// ============================================================================
// ASPIRE DAY 22: USAGE METERING — STORAGE TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-storage-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const { getCurrentUsageSnapshot, getStorageFootprint } = require('../backend/src/services/subscription/metering.service');
const { recordUsageEvent } = require('../backend/src/services/subscription/metering.service');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function run() {
  console.log('====================================================');
  console.log('DAY 22: USAGE METERING — STORAGE TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Tenant Alpha Corp', 'alpha-corp', 'ACTIVE'),
             (20, 'Tenant Beta Inc', 'beta-inc', 'ACTIVE')
    `).run();

    // Starter plan: 1GB storage limit
    assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });
    assignSubscription({ organizationId: 20, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    console.log('--- 1. Initial Storage State ---');
    const footprintInit = getStorageFootprint(10);
    ok('Initial storage bytes is 0', footprintInit.totalBytes === 0);
    ok('Initial storage objects is 0', footprintInit.totalObjects === 0);

    console.log('\n--- 2. File Upload Ingestion (Branding Asset) ---');
    const fileSize = 2048576; // 2 MB
    db.prepare(`
      INSERT INTO organization_storage_objects (
        organization_id, storage_key, category, file_name, mime_type, size_bytes, provider
      ) VALUES (
        10, 'organizations/10/branding/logo.png', 'branding', 'logo.png', 'image/png', ?, 'LOCAL'
      )
    `).run(fileSize);

    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'storage_bytes',
      eventType: 'INCREMENT',
      quantity: fileSize,
      idempotencyKey: 'storage_up_logo_1',
      referenceType: 'storage_object',
      referenceId: 'organizations/10/branding/logo.png'
    });
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'storage_objects',
      eventType: 'INCREMENT',
      quantity: 1,
      idempotencyKey: 'storage_obj_logo_1',
      referenceType: 'storage_object',
      referenceId: 'organizations/10/branding/logo.png'
    });

    const footprint1 = getStorageFootprint(10);
    ok('Storage total bytes is 2048576', footprint1.totalBytes === fileSize);
    ok('Storage total megabytes is 1.95 MB', footprint1.totalMegabytes >= 1.9);
    ok('Storage object count is 1', footprint1.totalObjects === 1);
    ok('Branding category has bytes', footprint1.categories.some((c) => c.category === 'branding' && c.bytes === fileSize));

    console.log('\n--- 3. Multi-Tenant Storage Isolation ---');
    // Beta org uploads a 5MB certificate asset
    const betaFileSize = 5242880; // 5 MB
    db.prepare(`
      INSERT INTO organization_storage_objects (
        organization_id, storage_key, category, file_name, mime_type, size_bytes, provider
      ) VALUES (
        20, 'organizations/20/certificates/cert.pdf', 'certificates', 'cert.pdf', 'application/pdf', ?, 'LOCAL'
      )
    `).run(betaFileSize);

    const footprintAlpha = getStorageFootprint(10);
    const footprintBeta = getStorageFootprint(20);

    ok('Alpha storage remains 2048576 bytes', footprintAlpha.totalBytes === fileSize);
    ok('Beta storage is 5242880 bytes', footprintBeta.totalBytes === betaFileSize);
    ok('Alpha has 0 certificate storage', !footprintAlpha.categories.some((c) => c.category === 'certificates'));
    ok('Beta has certificates category', footprintBeta.categories.some((c) => c.category === 'certificates'));

    console.log('\n--- 4. File Deletion and Decrement ---');
    db.prepare(`
      DELETE FROM organization_storage_objects
      WHERE organization_id = 10 AND storage_key = 'organizations/10/branding/logo.png'
    `).run();

    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'storage_bytes',
      eventType: 'DECREMENT',
      quantity: fileSize,
      idempotencyKey: 'storage_del_logo_1',
      referenceType: 'storage_object',
      referenceId: 'organizations/10/branding/logo.png'
    });
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'storage_objects',
      eventType: 'DECREMENT',
      quantity: 1,
      idempotencyKey: 'storage_obj_del_logo_1',
      referenceType: 'storage_object',
      referenceId: 'organizations/10/branding/logo.png'
    });

    const footprintAfterDel = getStorageFootprint(10);
    ok('Alpha storage returns to 0 bytes after file deletion', footprintAfterDel.totalBytes === 0);
    ok('Alpha storage objects returns to 0', footprintAfterDel.totalObjects === 0);

    console.log('\n--- 5. Soft-Limit Warning Detection ---');
    // Starter has 1 GB limit (1073741824 bytes). 80% soft limit = 858993459 bytes
    // Insert 850 MB (891289600 bytes) -> 83% capacity
    const heavyBytes = 891289600;
    db.prepare(`
      INSERT INTO organization_storage_objects (
        organization_id, storage_key, category, file_name, mime_type, size_bytes, provider
      ) VALUES (
        10, 'organizations/10/exports/huge.zip', 'exports', 'huge.zip', 'application/zip', ?, 'LOCAL'
      )
    `).run(heavyBytes);

    const snapAlert = getCurrentUsageSnapshot(10);
    ok('Storage percentage is ~83%', snapAlert.resources.storage.percentage >= 80);
    ok('Soft-limit warning triggered', snapAlert.alerts.softLimitWarning === true);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`STORAGE METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

