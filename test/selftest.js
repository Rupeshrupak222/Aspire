// Self-test: boots the server on a temp DB and walks the whole product flow.
// Run: npm test   (exit 0 = all green)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const os = require('os');
const PORT = 3210;
const DB = path.join(os.tmpdir(), 'aspire-selftest.db');
const ADMIN_EMAIL = 'selftest-admin@adyapan.internal';
const ADMIN_PASSWORD = 'SelfTestPassword123!';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name} ${extra}`); }
}
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const body = await r.text();
  let data = {};
  try { data = JSON.parse(body); } catch { data = { _raw: body }; }
  return { status: r.status, data, raw: body, headers: r.headers };
}
let adminH = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await wait(500);
  }
  return false;
}

async function main() {
  try { fs.unlinkSync(DB); } catch {}
  try { fs.unlinkSync(DB + '-wal'); } catch {}
  try { fs.unlinkSync(DB + '-shm'); } catch {}

  console.log('[selftest] starting server…');
  const proc = spawn('node', ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      AUTH_SECRET: 'selftest-auth-secret-32-chars-long!',
      INITIAL_ADMIN_EMAIL: ADMIN_EMAIL,
      INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD
    }
  });
  proc.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  proc.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));

  if (!await waitForServer(proc)) { console.log('FAIL: server did not start'); proc.kill(); process.exit(1); }

  console.log('\n[1] Public config (40-question structure, Judge0 off -> 35)');
  {
    const { status, data } = await api('/api/config/public');
    ok('GET /api/config/public 200', status === 200);
    ok('default duration 90 minutes', data.duration_minutes === 90, `got ${data.duration_minutes}`);
    ok('quotas exposed (10/25)', data.quotas && data.quotas.aptitude === 10 && data.quotas.technical === 25, JSON.stringify(data.quotas));
    ok('coding quota 0 without Judge0', data.quotas && data.quotas.coding === 0);
    ok('question_count = 35 without Judge0', data.question_count === 35, `got ${data.question_count}`);
    ok('breakdown string present', typeof data.breakdown === 'string' && data.breakdown.includes('aptitude'), data.breakdown);
    ok('code questions disabled without Judge0', data.code_questions_enabled === false);
    ok('coding disabled note present', typeof data.coding_disabled_note === 'string');
  }

  console.log('\n[2] Registration + one-attempt rule');
  const alice = { name: 'Alice Tester', phone: '9876543210', email: 'alice@example.com', college: 'Test College', city: 'Hyderabad', grad_year: '2026', track: 'AI / Data', campaign_code: 'SELFTEST' };
  let tokenA;
  {
    const { status, data } = await api('/api/register', { method: 'POST', body: JSON.stringify(alice) });
    ok('register 200', status === 200, JSON.stringify(data));
    tokenA = data.token;
    ok('token issued', typeof tokenA === 'string' && tokenA.length > 16);
    // invalid phone
    const bad = await api('/api/register', { method: 'POST', body: JSON.stringify({ ...alice, phone: '123' }) });
    ok('invalid phone rejected (400)', bad.status === 400);
    // resume in-progress attempt
    const re = await api('/api/register', { method: 'POST', body: JSON.stringify(alice) });
    ok('re-register resumes same token', re.status === 200 && re.data.token === tokenA && re.data.resumed === true);
  }

  console.log('\n[3] Attempt payload (no answer leakage)');
  let questions;
  {
    const { status, data } = await api(`/api/attempt/${tokenA}`);
    ok('GET attempt 200', status === 200);
    questions = data.questions;
    ok('question count = 35 (10+25, coding excluded)', questions.length === 35, `got ${questions.length}`);
    const catCount = {};
    for (const q of questions) catCount[q.category] = (catCount[q.category] || 0) + 1;
    ok('10 aptitude questions', catCount.aptitude === 10, JSON.stringify(catCount));
    ok('25 technical questions', catCount.technical === 25, JSON.stringify(catCount));
    ok('0 coding questions without Judge0', !catCount.coding, JSON.stringify(catCount));
    ok('no correct_index leaked', !JSON.stringify(data).includes('correct_index'));
    ok('no test_cases leaked', !JSON.stringify(data).includes('test_cases'));
    ok('no code questions without Judge0', questions.every((q) => q.type === 'mcq'));
    ok('options present', questions.every((q) => Array.isArray(q.options) && q.options.length >= 2));
  }

  console.log('\n[4] Submit all-correct -> 100% + 100% scholarship (via shuffle map from DB)');
  {
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: true });
    const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(tokenA);
    const maps = JSON.parse(att.shuffle_map_json);
    const qrows = db.prepare('SELECT id, correct_index FROM questions').all();
    const correctById = Object.fromEntries(qrows.map((r) => [r.id, r.correct_index]));
    const answers = {};
    for (const q of questions) {
      const map = maps[q.id] || maps[String(q.id)];
      const shuffledIdx = map.indexOf(correctById[q.id]);
      answers[q.id] = shuffledIdx;
    }
    db.close();
    ok('shuffle maps resolve for every question', Object.values(answers).every((v) => v >= 0));
    const hb = await api(`/api/attempt/${tokenA}/heartbeat`, { method: 'POST', body: JSON.stringify({ tabSwitches: 2 }) });
    ok('heartbeat recorded', hb.status === 200);
    const { status, data } = await api(`/api/attempt/${tokenA}/submit`, {
      method: 'POST', body: JSON.stringify({ answers, tabSwitches: 2 })
    });
    ok('submit 200', status === 200, JSON.stringify(data).slice(0, 200));
    ok('score 35/35', data.score === 35 && data.total_marks === 35, `score=${data.score}`);
    ok('percentage 100', data.percentage === 100);
    ok('scholarship 100%', data.scholarship_pct === 100);
    ok('certificate_id + claim_code issued', !!data.certificate_id && !!data.claim_code);
    ok('tab switches persisted', data.tab_switches === 2);
    // idempotent re-submit
    const again = await api(`/api/attempt/${tokenA}/submit`, { method: 'POST', body: JSON.stringify({ answers: {} }) });
    ok('re-submit returns same result (idempotent)', again.status === 200 && again.data.certificate_id === data.certificate_id);
    // one-attempt enforcement
    const dup = await api('/api/register', { method: 'POST', body: JSON.stringify(alice) });
    ok('second registration blocked (409)', dup.status === 409 && dup.data.error === 'ALREADY_ATTEMPTED');
    // certificate PDF
    const cres = await fetch(`${BASE}/api/certificate/${data.certificate_id}`);
    const buf = Buffer.from(await cres.arrayBuffer());
    ok('certificate downloads', cres.status === 200);
    ok('certificate is a PDF', buf.slice(0, 4).toString() === '%PDF', buf.slice(0, 4).toString());
    ok('certificate content-type pdf', (cres.headers.get('content-type') || '').includes('pdf'));
  }

  console.log('\n[5] All-wrong submit -> 0% + participation certificate');
  {
    const bob = { ...alice, name: 'Bob Wrong', phone: '9123456789', college: 'Other College' };
    const { data: reg } = await api('/api/register', { method: 'POST', body: JSON.stringify(bob) });
    const { data: att } = await api(`/api/attempt/${reg.token}`);
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: true });
    const row = db.prepare('SELECT shuffle_map_json FROM attempts WHERE token = ?').get(reg.token);
    const maps = JSON.parse(row.shuffle_map_json);
    const qrows = db.prepare('SELECT id, correct_index FROM questions').all();
    const correctById = Object.fromEntries(qrows.map((r) => [r.id, r.correct_index]));
    const answers = {};
    for (const q of att.questions) {
      const map = maps[q.id] || maps[String(q.id)];
      const correctShuffled = map.indexOf(correctById[q.id]);
      answers[q.id] = (correctShuffled + 1) % q.options.length; // deliberately wrong
    }
    db.close();
    const { data } = await api(`/api/attempt/${reg.token}/submit`, { method: 'POST', body: JSON.stringify({ answers }) });
    ok('score 0', data.score === 0, `score=${data.score}`);
    ok('scholarship 0%', data.scholarship_pct === 0);
    ok('still gets certificate id', !!data.certificate_id);
  }

  console.log('\n[6] Timer expiry -> was_late but still graded');
  {
    const carol = { ...alice, name: 'Carol Late', phone: '9988776655' };
    const { data: reg } = await api('/api/register', { method: 'POST', body: JSON.stringify(carol) });
    const Database = require('better-sqlite3');
    const db = new Database(DB);
    db.prepare('UPDATE attempts SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 60000).toISOString(), reg.token);
    db.close();
    const { data } = await api(`/api/attempt/${reg.token}/submit`, { method: 'POST', body: JSON.stringify({ answers: {} }) });
    ok('late submit graded', data.status === 'submitted');
    ok('was_late flagged', data.was_late === true);
  }

  console.log('\n[7] Admin: auth + question CRUD');
  {
    const noAuth = await api('/api/admin/questions');
    ok('admin without token -> 401', noAuth.status === 401);

    // Verify old admin token fails
    const oldAuth = await api('/api/admin/questions', { headers: { 'x-admin-token': 'old-admin-token' } });
    ok('admin with old admin token -> 401', oldAuth.status === 401);

    // Login to obtain proper Bearer token
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    });
    ok('admin login 200', login.status === 200 && !!login.data.data.token);
    adminH = { 'Authorization': `Bearer ${login.data.data.token}` };

    const list = await api('/api/admin/questions', { headers: adminH });
    ok('admin list 200', list.status === 200);
    ok('53 seeded sample questions', list.data.length === 53, `got ${list.data.length}`);
    const seedCats = { aptitude: 0, technical: 0, coding: 0 };
    for (const q of list.data) if (seedCats[q.category] !== undefined) seedCats[q.category]++;
    ok('seed category split 15/30/8', seedCats.aptitude === 15 && seedCats.technical === 30 && seedCats.coding === 8, JSON.stringify(seedCats));
    ok('seed has 8 code questions', list.data.filter((q) => q.type === 'code').length === 8);
    // create
    const created = await api('/api/admin/questions', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'Selftest Q: 1+1?', options: ['1', '2', '3'], correct_index: 1, marks: 1 })
    });
    ok('create 201', created.status === 201 && created.data.id);
    const qid = created.data.id;
    // invalid create rejected
    const badCreate = await api('/api/admin/questions', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ type: 'mcq', question_text: 'bad', options: ['only-one'], correct_index: 5 })
    });
    ok('invalid question rejected (400)', badCreate.status === 400);
    // category validation
    const badCat = await api('/api/admin/questions', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ type: 'mcq', category: 'bogus', question_text: 'x', options: ['a', 'b'], correct_index: 0 })
    });
    ok('invalid category rejected (400)', badCat.status === 400);
    const mismatch = await api('/api/admin/questions', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ type: 'mcq', category: 'coding', question_text: 'x', options: ['a', 'b'], correct_index: 0 })
    });
    ok('coding-category as mcq rejected (400)', mismatch.status === 400);
    const mismatch2 = await api('/api/admin/questions', {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ type: 'code', category: 'technical', question_text: 'x', test_cases: [{ input: '1', expected: '1' }] })
    });
    ok('technical-category as code rejected (400)', mismatch2.status === 400);
    // update
    const upd = await api(`/api/admin/questions/${qid}`, {
      method: 'PUT', headers: adminH, body: JSON.stringify({ question_text: 'Selftest Q: 2+2?', options: ['3', '4', '5'], correct_index: 1 })
    });
    ok('update 200', upd.status === 200);
    // delete
    const del = await api(`/api/admin/questions/${qid}`, { method: 'DELETE', headers: adminH });
    ok('delete 200', del.status === 200);
    const after = await api('/api/admin/questions', { headers: adminH });
    ok('back to 53 questions', after.data.length === 53);
    // judge0 status
    const j = await api('/api/admin/judge0-status', { headers: adminH });
    ok('judge0 reports disabled', j.data.configured === false);
  }

  console.log('\n[8] Admin: config + results + CSV + college report');
  {
    const cfg = await api('/api/admin/config', { headers: adminH });
    ok('config readable', cfg.status === 200 && cfg.data.duration_minutes);
    const upd = await api('/api/admin/config', {
      method: 'PUT', headers: adminH,
      body: JSON.stringify({ duration_minutes: '45', bogus_key: 'x' })
    });
    ok('unknown config key rejected', upd.status === 400);
    const upd2 = await api('/api/admin/config', { method: 'PUT', headers: adminH, body: JSON.stringify({ duration_minutes: '45' }) });
    ok('config update ok', upd2.status === 200 && upd2.data.duration_minutes === '45');
    await api('/api/admin/config', { method: 'PUT', headers: adminH, body: JSON.stringify({ duration_minutes: '90' }) });

    const res = await api('/api/admin/results?college=Test%20College', { headers: adminH });
    ok('results filter by college', res.status === 200 && res.data.length === 2 &&
      res.data.some((r) => r.name === 'Alice Tester') && res.data.some((r) => r.name === 'Carol Late'));

    const csvRes = await fetch(`${BASE}/api/admin/results.csv`, { headers: adminH });
    const csv = await csvRes.text();
    const lines = csv.trim().split('\n');
    ok('CSV downloads', csvRes.status === 200);
    ok('CSV has header + 3 rows', lines.length === 4, `lines=${lines.length}`);
    ok('CSV header correct', lines[0].startsWith('attempt_id,name,phone'));

    const rep = await api('/api/admin/report/college?college=Test%20College', { headers: adminH });
    ok('college report ok', rep.status === 200 && rep.data.submitted === 2 && rep.data.avg_percentage === 50);
    ok('report has category averages', rep.data.category_avg && Object.keys(rep.data.category_avg).length > 0);
    ok('report top10 ordered (best first)', Array.isArray(rep.data.top10) && rep.data.top10.length === 2 && rep.data.top10[0].name === 'Alice Tester');

    // per-category quotas drive test assembly
    await api('/api/admin/config', { method: 'PUT', headers: adminH, body: JSON.stringify({ quota_aptitude: '3', quota_technical: '4' }) });
    const dave = { ...alice, name: 'Dave Quota', phone: '9000000001' };
    const dq = await api('/api/register', { method: 'POST', body: JSON.stringify(dave) });
    ok('register with custom quotas 200', dq.status === 200 && dq.data.question_count === 7, JSON.stringify(dq.data));
    const datt = await api(`/api/attempt/${dq.data.token}`);
    ok('custom quotas -> 7 questions served', datt.data.questions.length === 7, `got ${datt.data.questions.length}`);
    const dc = {};
    for (const q of datt.data.questions) dc[q.category] = (dc[q.category] || 0) + 1;
    ok('quota split respected (3 aptitude / 4 technical)', dc.aptitude === 3 && dc.technical === 4, JSON.stringify(dc));
    await api('/api/admin/config', { method: 'PUT', headers: adminH, body: JSON.stringify({ quota_aptitude: '10', quota_technical: '25' }) });
    const cfgBack = await api('/api/admin/config', { headers: adminH });
    ok('quotas restored to 10/25/5', cfgBack.data.quota_aptitude === '10' && cfgBack.data.quota_technical === '25' && cfgBack.data.quota_coding === '5');
  }

  proc.kill();
  console.log(`\n[selftest] ${failures === 0 ? 'ALL GREEN' : failures + ' FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('selftest crashed:', e); process.exit(1); });
