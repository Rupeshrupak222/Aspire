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
    },
    {
      version: '005_exam_builder',
      up: (d) => {
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        // 1. Core Exam Tables
        d.exec(`
          CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            code TEXT NOT NULL UNIQUE,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'LIVE', 'CLOSED', 'ARCHIVED')),
            version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
            duration_minutes INTEGER NOT NULL DEFAULT 90 CHECK (duration_minutes > 0),
            total_marks REAL NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
            passing_score REAL NOT NULL DEFAULT 40 CHECK (passing_score >= 0),
            max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
            shuffle_questions INTEGER NOT NULL DEFAULT 1,
            shuffle_options INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            published_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS exam_sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            display_order INTEGER NOT NULL DEFAULT 0,
            question_selection_mode TEXT NOT NULL DEFAULT 'RULE_BASED' CHECK (question_selection_mode IN ('MANUAL', 'POOL_RANDOM', 'RULE_BASED')),
            total_questions INTEGER NOT NULL DEFAULT 0 CHECK (total_questions >= 0),
            total_marks REAL NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS exam_section_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            section_id INTEGER NOT NULL REFERENCES exam_sections(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(section_id, question_id)
          );

          CREATE TABLE IF NOT EXISTS exam_question_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            section_id INTEGER NOT NULL REFERENCES exam_sections(id) ON DELETE CASCADE,
            topic TEXT,
            skill TEXT,
            difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('EASY', 'MEDIUM', 'HARD')),
            type TEXT CHECK (type IS NULL OR type IN ('MCQ', 'CODING')),
            category TEXT,
            count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
            marks_per_question REAL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS exam_scholarship_slabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
            min_score_pct REAL NOT NULL CHECK (min_score_pct >= 0 AND min_score_pct <= 100),
            max_score_pct REAL NOT NULL CHECK (max_score_pct >= 0 AND max_score_pct <= 100),
            discount_pct REAL NOT NULL CHECK (discount_pct >= 0 AND discount_pct <= 100),
            tier_name TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);

        // 2. Link candidate attempts to exam & frozen snapshots
        addColIfMissing('attempts', 'exam_id', 'INTEGER REFERENCES exams(id) ON DELETE SET NULL');
        addColIfMissing('attempts', 'exam_version', 'INTEGER DEFAULT 1');
        addColIfMissing('attempts', 'exam_snapshot_json', 'TEXT');
        addColIfMissing('attempts', 'questions_snapshot_json', 'TEXT');

        // 3. Performance Indexes
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_exams_org ON exams(organization_id);
          CREATE INDEX IF NOT EXISTS idx_exams_code ON exams(code);
          CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
          CREATE INDEX IF NOT EXISTS idx_exam_sections_exam_order ON exam_sections(exam_id, display_order);
          CREATE INDEX IF NOT EXISTS idx_exam_sec_q_section ON exam_section_questions(section_id);
          CREATE INDEX IF NOT EXISTS idx_exam_sec_q_question ON exam_section_questions(question_id);
          CREATE INDEX IF NOT EXISTS idx_exam_rules_section ON exam_question_rules(section_id);
          CREATE INDEX IF NOT EXISTS idx_exam_slabs_exam ON exam_scholarship_slabs(exam_id);
          CREATE INDEX IF NOT EXISTS idx_attempts_exam_id ON attempts(exam_id);
        `);

        // 4. Seed Default Active Exam for backwards compatibility
        const existingDefault = d.prepare("SELECT id FROM exams WHERE code = 'ASPIRE-SCHOLARSHIP-2026'").get();
        if (!existingDefault) {
          const insExam = d.prepare(`
            INSERT INTO exams (
              name, code, description, status, version, duration_minutes,
              total_marks, passing_score, max_attempts, is_default, published_at
            ) VALUES (?, ?, ?, 'PUBLISHED', 1, 90, 40, 40, 1, 1, datetime('now'))
          `);
          const examRes = insExam.run(
            'Aspire Scholarship Test 2026',
            'ASPIRE-SCHOLARSHIP-2026',
            'Official flagship scholarship test for Aspire candidate assessment.'
          );
          const examId = examRes.lastInsertRowid;

          // Sections: Aptitude, Technical, Coding
          const insSec = d.prepare(`
            INSERT INTO exam_sections (exam_id, name, description, display_order, question_selection_mode, total_questions, total_marks)
            VALUES (?, ?, ?, ?, 'RULE_BASED', ?, ?)
          `);
          const insRule = d.prepare(`
            INSERT INTO exam_question_rules (section_id, category, type, count, marks_per_question)
            VALUES (?, ?, ?, ?, ?)
          `);

          const s1 = insSec.run(examId, 'Aptitude', 'General aptitude and reasoning', 1, 10, 10);
          insRule.run(s1.lastInsertRowid, 'aptitude', 'MCQ', 10, 1);

          const s2 = insSec.run(examId, 'Technical', 'Core software engineering concepts', 2, 25, 25);
          insRule.run(s2.lastInsertRowid, 'technical', 'MCQ', 25, 1);

          const s3 = insSec.run(examId, 'Coding', 'Algorithmic problem solving', 3, 5, 5);
          insRule.run(s3.lastInsertRowid, 'coding', 'CODING', 5, 1);

          // Scholarship slabs
          const insSlab = d.prepare(`
            INSERT INTO exam_scholarship_slabs (exam_id, min_score_pct, max_score_pct, discount_pct, tier_name)
            VALUES (?, ?, ?, ?, ?)
          `);
          insSlab.run(examId, 90, 100, 100, 'Tier 1 (100% Scholarship)');
          insSlab.run(examId, 75, 89.99, 50, 'Tier 2 (50% Scholarship)');
          insSlab.run(examId, 60, 74.99, 25, 'Tier 3 (25% Scholarship)');
          insSlab.run(examId, 40, 59.99, 10, 'Tier 4 (10% Scholarship)');
          insSlab.run(examId, 0, 39.99, 0, 'No Scholarship');

          // Backfill existing attempts with default exam_id
          d.prepare('UPDATE attempts SET exam_id = ? WHERE exam_id IS NULL').run(examId);
        }
      }
    },
    {
      version: '006_exam_versioning_security',
      up: (d) => {
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        // 1. Add security and shuffle columns to attempts
        addColIfMissing('attempts', 'shuffle_seed', 'TEXT');
        addColIfMissing('attempts', 'snapshot_hash', 'TEXT');

        // 2. Add version lineage & lifecycle columns to exams
        addColIfMissing('exams', 'parent_exam_id', 'INTEGER REFERENCES exams(id) ON DELETE SET NULL');
        addColIfMissing('exams', 'closed_at', 'TEXT');

        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_exams_parent ON exams(parent_exam_id);
          CREATE INDEX IF NOT EXISTS idx_attempts_hash ON attempts(snapshot_hash);
        `);

        // 3. Ensure default flagship exam has sections, rules, and slabs intact
        const defExam = d.prepare("SELECT id FROM exams WHERE code = 'ASPIRE-SCHOLARSHIP-2026'").get();
        if (defExam) {
          const secCount = d.prepare("SELECT count(*) as c FROM exam_sections WHERE exam_id = ?").get(defExam.id);
          if (secCount.c === 0) {
            const insSec = d.prepare(`
              INSERT INTO exam_sections (exam_id, name, description, display_order, question_selection_mode, total_questions, total_marks)
              VALUES (?, ?, ?, ?, 'RULE_BASED', ?, ?)
            `);
            const insRule = d.prepare(`
              INSERT INTO exam_question_rules (section_id, category, type, count, marks_per_question)
              VALUES (?, ?, ?, ?, ?)
            `);

            const s1 = insSec.run(defExam.id, 'Aptitude', 'General aptitude and reasoning', 1, 10, 10);
            insRule.run(s1.lastInsertRowid, 'aptitude', 'MCQ', 10, 1);

            const s2 = insSec.run(defExam.id, 'Technical', 'Core software engineering concepts', 2, 25, 25);
            insRule.run(s2.lastInsertRowid, 'technical', 'MCQ', 25, 1);

            const s3 = insSec.run(defExam.id, 'Coding', 'Algorithmic problem solving', 3, 5, 5);
            insRule.run(s3.lastInsertRowid, 'coding', 'CODING', 5, 1);
          }

          const slabCount = d.prepare("SELECT count(*) as c FROM exam_scholarship_slabs WHERE exam_id = ?").get(defExam.id);
          if (slabCount.c === 0) {
            const insSlab = d.prepare(`
              INSERT INTO exam_scholarship_slabs (exam_id, min_score_pct, max_score_pct, discount_pct, tier_name)
              VALUES (?, ?, ?, ?, ?)
            `);
            insSlab.run(defExam.id, 90, 100, 100, 'Tier 1 (100% Scholarship)');
            insSlab.run(defExam.id, 75, 89.99, 50, 'Tier 2 (50% Scholarship)');
            insSlab.run(defExam.id, 60, 74.99, 25, 'Tier 3 (25% Scholarship)');
            insSlab.run(defExam.id, 40, 59.99, 10, 'Tier 4 (10% Scholarship)');
            insSlab.run(defExam.id, 0, 39.99, 0, 'No Scholarship');
          }
        }
      }
    },
    {
      version: '007_coding_execution',
      up: (d) => {
        d.exec(`
          CREATE TABLE IF NOT EXISTS coding_submissions (
            id TEXT PRIMARY KEY,
            attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
            language TEXT NOT NULL,
            submission_status TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_submission_id TEXT,
            source_hash TEXT NOT NULL,
            source_code TEXT,
            test_cases_passed INTEGER NOT NULL DEFAULT 0,
            test_cases_total INTEGER NOT NULL DEFAULT 0,
            score REAL NOT NULL DEFAULT 0,
            execution_time_ms INTEGER,
            memory_used_kb INTEGER,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_coding_subs_attempt ON coding_submissions(attempt_id);
          CREATE INDEX IF NOT EXISTS idx_coding_subs_question ON coding_submissions(question_id);
          CREATE INDEX IF NOT EXISTS idx_coding_subs_org ON coding_submissions(organization_id);
          CREATE INDEX IF NOT EXISTS idx_coding_subs_status ON coding_submissions(submission_status);
          CREATE INDEX IF NOT EXISTS idx_coding_subs_created ON coding_submissions(created_at DESC);
        `);
      }
    },
    {
      version: '008_async_code_execution',
      up: (d) => {
        // 1. Transactional outbox table for reliable Redis/BullMQ event publishing
        d.exec(`
          CREATE TABLE IF NOT EXISTS outbox_events (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DISPATCHED', 'FAILED')),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            available_at TEXT NOT NULL DEFAULT (datetime('now')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            processed_at TEXT,
            last_error_code TEXT,
            last_error_message TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_outbox_status_avail ON outbox_events(status, available_at);
          CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_id);
          CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox_events(created_at);
        `);

        // 2. Add lifecycle status and job tracking columns to coding_submissions
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        addColIfMissing('coding_submissions', 'lifecycle_status', "TEXT NOT NULL DEFAULT 'QUEUED'");
        addColIfMissing('coding_submissions', 'job_id', 'TEXT');
        addColIfMissing('coding_submissions', 'queued_at', 'TEXT');
        addColIfMissing('coding_submissions', 'started_at', 'TEXT');
        addColIfMissing('coding_submissions', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
        addColIfMissing('coding_submissions', 'last_error_code', 'TEXT');
        addColIfMissing('coding_submissions', 'last_error_at', 'TEXT');

        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_coding_subs_lifecycle ON coding_submissions(lifecycle_status);
          CREATE INDEX IF NOT EXISTS idx_coding_subs_job_id ON coding_submissions(job_id);
        `);
      }
    },
    {
      version: '009_proctoring_analytics',
      up: (d) => {
        // 1. Dedicated proctoring events table for enterprise behavioral tracking
        d.exec(`
          CREATE TABLE IF NOT EXISTS proctoring_events (
            id TEXT PRIMARY KEY,
            attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL,
            event_timestamp TEXT NOT NULL,
            received_at TEXT NOT NULL DEFAULT (datetime('now')),
            risk_points INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_proctoring_attempt ON proctoring_events(attempt_id);
          CREATE INDEX IF NOT EXISTS idx_proctoring_type ON proctoring_events(event_type);
          CREATE INDEX IF NOT EXISTS idx_proctoring_event_id ON proctoring_events(event_id);
          CREATE INDEX IF NOT EXISTS idx_proctoring_timestamp ON proctoring_events(event_timestamp);
        `);

        // 2. Add proctoring analytics fields to attempts table
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        addColIfMissing('attempts', 'proctoring_risk_score', 'INTEGER NOT NULL DEFAULT 0');
        addColIfMissing('attempts', 'proctoring_risk_level', "TEXT NOT NULL DEFAULT 'NORMAL'");
        addColIfMissing('attempts', 'proctoring_summary_json', 'TEXT');

        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_attempts_risk_level ON attempts(proctoring_risk_level);
        `);
      }
    },
    {
      version: '010_network_session_recovery',
      up: (d) => {
        // 1. Durable sync change log for idempotency and conflict resolution
        d.exec(`
          CREATE TABLE IF NOT EXISTS attempt_sync_changes (
            id TEXT PRIMARY KEY,
            attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
            change_type TEXT NOT NULL,
            question_id INTEGER,
            revision INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            client_session_id TEXT,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_sync_changes_attempt ON attempt_sync_changes(attempt_id);
          CREATE INDEX IF NOT EXISTS idx_sync_changes_qid ON attempt_sync_changes(attempt_id, question_id);
          CREATE INDEX IF NOT EXISTS idx_sync_changes_applied ON attempt_sync_changes(applied_at);
        `);

        // 2. Add progress, heartbeat, revision, and recovery columns to attempts table
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        addColIfMissing('attempts', 'last_heartbeat_at', 'TEXT');
        addColIfMissing('attempts', 'last_synced_at', 'TEXT');
        addColIfMissing('attempts', 'server_revision', 'INTEGER NOT NULL DEFAULT 0');
        addColIfMissing('attempts', 'current_question_id', 'INTEGER');
        addColIfMissing('attempts', 'current_section_id', 'INTEGER');
        addColIfMissing('attempts', 'client_session_id', 'TEXT');
        addColIfMissing('attempts', 'draft_code_json', 'TEXT');
        addColIfMissing('attempts', 'sync_conflict_count', 'INTEGER NOT NULL DEFAULT 0');

        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_attempts_heartbeat ON attempts(last_heartbeat_at);
          CREATE INDEX IF NOT EXISTS idx_attempts_synced ON attempts(last_synced_at);
        `);
      }
    },
    {
      version: '011_timer_submission_reliability',
      up: (d) => {
        const addColIfMissing = (table, col, def) => {
          const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          if (!cols.includes(col)) {
            d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
          }
        };

        // 1. Authoritative deadline and grace period fields
        addColIfMissing('attempts', 'deadline_at', 'TEXT');
        addColIfMissing('attempts', 'grace_period_seconds', 'INTEGER NOT NULL DEFAULT 60');

        // 2. Finalization idempotency & status
        addColIfMissing('attempts', 'submission_id', 'TEXT');
        addColIfMissing('attempts', 'finalization_status', "TEXT NOT NULL DEFAULT 'PENDING'");
        addColIfMissing('attempts', 'finalized_by', "TEXT DEFAULT 'CANDIDATE'");

        // 3. Backfill deadline_at for existing rows
        d.exec(`
          UPDATE attempts SET deadline_at = expires_at WHERE deadline_at IS NULL;
          UPDATE attempts SET finalization_status = 'FINALIZED' WHERE status = 'submitted' AND finalization_status = 'PENDING';
        `);

        // 4. Indexes for fast deadline reconciliation and idempotency
        d.exec(`
          CREATE INDEX IF NOT EXISTS idx_attempts_deadline ON attempts(expires_at, status);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_submission_id ON attempts(submission_id) WHERE submission_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_attempts_finalization ON attempts(finalization_status);
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

