// Public student API: register -> attempt -> submit -> certificate.
const express = require('express');
const crypto = require('crypto');
const { db, getConfig } = require('../db');
const judge0 = require('../services/judge0');
const { generateCertificate } = require('../services/certificate');

const router = express.Router();

/* ---------------- helpers ---------------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normalize Indian mobile numbers to 10 digits. Returns null if invalid.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return d;
}

const randHex = (n) => crypto.randomBytes(n).toString('hex');
const randAlnum = (n) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
};

function tierFor(percentage, slabsJson) {
  let slabs;
  try {
    slabs = JSON.parse(slabsJson);
    if (!Array.isArray(slabs) || slabs.length === 0) throw new Error('bad slabs');
  } catch {
    slabs = [{ min: 90, scholarship: 100 }, { min: 75, scholarship: 50 }, { min: 60, scholarship: 25 }, { min: 40, scholarship: 10 }, { min: 0, scholarship: 0 }];
  }
  const sorted = slabs.slice().sort((a, b) => b.min - a.min);
  for (const s of sorted) {
    if (percentage >= s.min) return s.scholarship;
  }
  return 0;
}

function resultSummary(att, studentName) {
  return {
    status: att.status,
    score: att.score,
    total_marks: att.total_marks,
    percentage: att.percentage,
    scholarship_pct: att.scholarship_pct,
    certificate_id: att.certificate_id,
    claim_code: att.claim_code,
    was_late: !!att.was_late,
    tab_switches: att.tab_switches,
    submitted_at: att.submitted_at,
    student_name: studentName || undefined
  };
}

// Read per-category quotas from config (integers >= 0).
function readQuotas(cfg) {
  const q = (k) => Math.max(0, parseInt(cfg[k], 10) || 0);
  return {
    aptitude: q('quota_aptitude'),
    technical: q('quota_technical'),
    coding: q('quota_coding')
  };
}

// Build the question set for a new attempt: up to quota questions from each
// category (random subset per category, then interleaved by shuffling the
// whole set). Never includes correct answers / test cases.
// Category <-> type mapping is strict: aptitude/technical are MCQ, coding is
// code-writing. Coding questions are excluded entirely when Judge0 is not
// configured, so the test still runs (shorter) with zero human intervention.
function buildAttemptQuestions() {
  const cfg = getConfig();
  const quotas = readQuotas(cfg);
  const codeAllowed = judge0.isConfigured();

  const plan = [
    { category: 'aptitude', type: 'mcq', n: quotas.aptitude },
    { category: 'technical', type: 'mcq', n: quotas.technical }
  ];
  if (codeAllowed && quotas.coding > 0) {
    plan.push({ category: 'coding', type: 'code', n: quotas.coding });
  }

  const selected = [];
  for (const p of plan) {
    if (p.n <= 0) continue;
    const pool = db.prepare('SELECT id FROM questions WHERE category = ? AND type = ?')
      .all(p.category, p.type).map((r) => r.id);
    const ids = cfg.shuffle_questions !== '0' ? shuffle(pool) : pool.slice();
    selected.push(...ids.slice(0, Math.min(p.n, ids.length)));
  }
  if (selected.length === 0) throw new Error('Question bank is empty — add questions via the admin panel');

  // Interleave categories so the test feels mixed.
  const ordered = cfg.shuffle_questions !== '0' ? shuffle(selected) : selected;

  const doShuffleO = cfg.shuffle_options !== '0';
  const maps = {};
  if (ordered.length) {
    const qs = db.prepare(`SELECT id, type, options_json FROM questions WHERE id IN (${ordered.map(() => '?').join(',')})`).all(...ordered);
    for (const q of qs) {
      if (q.type === 'mcq') {
        const opts = JSON.parse(q.options_json || '[]');
        const idx = opts.map((_, i) => i);
        maps[q.id] = doShuffleO ? shuffle(idx) : idx;
      }
    }
  }
  return { selected: ordered, maps };
}

/* ---------------- routes ---------------- */

// Public test metadata (for the instructions page)
router.get('/config/public', (req, res) => {
  const cfg = getConfig();
  const quotas = readQuotas(cfg);
  const codeOn = judge0.isConfigured();
  const qc = codeOn ? quotas.coding : 0;
  const total = quotas.aptitude + quotas.technical + qc;
  res.json({
    test_title: cfg.test_title,
    brand_name: cfg.brand_name,
    accent_color: cfg.accent_color,
    duration_minutes: parseInt(cfg.duration_minutes, 10) || 90,
    question_count: total,
    quotas: { aptitude: quotas.aptitude, technical: quotas.technical, coding: qc },
    breakdown: `${quotas.aptitude} aptitude · ${quotas.technical} technical · ${qc} coding`,
    code_questions_enabled: codeOn,
    coding_disabled_note: codeOn ? null : 'Coding questions are disabled until Judge0 is configured by the administrator.'
  });
});

// Register a student. One attempt per phone number.
router.post('/register', (req, res) => {
  const { name, phone, email, college, city, grad_year, track, campaign_code } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  const normPhone = normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'A valid 10-digit mobile number is required' });

  const student = db.prepare('SELECT * FROM students WHERE phone = ?').get(normPhone);
  if (student) {
    const att = db.prepare('SELECT * FROM attempts WHERE student_id = ? ORDER BY id DESC LIMIT 1').get(student.id);
    if (att) {
      if (att.status === 'submitted' || new Date(att.expires_at).getTime() <= Date.now()) {
        return res.status(409).json({ error: 'ALREADY_ATTEMPTED', message: 'This phone number has already been used for the test. One attempt per student.' });
      }
      // Resume an in-progress attempt
      const cfg = getConfig();
      return res.json({ token: att.token, resumed: true, expires_at: att.expires_at, test_title: cfg.test_title });
    }
  }

  const cfg = getConfig();
  let selected, maps;
  try {
    ({ selected, maps } = buildAttemptQuestions());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const ins = db.prepare(`INSERT INTO students
    (name, phone, email, college, city, grad_year, track, campaign_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const s = ins.run(
    String(name).trim(), normPhone,
    (email || '').trim() || null, (college || '').trim() || null,
    (city || '').trim() || null, (grad_year || '').trim() || null,
    (track || '').trim() || null, (campaign_code || '').trim() || null
  );

  const token = randHex(24);
  const durationMin = parseInt(cfg.duration_minutes, 10) || 30;
  const expires_at = new Date(Date.now() + durationMin * 60000).toISOString();
  db.prepare(`INSERT INTO attempts (token, student_id, expires_at, question_ids_json, shuffle_map_json)
              VALUES (?, ?, ?, ?, ?)`)
    .run(token, s.lastInsertRowid, expires_at, JSON.stringify(selected), JSON.stringify(maps));

  res.json({ token, resumed: false, expires_at, duration_minutes: durationMin, question_count: selected.length, test_title: cfg.test_title });
});

// Fetch attempt + questions (answers and test cases are NEVER sent)
router.get('/attempt/:token', (req, res) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return res.status(404).json({ error: 'Attempt not found' });
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(att.student_id);
  const cfg = getConfig();
  const qids = JSON.parse(att.question_ids_json || '[]');
  const maps = JSON.parse(att.shuffle_map_json || '{}');

  let questions = [];
  if (qids.length) {
    const qs = db.prepare(`SELECT id, type, category, question_text, options_json, marks, code_starter
                           FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`).all(...qids);
    const byId = new Map(qs.map((q) => [q.id, q]));
    questions = qids.map((qid) => {
      const q = byId.get(qid);
      if (!q) return null;
      const out = { id: q.id, type: q.type, category: q.category, question_text: q.question_text, marks: q.marks };
      if (q.type === 'mcq') {
        const opts = JSON.parse(q.options_json || '[]');
        const map = maps[q.id] || opts.map((_, i) => i);
        out.options = map.map((i) => opts[i]);
      } else {
        out.code_starter = q.code_starter || '';
      }
      return out;
    }).filter(Boolean);
  }

  const payload = {
    test_title: cfg.test_title,
    brand_name: cfg.brand_name,
    student_name: student.name,
    status: att.status,
    expires_at: att.expires_at,
    tab_switches: att.tab_switches,
    questions
  };
  if (att.status === 'submitted') Object.assign(payload, resultSummary(att, student.name));
  res.json(payload);
});

// Heartbeat: persist tab-switch count during the test
router.post('/attempt/:token/heartbeat', (req, res) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return res.status(404).json({ error: 'Attempt not found' });
  if (att.status !== 'started') return res.json({ ok: true });
  const n = parseInt(req.body && req.body.tabSwitches, 10);
  if (Number.isFinite(n) && n > att.tab_switches) {
    db.prepare('UPDATE attempts SET tab_switches = ? WHERE id = ?').run(n, att.id);
  }
  res.json({ ok: true });
});

// Submit + grade (idempotent)
router.post('/attempt/:token/submit', async (req, res) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return res.status(404).json({ error: 'Attempt not found' });
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(att.student_id);
  if (att.status === 'submitted') return res.json(resultSummary(att, student.name));

  const body = req.body || {};
  const answers = body.answers || {};
  const codeAnswers = body.codeAnswers || {};
  if (typeof body.tabSwitches === 'number' && body.tabSwitches > att.tab_switches) {
    db.prepare('UPDATE attempts SET tab_switches = ? WHERE id = ?').run(Math.floor(body.tabSwitches), att.id);
  }

  const cfg = getConfig();
  const qids = JSON.parse(att.question_ids_json || '[]');
  const maps = JSON.parse(att.shuffle_map_json || '{}');
  const qmap = new Map();
  if (qids.length) {
    const qs = db.prepare(`SELECT * FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`).all(...qids);
    for (const q of qs) qmap.set(q.id, q);
  }

  let score = 0, total = 0;
  const detail = [];
  for (const qid of qids) {
    const q = qmap.get(qid);
    if (!q) continue;
    total += q.marks;
    let earned = 0;
    if (q.type === 'mcq') {
      const sel = answers[qid] ?? answers[String(qid)];
      if (sel !== undefined && sel !== null && sel !== '') {
        const map = maps[qid] || maps[String(qid)];
        const origIdx = map ? map[Number(sel)] : Number(sel);
        if (origIdx === q.correct_index) earned = q.marks;
      }
      detail.push({ id: q.id, category: q.category, type: 'mcq', marks: q.marks, earned });
    } else {
      const src = (codeAnswers[qid] ?? codeAnswers[String(qid)] ?? '').toString();
      const tcs = JSON.parse(q.test_cases_json || '[]');
      if (src.trim() && judge0.isConfigured() && tcs.length) {
        const g = await judge0.gradeCodeQuestion({ source_code: src, language_id: q.language_id || 71, test_cases: tcs });
        earned = Math.round((q.marks * (g.total ? g.passed / g.total : 0)) * 100) / 100;
        detail.push({ id: q.id, category: q.category, type: 'code', marks: q.marks, earned, passed: g.passed, total: g.total, error: g.error || null });
      } else {
        detail.push({ id: q.id, category: q.category, type: 'code', marks: q.marks, earned: 0, passed: 0, total: tcs.length, error: src.trim() ? 'judge0_unconfigured' : 'no_answer' });
      }
    }
    score += earned;
  }
  score = Math.round(score * 100) / 100;
  const percentage = total > 0 ? Math.round((score / total) * 1000) / 10 : 0;
  const scholarship_pct = tierFor(percentage, cfg.scholarship_slabs);
  const was_late = Date.now() > new Date(att.expires_at).getTime() ? 1 : 0;
  const certificate_id = 'ASP26-' + randHex(4).toUpperCase();
  const claim_code = 'ASP-' + randAlnum(6);

  db.prepare(`UPDATE attempts SET status='submitted', submitted_at=datetime('now'),
    answers_json=?, code_answers_json=?, score=?, total_marks=?, percentage=?,
    scholarship_pct=?, certificate_id=?, claim_code=?, was_late=?, graded_detail_json=?
    WHERE id=?`).run(
    JSON.stringify(answers), JSON.stringify(codeAnswers), score, total, percentage,
    scholarship_pct, certificate_id, claim_code, was_late, JSON.stringify(detail), att.id
  );

  const updated = db.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
  const summary = resultSummary(updated, student.name);
  summary.detail = detail;
  res.json(summary);
});

// Download the branded PDF certificate
router.get('/certificate/:certificateId', async (req, res) => {
  const att = db.prepare(`SELECT a.*, s.name AS student_name FROM attempts a
                          JOIN students s ON s.id = a.student_id
                          WHERE a.certificate_id = ? AND a.status = 'submitted'`).get(req.params.certificateId);
  if (!att) return res.status(404).json({ error: 'Certificate not found' });
  const cfg = getConfig();
  try {
    const pdf = await generateCertificate({
      name: att.student_name,
      percentage: att.percentage,
      scholarshipPct: att.scholarship_pct,
      certificateId: att.certificate_id,
      dateStr: new Date(att.submitted_at + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      brandName: cfg.brand_name || 'Adyapan'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${att.certificate_id}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate certificate' });
  }
});

module.exports = router;
