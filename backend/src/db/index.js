// SQLite database layer (better-sqlite3). File DB; swap to Postgres later if needed.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'data', 'aspire.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('mcq','code')),
  category TEXT NOT NULL DEFAULT 'General',
  question_text TEXT NOT NULL,
  options_json TEXT,            -- mcq: JSON array of option strings
  correct_index INTEGER,        -- mcq: index into the ORIGINAL options array
  code_starter TEXT,            -- code: starter template shown to student
  language_id INTEGER DEFAULT 71, -- Judge0 language id (71 = Python 3)
  test_cases_json TEXT,         -- code: JSON array of {input, expected}
  marks INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,   -- normalized to last 10 digits; one attempt per phone
  email TEXT,
  college TEXT,
  city TEXT,
  grad_year TEXT,
  track TEXT,
  campaign_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started',  -- started | submitted
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  submitted_at TEXT,
  tab_switches INTEGER NOT NULL DEFAULT 0,
  question_ids_json TEXT NOT NULL,  -- JSON array of question ids in served order
  shuffle_map_json TEXT NOT NULL DEFAULT '{}', -- {qid: [origIdx per shuffled position]}
  answers_json TEXT,                -- mcq answers {qid: shuffledSelectedIndex}
  code_answers_json TEXT,           -- code answers {qid: sourceCode}
  score REAL,
  total_marks REAL,
  percentage REAL,
  scholarship_pct INTEGER,
  certificate_id TEXT UNIQUE,
  claim_code TEXT UNIQUE,
  was_late INTEGER NOT NULL DEFAULT 0,
  graded_detail_json TEXT           -- per-question {id, category, type, marks, earned}
);
CREATE INDEX IF NOT EXISTS idx_attempts_token ON attempts(token);
CREATE INDEX IF NOT EXISTS idx_attempts_cert ON attempts(certificate_id);
CREATE INDEX IF NOT EXISTS idx_students_phone ON students(phone);
`);

const DEFAULT_CONFIG = {
  test_title: 'Aspire Scholarship Test',
  duration_minutes: '90',
  // Per-category quotas: each attempt draws up to quota questions from each
  // category (random subset, shuffled). Coding requires Judge0; when Judge0
  // is not configured the coding quota is skipped (test runs with 35).
  quota_aptitude: '10',
  quota_technical: '25',
  quota_coding: '5',
  shuffle_questions: '1',
  shuffle_options: '1',
  // Ordered high -> low. First slab whose min <= percentage wins.
  scholarship_slabs: JSON.stringify([
    { min: 90, scholarship: 100 },
    { min: 75, scholarship: 50 },
    { min: 60, scholarship: 25 },
    { min: 40, scholarship: 10 },
    { min: 0, scholarship: 0 }
  ]),
  brand_name: 'Adyapan',
  accent_color: '#F97316'
};

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = { ...DEFAULT_CONFIG };
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

function setConfig(key, value) {
  db.prepare(`INSERT INTO config(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

module.exports = { db, getConfig, setConfig, DEFAULT_CONFIG, DB_PATH };
