// Admin API. Auth: x-admin-token header or Authorization: Bearer <token>.
const express = require('express');
const { db, getConfig, setConfig } = require('../db');
const judge0 = require('../services/judge0');
const adminAuth = require('../middleware/admin-auth');

const router = express.Router();

router.use(adminAuth);

router.get('/judge0-status', (req, res) => res.json(judge0.status()));

/* ---------- Questions CRUD ---------- */

// Locked categories: aptitude + technical are MCQ, coding is code-writing.
const VALID_CATEGORIES = ['aptitude', 'technical', 'coding'];

function validateQuestion(q, isUpdate = false) {
  const errs = [];
  if (!isUpdate || q.type !== undefined) {
    if (!['mcq', 'code'].includes(q.type)) errs.push('type must be mcq or code');
  }
  if (!isUpdate || q.category !== undefined) {
    if (!VALID_CATEGORIES.includes(q.category)) errs.push('category must be one of: ' + VALID_CATEGORIES.join(', '));
  }
  const type = q.type;
  const category = q.category;
  if (category !== undefined && type !== undefined) {
    if (category === 'coding' && type !== 'code') errs.push('coding-category questions must be type "code"');
    if (category !== 'coding' && type !== 'mcq') errs.push(`${category}-category questions must be type "mcq"`);
  }
  if (type === 'mcq' || (!isUpdate && type === undefined)) {
    if (!isUpdate || q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) errs.push('mcq options must be an array of 2-6 strings');
    }
    if (!isUpdate || q.correct_index !== undefined) {
      const ci = Number(q.correct_index);
      const len = Array.isArray(q.options) ? q.options.length : 99;
      if (!Number.isInteger(ci) || ci < 0 || ci >= len) errs.push('correct_index must be a valid option index');
    }
  }
  if (type === 'code' || (!isUpdate && type === undefined)) {
    if (!isUpdate || q.test_cases !== undefined) {
      if (!Array.isArray(q.test_cases) || q.test_cases.length === 0) errs.push('code questions need at least one test case {input, expected}');
      else if (!q.test_cases.every((t) => t && typeof t.input === 'string' && typeof t.expected === 'string')) errs.push('each test case must be {input: string, expected: string}');
    }
  }
  if (q.marks !== undefined && !(Number(q.marks) > 0)) errs.push('marks must be a positive number');
  return errs;
}

router.get('/questions', (req, res) => {
  const rows = db.prepare('SELECT * FROM questions ORDER BY id').all();
  res.json(rows.map((r) => ({
    ...r,
    options: r.options_json ? JSON.parse(r.options_json) : null,
    test_cases: r.test_cases_json ? JSON.parse(r.test_cases_json) : null
  })));
});

router.post('/questions', (req, res) => {
  const q = req.body || {};
  const errs = validateQuestion(q);
  if (!q.question_text || !String(q.question_text).trim()) errs.push('question_text is required');
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const r = db.prepare(`INSERT INTO questions
    (type, category, question_text, options_json, correct_index, code_starter, language_id, test_cases_json, marks, is_sample)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(q.type, q.category || 'General', q.question_text,
      q.options ? JSON.stringify(q.options) : null,
      q.correct_index ?? null, q.code_starter || null, q.language_id || 71,
      q.test_cases ? JSON.stringify(q.test_cases) : null,
      q.marks || 1, q.is_sample ? 1 : 0);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/questions/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Question not found' });
  const q = req.body || {};
  const merged = {
    type: q.type ?? cur.type,
    category: q.category ?? cur.category,
    options: q.options ?? (cur.options_json ? JSON.parse(cur.options_json) : undefined),
    correct_index: q.correct_index ?? cur.correct_index,
    test_cases: q.test_cases ?? (cur.test_cases_json ? JSON.parse(cur.test_cases_json) : undefined),
    marks: q.marks ?? cur.marks
  };
  const errs = validateQuestion(merged, true);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  db.prepare(`UPDATE questions SET type=?, category=?, question_text=?, options_json=?,
    correct_index=?, code_starter=?, language_id=?, test_cases_json=?, marks=?, is_sample=? WHERE id=?`)
    .run(merged.type, q.category ?? cur.category, q.question_text ?? cur.question_text,
      merged.options ? JSON.stringify(merged.options) : null,
      merged.correct_index ?? null, q.code_starter ?? cur.code_starter,
      q.language_id ?? cur.language_id,
      merged.test_cases ? JSON.stringify(merged.test_cases) : null,
      merged.marks, q.is_sample !== undefined ? (q.is_sample ? 1 : 0) : cur.is_sample,
      req.params.id);
  res.json({ ok: true });
});

router.delete('/questions/:id', (req, res) => {
  const r = db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Question not found' });
  res.json({ ok: true });
});

/* ---------- Config ---------- */

const CONFIG_KEYS = ['test_title', 'duration_minutes', 'quota_aptitude', 'quota_technical', 'quota_coding', 'shuffle_questions', 'shuffle_options', 'scholarship_slabs', 'brand_name', 'accent_color'];

router.get('/config', (req, res) => res.json(getConfig()));

router.put('/config', (req, res) => {
  const body = req.body || {};
  const errs = [];
  for (const [k, v] of Object.entries(body)) {
    if (!CONFIG_KEYS.includes(k)) { errs.push(`unknown config key: ${k}`); continue; }
    if (k === 'scholarship_slabs') {
      try {
        const arr = typeof v === 'string' ? JSON.parse(v) : v;
        if (!Array.isArray(arr) || !arr.every((s) => typeof s.min === 'number' && typeof s.scholarship === 'number')) throw new Error();
      } catch { errs.push('scholarship_slabs must be a JSON array of {min, scholarship}'); continue; }
      setConfig(k, typeof v === 'string' ? v : JSON.stringify(v));
    } else {
      setConfig(k, String(v));
    }
  }
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  res.json(getConfig());
});

/* ---------- Results ---------- */

function resultsQuery(filters) {
  const where = ["a.status = 'submitted'"];
  const params = [];
  if (filters.college) { where.push('s.college LIKE ?'); params.push(`%${filters.college}%`); }
  if (filters.track) { where.push('s.track = ?'); params.push(filters.track); }
  if (filters.min_percentage !== undefined && filters.min_percentage !== '') { where.push('a.percentage >= ?'); params.push(Number(filters.min_percentage)); }
  return { where: where.join(' AND '), params };
}

router.get('/results', (req, res) => {
  const { where, params } = resultsQuery(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const rows = db.prepare(`SELECT a.id AS attempt_id, s.name, s.phone, s.email, s.college, s.city,
    s.grad_year, s.track, s.campaign_code, a.started_at, a.submitted_at, a.tab_switches,
    a.score, a.total_marks, a.percentage, a.scholarship_pct, a.certificate_id, a.claim_code, a.was_late
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE ${where} ORDER BY a.submitted_at DESC LIMIT ?`).all(...params, limit);
  res.json(rows);
});

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/results.csv', (req, res) => {
  const { where, params } = resultsQuery(req.query);
  const rows = db.prepare(`SELECT a.id AS attempt_id, s.name, s.phone, s.email, s.college, s.city,
    s.grad_year, s.track, s.campaign_code, a.started_at, a.submitted_at, a.tab_switches,
    a.score, a.total_marks, a.percentage, a.scholarship_pct, a.certificate_id, a.claim_code, a.was_late
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE ${where} ORDER BY a.submitted_at DESC LIMIT 5000`).all(...params);
  const cols = ['attempt_id', 'name', 'phone', 'email', 'college', 'city', 'grad_year', 'track', 'campaign_code', 'started_at', 'submitted_at', 'tab_switches', 'score', 'total_marks', 'percentage', 'scholarship_pct', 'certificate_id', 'claim_code', 'was_late'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aspire-results.csv"');
  res.send(lines.join('\n'));
});

/* ---------- Per-college batch skill report ---------- */

router.get('/report/college', (req, res) => {
  const college = (req.query.college || '').trim();
  if (!college) return res.status(400).json({ error: 'college query param is required' });
  const rows = db.prepare(`SELECT s.name, s.phone, s.track, a.percentage, a.scholarship_pct,
    a.score, a.total_marks, a.graded_detail_json, a.submitted_at
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted' AND s.college LIKE ? ORDER BY a.percentage DESC`).all(`%${college}%`);
  const started = db.prepare(`SELECT COUNT(*) AS c FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE s.college LIKE ?`).get(`%${college}%`).c;

  const catAgg = {};
  for (const r of rows) {
    try {
      const detail = JSON.parse(r.graded_detail_json || '[]');
      for (const d of detail) {
        const c = d.category || 'General';
        catAgg[c] = catAgg[c] || { earned: 0, marks: 0 };
        catAgg[c].earned += d.earned || 0;
        catAgg[c].marks += d.marks || 0;
      }
    } catch { /* ignore malformed detail */ }
  }
  const category_avg = {};
  for (const [c, v] of Object.entries(catAgg)) {
    category_avg[c] = v.marks ? Math.round((v.earned / v.marks) * 1000) / 10 : 0;
  }
  const avg = rows.length ? Math.round((rows.reduce((s, r) => s + r.percentage, 0) / rows.length) * 10) / 10 : 0;

  res.json({
    college,
    started_attempts: started,
    submitted: rows.length,
    avg_percentage: avg,
    category_avg,
    top10: rows.slice(0, 10).map((r) => ({ name: r.name, track: r.track, percentage: r.percentage, scholarship_pct: r.scholarship_pct }))
  });
});

module.exports = router;
