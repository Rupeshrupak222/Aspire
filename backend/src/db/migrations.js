// Database migrations runner for Aspire.
// Ensures idempotent schema setup and updates without destroying existing data.

function runMigrations(db) {
  // 1. Ensure migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const migrations = [
    {
      version: '001_core_schema',
      up: (d) => {
        d.exec(`
          CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK(type IN ('mcq','code')),
            category TEXT NOT NULL DEFAULT 'General',
            question_text TEXT NOT NULL,
            options_json TEXT,
            correct_index INTEGER,
            code_starter TEXT,
            language_id INTEGER DEFAULT 71,
            test_cases_json TEXT,
            marks INTEGER NOT NULL DEFAULT 1,
            is_sample INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
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
            status TEXT NOT NULL DEFAULT 'started',
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            submitted_at TEXT,
            tab_switches INTEGER NOT NULL DEFAULT 0,
            question_ids_json TEXT NOT NULL,
            shuffle_map_json TEXT NOT NULL DEFAULT '{}',
            answers_json TEXT,
            code_answers_json TEXT,
            score REAL,
            total_marks REAL,
            percentage REAL,
            scholarship_pct INTEGER,
            certificate_id TEXT UNIQUE,
            claim_code TEXT UNIQUE,
            was_late INTEGER NOT NULL DEFAULT 0,
            graded_detail_json TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_attempts_token ON attempts(token);
          CREATE INDEX IF NOT EXISTS idx_attempts_cert ON attempts(certificate_id);
          CREATE INDEX IF NOT EXISTS idx_students_phone ON students(phone);
        `);
      }
    },
    {
      version: '002_rbac_multitenancy',
      up: (d) => {
        // Multi-tenant organizations table
        d.exec(`
          CREATE TABLE IF NOT EXISTS organizations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'SUSPENDED')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

          -- Administrative user identities
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER', 'EVALUATOR', 'VIEWER')),
            organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
            token_version INTEGER NOT NULL DEFAULT 1,
            last_login_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
          CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

          -- Server-side authenticated sessions for immediate revocation / logout
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
          CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

          -- Persistent security audit log
          CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            event TEXT NOT NULL,
            details_json TEXT,
            ip_address TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event);
          CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
          CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
        `);

        // Safely add organization_id to questions, students, attempts if missing
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        addColIfMissing('questions', 'organization_id', 'INTEGER REFERENCES organizations(id)');
        addColIfMissing('students', 'organization_id', 'INTEGER REFERENCES organizations(id)');
        addColIfMissing('attempts', 'organization_id', 'INTEGER REFERENCES organizations(id)');

        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_questions_org ON questions(organization_id);
          CREATE INDEX IF NOT EXISTS idx_students_org ON students(organization_id);
          CREATE INDEX IF NOT EXISTS idx_attempts_org ON attempts(organization_id);
        `);
      }
    },
    {
      version: '003_db_hardening',
      up: (d) => {
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        // 1. Ensure updated_at & heartbeat tracking columns exist
        addColIfMissing('questions', 'updated_at', 'TEXT');
        addColIfMissing('config', 'updated_at', 'TEXT');
        addColIfMissing('attempts', 'last_heartbeat_at', 'TEXT');

        d.exec(`
          UPDATE questions SET updated_at = datetime('now') WHERE updated_at IS NULL;
          UPDATE config SET updated_at = datetime('now') WHERE updated_at IS NULL;
        `);

        // 2. High-performance indexes for frequent query paths
        d.exec(`
          -- Question bank generation by category and type
          CREATE INDEX IF NOT EXISTS idx_questions_category_type ON questions(category, type);

          -- Attempt lookup by student (registration check & resume)
          CREATE INDEX IF NOT EXISTS idx_attempts_student_id ON attempts(student_id);

          -- Attempt lookup by claim code
          CREATE INDEX IF NOT EXISTS idx_attempts_claim_code ON attempts(claim_code);

          -- Admin queries for attempts by status and submission date
          CREATE INDEX IF NOT EXISTS idx_attempts_status_submitted ON attempts(status, submitted_at DESC);

          -- Student reports by college and track
          CREATE INDEX IF NOT EXISTS idx_students_college ON students(college);
          CREATE INDEX IF NOT EXISTS idx_students_track ON students(track);

          -- Multi-tenant user queries by organization and role
          CREATE INDEX IF NOT EXISTS idx_users_org_role ON users(organization_id, role);

          -- High-performance audit log filtering by event and timestamp
          CREATE INDEX IF NOT EXISTS idx_audit_logs_event_created ON audit_logs(event, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(organization_id, created_at DESC);
        `);
      }
    },
    {
      version: '004_question_bank_2_0',
      up: (d) => {
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        // 1. Question Bank 2.0 metadata fields
        addColIfMissing('questions', 'title', 'TEXT');
        addColIfMissing('questions', 'difficulty', "TEXT NOT NULL DEFAULT 'MEDIUM'");
        addColIfMissing('questions', 'topic', 'TEXT');
        addColIfMissing('questions', 'skill', 'TEXT');
        addColIfMissing('questions', 'time_estimate', 'INTEGER NOT NULL DEFAULT 120');
        addColIfMissing('questions', 'tags', "TEXT NOT NULL DEFAULT '[]'");
        addColIfMissing('questions', 'language', 'TEXT');
        addColIfMissing('questions', 'version', 'INTEGER NOT NULL DEFAULT 1');
        addColIfMissing('questions', 'status', "TEXT NOT NULL DEFAULT 'PUBLISHED'");
        addColIfMissing('questions', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
        addColIfMissing('questions', 'updated_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

        // 2. Backfill existing rows with consistent data
        d.exec(`
          UPDATE questions SET difficulty = 'MEDIUM' WHERE difficulty IS NULL;
          UPDATE questions SET status = 'PUBLISHED' WHERE status IS NULL;
          UPDATE questions SET version = 1 WHERE version IS NULL;
          UPDATE questions SET time_estimate = 120 WHERE time_estimate IS NULL;
          UPDATE questions SET tags = '[]' WHERE tags IS NULL;
          UPDATE questions SET language = 'python' WHERE type = 'code' AND language IS NULL;
          UPDATE questions SET title = SUBSTR(question_text, 1, 60) WHERE title IS NULL OR title = '';
        `);

        // 3. Question Bank query performance indexes
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
          CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty);
          CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic);
          CREATE INDEX IF NOT EXISTS idx_questions_skill ON questions(skill);
          CREATE INDEX IF NOT EXISTS idx_questions_org_status ON questions(organization_id, status);
          CREATE INDEX IF NOT EXISTS idx_questions_version ON questions(version);
        `);
      }
    }
  ];

  for (const m of migrations) {
    if (!applied.has(m.version)) {
      const runTx = db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      });
      runTx();
    }
  }
}

function getMigrationsStatus(db) {
  try {
    const rows = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at ASC').all();
    return rows;
  } catch {
    return [];
  }
}

module.exports = { runMigrations, getMigrationsStatus };

