// Day 5 — Database Hardening & Persistence Test Suite
// Verifies WAL mode, foreign key enforcement, orphan rejection, check constraints,
// transaction rollback, high-concurrency registration & submission, backup/restore, and health checks.

const path = require('path');
const fs = require('fs');
const http = require('http');

const TEST_DB = path.join(__dirname, 'db-hardening-test.db');
process.env.DB_PATH = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.PORT = '3216';
process.env.AUTH_SECRET = 'day5-db-hardening-test-secret-32-chars-long!';
process.env.RATE_LIMIT_DISABLED = '1';

// Clean test db files if leftover
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB + ext)) fs.unlinkSync(TEST_DB + ext);
}

const Database = require('better-sqlite3');
const { db, DB_PATH, checkDbHealth, getDbStats, closeDatabase } = require('../backend/src/db');
const { runMigrations, getMigrationsStatus } = require('../backend/src/db/migrations');
const { seedIfEmpty } = require('../backend/src/data/seed');
const { performBackup } = require('../backend/src/scripts/backup');
const { performRestore } = require('../backend/src/scripts/restore');
const createApp = require('../backend/src/app');

// Seed test database
seedIfEmpty(db);

let server;
const PORT = 3216;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

async function request(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data };
}

async function run() {
  console.log(`[test-db] Starting Database Hardening tests on port ${PORT}`);
  const app = createApp();

  await new Promise((resolve, reject) => {
    server = app.listen(PORT, resolve);
    server.on('error', reject);
  });

  // Wait for server health
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    /* ----------------------------------------------------
       1. Database Connection, PRAGMAs & WAL Mode
    ---------------------------------------------------- */
    console.log('\n--- 1. Database Connection, PRAGMAs & WAL Mode ---');
    const jm = db.pragma('journal_mode', { simple: true });
    assert(jm.toLowerCase() === 'wal', `journal_mode is WAL (got: ${jm})`);

    const fk = db.pragma('foreign_keys', { simple: true });
    assert(fk === 1, `foreign_keys enforcement is ON (got: ${fk})`);

    const busy = db.pragma('busy_timeout', { simple: true });
    assert(busy >= 5000, `busy_timeout is configured >= 5000ms (got: ${busy})`);

    const sync = db.pragma('synchronous', { simple: true });
    assert(sync === 1, `synchronous mode is NORMAL (1) for WAL efficiency (got: ${sync})`);

    const health = checkDbHealth(db);
    assert(health.healthy === true, 'checkDbHealth returns healthy=true');
    assert(health.foreignKeys === true, 'checkDbHealth confirms foreignKeys=true');
    assert(health.latestMigration.startsWith('00'), `checkDbHealth identifies latest migration (got: ${health.latestMigration})`);

    /* ----------------------------------------------------
       2. Foreign Key Enforcement & Cascade Behaviors
    ---------------------------------------------------- */
    console.log('\n--- 2. Foreign Key Enforcement & Cascade Behaviors ---');

    // 2.1 Orphan Attempt: referencing non-existent student must be rejected
    let orphanAttemptFailed = false;
    try {
      db.prepare(`
        INSERT INTO attempts (token, student_id, expires_at, question_ids_json)
        VALUES ('orphan_test_token_99999', 999999, datetime('now', '+1 hour'), '[]')
      `).run();
    } catch (err) {
      orphanAttemptFailed = err.message.includes('FOREIGN KEY constraint failed');
    }
    assert(orphanAttemptFailed, 'Inserting attempt with non-existent student_id rejected by foreign key');

    // 2.2 Orphan Session: referencing non-existent user must be rejected
    let orphanSessionFailed = false;
    try {
      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at)
        VALUES ('orphan_session_id', 888888, 'hash123', datetime('now', '+1 day'))
      `).run();
    } catch (err) {
      orphanSessionFailed = err.message.includes('FOREIGN KEY constraint failed');
    }
    assert(orphanSessionFailed, 'Inserting session with non-existent user_id rejected by foreign key');

    // 2.3 Cascade deletion: deleting student removes their attempts
    const testPhone = '9999990001';
    db.prepare(`INSERT INTO students (name, phone) VALUES ('FK Cascade Student', ?)`).run(testPhone);
    const studentRow = db.prepare('SELECT id FROM students WHERE phone = ?').get(testPhone);
    const testToken = 'cascade_test_token_11111';
    db.prepare(`
      INSERT INTO attempts (token, student_id, expires_at, question_ids_json)
      VALUES (?, ?, datetime('now', '+1 hour'), '[]')
    `).run(testToken, studentRow.id);

    const attBefore = db.prepare('SELECT * FROM attempts WHERE token = ?').get(testToken);
    assert(!!attBefore, 'Attempt created successfully before cascade test');

    db.prepare('DELETE FROM students WHERE id = ?').run(studentRow.id);
    const attAfter = db.prepare('SELECT * FROM attempts WHERE token = ?').get(testToken);
    assert(attAfter === undefined, 'Student deletion automatically cascaded to attempts (ON DELETE CASCADE)');

    // 2.4 Set Null behavior: deleting organization nulls organization_id on user
    const orgRes = db.prepare(`INSERT INTO organizations (name, slug) VALUES ('Temp Org', 'temp-org-fk')`).run();
    const tempOrgId = orgRes.lastInsertRowid;
    const userRes = db.prepare(`
      INSERT INTO users (email, password_hash, name, role, organization_id)
      VALUES ('temp_org_user@example.com', 'hash', 'Org User', 'ORG_ADMIN', ?)
    `).run(tempOrgId);
    const tempUserId = userRes.lastInsertRowid;

    db.prepare('DELETE FROM organizations WHERE id = ?').run(tempOrgId);
    const userAfterOrgDelete = db.prepare('SELECT organization_id FROM users WHERE id = ?').get(tempUserId);
    assert(userAfterOrgDelete.organization_id === null, 'Organization deletion sets user organization_id to NULL (ON DELETE SET NULL)');
    db.prepare('DELETE FROM users WHERE id = ?').run(tempUserId);

    /* ----------------------------------------------------
       3. CHECK Constraints & Data Integrity
    ---------------------------------------------------- */
    console.log('\n--- 3. CHECK Constraints & Data Integrity ---');

    // 3.1 Invalid user role
    let invalidRoleRejected = false;
    try {
      db.prepare(`
        INSERT INTO users (email, password_hash, name, role)
        VALUES ('invalid_role@example.com', 'hash', 'Bad Role User', 'UNAUTHORIZED_ROLE')
      `).run();
    } catch (err) {
      invalidRoleRejected = err.message.includes('CHECK constraint failed');
    }
    assert(invalidRoleRejected, 'Inserting user with invalid role rejected by CHECK constraint');

    // 3.2 Invalid question type
    let invalidTypeRejected = false;
    try {
      db.prepare(`
        INSERT INTO questions (type, question_text)
        VALUES ('essay', 'Write an essay')
      `).run();
    } catch (err) {
      invalidTypeRejected = err.message.includes('CHECK constraint failed');
    }
    assert(invalidTypeRejected, 'Inserting question with invalid type rejected by CHECK constraint');

    // 3.3 Invalid organization status
    let invalidOrgStatusRejected = false;
    try {
      db.prepare(`
        INSERT INTO organizations (name, slug, status)
        VALUES ('Invalid Org', 'invalid-org', 'BANNED')
      `).run();
    } catch (err) {
      invalidOrgStatusRejected = err.message.includes('CHECK constraint failed');
    }
    assert(invalidOrgStatusRejected, 'Inserting organization with invalid status rejected by CHECK constraint');

    /* ----------------------------------------------------
       4. Transaction Atomicity & Controlled Rollback
    ---------------------------------------------------- */
    console.log('\n--- 4. Transaction Atomicity & Controlled Rollback ---');

    const rollbackPhone = '9888880001';
    let txThrew = false;

    const atomicOperation = db.transaction(() => {
      // Step 1: Insert student
      db.prepare(`INSERT INTO students (name, phone) VALUES ('Rollback Test', ?)`).run(rollbackPhone);
      // Step 2: Intentionally fail step 2
      throw new Error('Controlled transaction simulation failure');
    });

    try {
      atomicOperation();
    } catch (e) {
      txThrew = true;
    }

    assert(txThrew, 'Transaction threw expected error');
    const rolledBackStudent = db.prepare('SELECT * FROM students WHERE phone = ?').get(rollbackPhone);
    assert(rolledBackStudent === undefined, 'No partial records exist after failed transaction (atomicity guaranteed)');

    /* ----------------------------------------------------
       5. High Concurrency Testing: Registrations
    ---------------------------------------------------- */
    console.log('\n--- 5. High Concurrency: Registrations ---');

    const concurrentPhone = '9123456789';
    // Clean existing test candidate if any
    const existing = db.prepare('SELECT id FROM students WHERE phone = ?').get(concurrentPhone);
    if (existing) {
      db.prepare('DELETE FROM attempts WHERE student_id = ?').run(existing.id);
      db.prepare('DELETE FROM students WHERE id = ?').run(existing.id);
    }

    // Launch 5 parallel registration requests with identical phone simultaneously
    const regPromises = Array.from({ length: 5 }, () =>
      request('/api/register', {
        method: 'POST',
        body: {
          name: 'Concurrent Candidate',
          phone: concurrentPhone,
          email: 'concurrent@example.com'
        }
      })
    );

    const regResults = await Promise.all(regPromises);
    const newRegistrations = regResults.filter((r) => r.status === 200 && r.data && r.data.token && r.data.resumed === false);
    const resumedOrRejected = regResults.filter((r) => (r.status === 200 && r.data && r.data.resumed === true) || (r.status === 409 && r.data && r.data.code === 'ALREADY_ATTEMPTED'));

    assert(newRegistrations.length === 1, `Exactly 1 new attempt registered (got: ${newRegistrations.length})`);
    assert(resumedOrRejected.length === 4, `Remaining 4 requests safely resumed existing attempt or rejected (got: ${resumedOrRejected.length})`);

    const studentCount = db.prepare('SELECT COUNT(*) AS c FROM students WHERE phone = ?').get(concurrentPhone).c;
    assert(studentCount === 1, `Exactly 1 student row created in database (got: ${studentCount})`);

    /* ----------------------------------------------------
       6. High Concurrency Testing: Submissions & Optimistic Lock
    ---------------------------------------------------- */
    console.log('\n--- 6. High Concurrency: Submissions & Optimistic Lock ---');

    const regToken = newRegistrations[0].data.token;
    assert(!!regToken, 'Valid attempt token obtained from concurrent registration test');

    // Launch 5 parallel submit requests for the EXACT same attempt token simultaneously
    const subPromises = Array.from({ length: 5 }, () =>
      request(`/api/attempt/${regToken}/submit`, {
        method: 'POST',
        body: {
          answers: { '1': 0, '2': 1 },
          codeAnswers: {},
          tabSwitches: 1
        }
      })
    );

    const subResults = await Promise.all(subPromises);
    // All requests should return HTTP 200, but only ONE grading execution should have created the certificate
    const all200 = subResults.every((r) => r.status === 200);
    assert(all200, 'All concurrent submissions completed safely with HTTP 200');

    // Verify database state: exactly 1 attempt record, status 'submitted', exactly 1 certificate
    const attState = db.prepare('SELECT * FROM attempts WHERE token = ?').get(regToken);
    assert(attState.status === 'submitted', 'Attempt transitioned to submitted state');
    assert(!!attState.certificate_id, `Certificate generated: ${attState.certificate_id}`);
    assert(!!attState.claim_code, `Claim code generated: ${attState.claim_code}`);

    // Verify all 5 responses returned the identical certificate_id (no double-minting or divergence)
    const certIds = new Set(subResults.map((r) => r.data && r.data.certificate_id).filter(Boolean));
    assert(certIds.size === 1, `All concurrent responses share the exact same certificate ID (got ${certIds.size} unique)`);

    // 6.1 Verify re-registration of completed attempt is safely rejected with 409 ALREADY_ATTEMPTED
    const duplicateSubmittedReg = await request('/api/register', {
      method: 'POST',
      body: {
        name: 'Concurrent Candidate',
        phone: concurrentPhone,
        email: 'concurrent@example.com'
      }
    });
    assert(duplicateSubmittedReg.status === 409, 'Re-registration of completed attempt rejected with 409 Conflict');
    assert(duplicateSubmittedReg.data && duplicateSubmittedReg.data.code === 'ALREADY_ATTEMPTED', 'Conflict error code is ALREADY_ATTEMPTED');

    /* ----------------------------------------------------
       7. Database Health Check Endpoints
    ---------------------------------------------------- */
    console.log('\n--- 7. Database Health Check Endpoints ---');

    const healthRes = await request('/api/health');
    assert(healthRes.status === 200, 'GET /api/health returns 200');
    assert(healthRes.data.success === true, 'Health check returns success: true');
    assert(healthRes.data.data.database === 'ok', 'Health check reports database: "ok"');
    assert(healthRes.data.data.status === 'UP', 'Health check reports status: "UP"');

    const dbHealthRes = await request('/api/health/db');
    assert(dbHealthRes.status === 200, 'GET /api/health/db returns 200');
    assert(dbHealthRes.data.data.database === 'ok', '/api/health/db reports database: "ok"');

    // 7.1 Verify database file and backup directory cannot be downloaded via HTTP
    const dbFileRes = await request('/aspire.db');
    assert(dbFileRes.status === 404, 'Direct request for /aspire.db returns 404 (database file inaccessible)');

    const dataDbRes = await request('/data/aspire.db');
    assert(dataDbRes.status === 404, 'Direct request for /data/aspire.db returns 404');

    const backupDirRes = await request('/backups/aspire-latest.sqlite');
    assert(backupDirRes.status === 404, 'Direct request for /backups returns 404 (backup directory inaccessible)');

    /* ----------------------------------------------------
       8. Backup, Verification & Restore
    ---------------------------------------------------- */
    console.log('\n--- 8. Backup, Verification & Restore ---');

    const backupDir = path.join(__dirname, 'test-backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Capture original stats before backup
    const originalStats = getDbStats(db);

    // 8.1 Execute SQLite online backup
    const backupRes = await performBackup({
      db,
      dbPath: TEST_DB,
      backupDir,
      retentionCount: 3
    });

    assert(backupRes.success === true, 'Backup executed successfully');
    assert(fs.existsSync(backupRes.filePath), 'Backup file exists on disk');
    assert(backupRes.sizeBytes > 0, `Backup file size is positive (${backupRes.sizeBytes} bytes)`);

    // 8.2 Verify backup integrity
    const testVerifyDb = new Database(backupRes.filePath, { readonly: true });
    const checkResult = testVerifyDb.pragma('integrity_check', { simple: true });
    testVerifyDb.close();
    assert(checkResult === 'ok', `Backup passed PRAGMA integrity_check (result: ${checkResult})`);

    // 8.3 Restore into a disposable database
    const restoredDbPath = path.join(__dirname, 'test-restored.db');
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(restoredDbPath + ext)) fs.unlinkSync(restoredDbPath + ext);
    }

    const restoreRes = await performRestore({
      backupFile: backupRes.filePath,
      targetDbPath: restoredDbPath,
      backupDir
    });

    assert(restoreRes.success === true, 'Restore executed successfully');
    assert(fs.existsSync(restoredDbPath), 'Restored database file exists');

    // 8.4 Verify restored database data matches original
    const restoredDb = new Database(restoredDbPath);
    restoredDb.pragma('foreign_keys = ON');
    const restoredStudent = restoredDb.prepare('SELECT * FROM students WHERE phone = ?').get(concurrentPhone);
    assert(!!restoredStudent, 'Restored database contains registered candidate');

    const restoredAttempt = restoredDb.prepare('SELECT * FROM attempts WHERE token = ?').get(regToken);
    assert(restoredAttempt && restoredAttempt.status === 'submitted', 'Restored database contains submitted attempt');
    assert(restoredAttempt.certificate_id === attState.certificate_id, 'Restored attempt matches original certificate ID');

    const restoredStats = getDbStats(restoredDb);
    assert(restoredStats.questions === originalStats.questions, `Questions count matches (${restoredStats.questions})`);
    assert(restoredStats.students === originalStats.students, `Students count matches (${restoredStats.students})`);
    assert(restoredStats.attempts === originalStats.attempts, `Attempts count matches (${restoredStats.attempts})`);

    restoredDb.close();

    // Clean restored db and test backups
    for (const ext of ['', '-wal', '-shm', '.pre-restore*']) {
      try {
        fs.unlinkSync(restoredDbPath + ext);
      } catch {}
    }
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {}

    /* ----------------------------------------------------
       9. Summary & Teardown
    ---------------------------------------------------- */
    console.log(`\n[test-db] Results: ${passed} PASSED, ${failed} FAILED`);
  } finally {
    if (server) {
      await new Promise((r) => server.close(r));
    }
    closeDatabase();
    // Cleanup test db
    for (const ext of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(TEST_DB + ext)) fs.unlinkSync(TEST_DB + ext);
      } catch {}
    }
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('[test-db] Unexpected test runner error:', err);
  if (server) server.close();
  process.exit(1);
});
