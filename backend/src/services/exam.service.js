// Exam Builder Service Layer.
// Centralizes exam authoring, section management, question rule evaluation,
// publish validation, snapshot generation, and candidate attempt question assembly.

const { db } = require('../db');
const { ROLES } = require('../security/rbac');
const {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  AuthorizationError
} = require('../errors/app-error');
const { recordAuditEvent } = require('./audit.service');
const shuffleService = require('./shuffle.service');
const snapshotService = require('./snapshot.service');

/**
 * Ensures an exam version can be modified.
 * Once published, live, closed, or archived, assessment-critical parameters are permanently immutable.
 *
 * @param {Object} exam
 * @throws {ConflictError} if exam is not in DRAFT or REVIEW status
 */
function assertExamMutable(exam) {
  if (exam.status !== 'DRAFT' && exam.status !== 'REVIEW') {
    throw new ConflictError(
      `Published exam versions cannot be modified (current status: ${exam.status}). Create a new draft version to make changes.`,
      'EXAM_VERSION_IMMUTABLE'
    );
  }
}

const ALLOWED_TRANSITIONS = {
  DRAFT: ['REVIEW', 'PUBLISHED', 'ARCHIVED'],
  REVIEW: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['LIVE', 'CLOSED', 'ARCHIVED'],
  LIVE: ['CLOSED', 'ARCHIVED'],
  CLOSED: ['LIVE', 'ARCHIVED'],
  ARCHIVED: [] // Terminal state
};

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * List exams with search, status filtering, tenant scoping, and pagination.
 */
function listExams(options = {}, user = null) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];

  // Multi-tenant isolation: non-super-admin is scoped to their organization
  if (user && user.role !== ROLES.SUPER_ADMIN) {
    if (user.organization_id) {
      where.push('(e.organization_id = ? OR e.organization_id IS NULL)');
      params.push(user.organization_id);
    } else {
      where.push('e.organization_id IS NULL');
    }
  } else if (options.organization_id) {
    where.push('e.organization_id = ?');
    params.push(parseInt(options.organization_id, 10));
  }

  if (options.status) {
    where.push('e.status = ?');
    params.push(options.status);
  }

  if (options.search) {
    where.push('(e.name LIKE ? OR e.code LIKE ? OR e.description LIKE ?)');
    const term = `%${options.search.trim()}%`;
    params.push(term, term, term);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT count(*) as count FROM exams e ${whereClause}`).get(...params);
  const total = countRow ? countRow.count : 0;

  const allowedSortCols = {
    created_at: 'e.created_at',
    updated_at: 'e.updated_at',
    name: 'e.name',
    code: 'e.code',
    status: 'e.status',
    duration_minutes: 'e.duration_minutes',
    total_marks: 'e.total_marks'
  };
  const sortCol = allowedSortCols[options.sortBy] || 'e.created_at';
  const sortOrder = options.sortOrder === 'ASC' ? 'ASC' : 'DESC';

  const rows = db.prepare(`
    SELECT e.*,
           o.name as organization_name,
           u1.email as creator_email,
           u2.email as updater_email,
           (SELECT count(*) FROM exam_sections s WHERE s.exam_id = e.id) as section_count
    FROM exams e
    LEFT JOIN organizations o ON o.id = e.organization_id
    LEFT JOIN users u1 ON u1.id = e.created_by
    LEFT JOIN users u2 ON u2.id = e.updated_by
    ${whereClause}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    items: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/**
 * Retrieve detailed exam by ID including sections, questions/rules, and scholarship slabs.
 */
function getExamById(id, user = null) {
  const exam = db.prepare(`
    SELECT e.*,
           o.name as organization_name,
           u1.email as creator_email,
           u2.email as updater_email
    FROM exams e
    LEFT JOIN organizations o ON o.id = e.organization_id
    LEFT JOIN users u1 ON u1.id = e.created_by
    LEFT JOIN users u2 ON u2.id = e.updated_by
    WHERE e.id = ?
  `).get(id);

  if (!exam) throw new NotFoundError(`Exam with ID ${id} not found`);

  // Multi-tenant check
  if (user && user.role !== ROLES.SUPER_ADMIN && user.organization_id && exam.organization_id) {
    if (exam.organization_id !== user.organization_id) {
      throw new AuthorizationError('Cannot access exam belonging to another organization');
    }
  }

  // Load sections ordered by display_order
  const sections = db.prepare(`
    SELECT * FROM exam_sections
    WHERE exam_id = ?
    ORDER BY display_order ASC, id ASC
  `).all(id);

  for (const s of sections) {
    if (s.question_selection_mode === 'MANUAL') {
      s.questions = db.prepare(`
        SELECT q.id, q.type, q.category, q.title, q.question_text, q.difficulty,
               q.topic, q.skill, q.marks, q.status, sq.display_order
        FROM exam_section_questions sq
        JOIN questions q ON q.id = sq.question_id
        WHERE sq.section_id = ?
        ORDER BY sq.display_order ASC, sq.id ASC
      `).all(s.id);
    } else {
      s.rules = db.prepare(`
        SELECT * FROM exam_question_rules
        WHERE section_id = ?
        ORDER BY id ASC
      `).all(s.id);
    }
  }

  // Load scholarship slabs ordered by min_score_pct DESC
  const slabs = db.prepare(`
    SELECT * FROM exam_scholarship_slabs
    WHERE exam_id = ?
    ORDER BY min_score_pct DESC
  `).all(id);

  exam.sections = sections;
  exam.scholarship_slabs = slabs;
  return exam;
}

/**
 * Find active exam by code (used for candidate attempts).
 */
/**
 * Get exam by unique code.
 * Prioritizes LIVE, then PUBLISHED, then CLOSED, with latest version preferred.
 */
function getExamByCode(code) {
  if (!code) return null;
  const cleanCode = code.toUpperCase().trim();
  const exam = db.prepare(`
    SELECT * FROM exams 
    WHERE code = ? 
    ORDER BY 
      CASE status 
        WHEN 'LIVE' THEN 1 
        WHEN 'PUBLISHED' THEN 2 
        WHEN 'CLOSED' THEN 3 
        WHEN 'REVIEW' THEN 4 
        ELSE 5 
      END ASC, 
      version DESC, 
      id DESC 
    LIMIT 1
  `).get(cleanCode);
  return exam || null;
}

/**
 * Get default live or published exam (backwards compatibility).
 */
function getDefaultPublishedExam() {
  let exam = db.prepare(`
    SELECT * FROM exams 
    WHERE is_default = 1 AND status IN ('LIVE', 'PUBLISHED') 
    ORDER BY CASE status WHEN 'LIVE' THEN 1 ELSE 2 END ASC, version DESC, id DESC 
    LIMIT 1
  `).get();
  if (!exam) {
    exam = db.prepare(`
      SELECT * FROM exams 
      WHERE status IN ('LIVE', 'PUBLISHED') 
      ORDER BY CASE status WHEN 'LIVE' THEN 1 ELSE 2 END ASC, version DESC, id DESC 
      LIMIT 1
    `).get();
  }
  return exam || null;
}

/**
 * Create a new exam in DRAFT status.
 */
function createExam(data, user, req = null) {
  const code = data.code.toUpperCase().trim();
  const existing = db.prepare('SELECT id FROM exams WHERE code = ?').get(code);
  if (existing) {
    throw new ConflictError(`Exam code "${code}" is already in use`);
  }

  const orgId = user.role === ROLES.SUPER_ADMIN
    ? (data.organization_id !== undefined ? data.organization_id : null)
    : user.organization_id;

  const ins = db.prepare(`
    INSERT INTO exams (
      organization_id, name, code, description, status, version,
      duration_minutes, total_marks, passing_score, max_attempts,
      shuffle_questions, shuffle_options, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 'DRAFT', 1, ?, 0, ?, ?, ?, ?, ?, ?)
  `);

  const res = ins.run(
    orgId,
    data.name.trim(),
    code,
    data.description ? data.description.trim() : null,
    data.duration_minutes || 90,
    data.passing_score !== undefined ? data.passing_score : 40,
    data.max_attempts || 1,
    data.shuffle_questions !== undefined ? data.shuffle_questions : 1,
    data.shuffle_options !== undefined ? data.shuffle_options : 1,
    user.id,
    user.id
  );

  const newId = res.lastInsertRowid;

  // Automatically seed standard scholarship slabs
  const insSlab = db.prepare(`
    INSERT INTO exam_scholarship_slabs (exam_id, min_score_pct, max_score_pct, discount_pct, tier_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  insSlab.run(newId, 90, 100, 100, 'Tier 1 (100% Scholarship)');
  insSlab.run(newId, 75, 89.99, 50, 'Tier 2 (50% Scholarship)');
  insSlab.run(newId, 60, 74.99, 25, 'Tier 3 (25% Scholarship)');
  insSlab.run(newId, 40, 59.99, 10, 'Tier 4 (10% Scholarship)');
  insSlab.run(newId, 0, 39.99, 0, 'No Scholarship');

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: orgId,
    event: 'exam_created',
    details: { examId: newId, code, name: data.name }
  });

  return getExamById(newId, user);
}

/**
 * Update an existing exam with optimistic concurrency control.
 */
function updateExam(id, data, user, req = null) {
  const exam = getExamById(id, user);

  // Published versions are strictly immutable
  assertExamMutable(exam);

  // Optimistic concurrency check
  if (data.expected_version !== undefined && data.expected_version !== exam.version) {
    throw new ConflictError(
      `Stale exam version conflict. Expected version ${data.expected_version}, but database version is ${exam.version}. Please refresh.`
    );
  }

  if (data.code && data.code !== exam.code) {
    const existing = db.prepare('SELECT id FROM exams WHERE code = ? AND id != ?').get(data.code, id);
    if (existing) throw new ConflictError(`Exam code "${data.code}" is already in use`);
  }

  const fields = [];
  const params = [];

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name.trim()); }
  if (data.code !== undefined) { fields.push('code = ?'); params.push(data.code); }
  if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description ? data.description.trim() : null); }
  if (data.duration_minutes !== undefined) { fields.push('duration_minutes = ?'); params.push(data.duration_minutes); }
  if (data.passing_score !== undefined) { fields.push('passing_score = ?'); params.push(data.passing_score); }
  if (data.max_attempts !== undefined) { fields.push('max_attempts = ?'); params.push(data.max_attempts); }
  if (data.shuffle_questions !== undefined) { fields.push('shuffle_questions = ?'); params.push(data.shuffle_questions); }
  if (data.shuffle_options !== undefined) { fields.push('shuffle_options = ?'); params.push(data.shuffle_options); }

  fields.push('updated_by = ?');
  params.push(user.id);
  fields.push("updated_at = datetime('now')");

  params.push(id);

  db.prepare(`UPDATE exams SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_updated',
    details: { examId: id, updatedFields: Object.keys(data) }
  });

  return getExamById(id, user);
}

/**
 * Add a section to an exam.
 */
function addSection(examId, data, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  // Determine display_order
  let displayOrder = data.display_order;
  if (displayOrder === undefined || displayOrder === null) {
    const maxOrder = db.prepare('SELECT MAX(display_order) as m FROM exam_sections WHERE exam_id = ?').get(examId);
    displayOrder = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 1;
  }

  const res = db.prepare(`
    INSERT INTO exam_sections (
      exam_id, name, description, display_order, question_selection_mode, total_questions, total_marks
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    examId,
    data.name.trim(),
    data.description ? data.description.trim() : null,
    displayOrder,
    data.question_selection_mode || 'RULE_BASED',
    data.total_questions || 0,
    data.total_marks || 0
  );

  const sectionId = res.lastInsertRowid;
  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_section_created',
    details: { examId, sectionId, name: data.name }
  });

  return getExamById(examId, user);
}

/**
 * Update an existing section.
 */
function updateSection(examId, sectionId, data, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const sec = db.prepare('SELECT * FROM exam_sections WHERE id = ? AND exam_id = ?').get(sectionId, examId);
  if (!sec) throw new NotFoundError(`Section ${sectionId} not found in exam ${examId}`);

  const fields = [];
  const params = [];

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name.trim()); }
  if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description ? data.description.trim() : null); }
  if (data.display_order !== undefined) { fields.push('display_order = ?'); params.push(data.display_order); }
  if (data.question_selection_mode !== undefined) { fields.push('question_selection_mode = ?'); params.push(data.question_selection_mode); }
  if (data.total_questions !== undefined) { fields.push('total_questions = ?'); params.push(data.total_questions); }
  if (data.total_marks !== undefined) { fields.push('total_marks = ?'); params.push(data.total_marks); }

  fields.push("updated_at = datetime('now')");
  params.push(sectionId, examId);

  db.prepare(`UPDATE exam_sections SET ${fields.join(', ')} WHERE id = ? AND exam_id = ?`).run(...params);
  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_section_updated',
    details: { examId, sectionId, updatedFields: Object.keys(data) }
  });

  return getExamById(examId, user);
}

/**
 * Delete a section and all its associated questions/rules.
 */
function deleteSection(examId, sectionId, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const sec = db.prepare('SELECT * FROM exam_sections WHERE id = ? AND exam_id = ?').get(sectionId, examId);
  if (!sec) throw new NotFoundError(`Section ${sectionId} not found in exam ${examId}`);

  db.prepare('DELETE FROM exam_sections WHERE id = ?').run(sectionId);
  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_section_deleted',
    details: { examId, sectionId }
  });

  return getExamById(examId, user);
}

/**
 * Reorder sections safely within a database transaction.
 */
function reorderSections(examId, sectionIds, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const existingSections = db.prepare('SELECT id FROM exam_sections WHERE exam_id = ?').all(examId);
  const existingIds = new Set(existingSections.map(s => s.id));

  if (sectionIds.length !== existingIds.size || !sectionIds.every(id => existingIds.has(id))) {
    throw new ValidationError('Invalid section ordering: provided IDs do not match all sections of this exam');
  }

  const tx = db.transaction(() => {
    const upd = db.prepare("UPDATE exam_sections SET display_order = ?, updated_at = datetime('now') WHERE id = ? AND exam_id = ?");
    sectionIds.forEach((id, idx) => {
      upd.run(idx + 1, id, examId);
    });
  });
  tx();

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_sections_reordered',
    details: { examId, newOrder: sectionIds }
  });

  return getExamById(examId, user);
}

/**
 * Add question manually to a section.
 */
function addQuestionToSection(examId, sectionId, questionId, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const sec = db.prepare('SELECT * FROM exam_sections WHERE id = ? AND exam_id = ?').get(sectionId, examId);
  if (!sec) throw new NotFoundError(`Section ${sectionId} not found in exam ${examId}`);

  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  if (!question) throw new NotFoundError(`Question ${questionId} not found`);

  // Verify tenant access to question
  if (user.role !== ROLES.SUPER_ADMIN && user.organization_id && question.organization_id) {
    if (question.organization_id !== user.organization_id) {
      throw new AuthorizationError('Cannot attach question from another organization');
    }
  }

  // Question must be published
  if (question.status !== 'PUBLISHED') {
    throw new ValidationError(`Question ${questionId} is ${question.status || 'unpublished'}; only PUBLISHED questions can be added to an exam`);
  }

  // Prevent duplicate insertion in section
  const dup = db.prepare('SELECT id FROM exam_section_questions WHERE section_id = ? AND question_id = ?').get(sectionId, questionId);
  if (dup) {
    throw new ConflictError(`Question ${questionId} is already added to section "${sec.name}"`);
  }

  const maxOrder = db.prepare('SELECT MAX(display_order) as m FROM exam_section_questions WHERE section_id = ?').get(sectionId);
  const displayOrder = (maxOrder && maxOrder.m !== null) ? maxOrder.m + 1 : 1;

  db.prepare(`
    INSERT INTO exam_section_questions (section_id, question_id, display_order)
    VALUES (?, ?, ?)
  `).run(sectionId, questionId, displayOrder);

  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_question_added',
    details: { examId, sectionId, questionId }
  });

  return getExamById(examId, user);
}

/**
 * Remove question from section.
 */
function removeQuestionFromSection(examId, sectionId, questionId, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const del = db.prepare('DELETE FROM exam_section_questions WHERE section_id = ? AND question_id = ?').run(sectionId, questionId);
  if (del.changes === 0) {
    throw new NotFoundError(`Question ${questionId} not found in section ${sectionId}`);
  }

  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_question_removed',
    details: { examId, sectionId, questionId }
  });

  return getExamById(examId, user);
}

/**
 * Add a question selection rule to a section.
 */
function addRuleToSection(examId, sectionId, data, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const sec = db.prepare('SELECT * FROM exam_sections WHERE id = ? AND exam_id = ?').get(sectionId, examId);
  if (!sec) throw new NotFoundError(`Section ${sectionId} not found in exam ${examId}`);

  const res = db.prepare(`
    INSERT INTO exam_question_rules (section_id, topic, skill, difficulty, type, category, count, marks_per_question)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sectionId,
    data.topic ? data.topic.trim() : null,
    data.skill ? data.skill.trim() : null,
    data.difficulty || null,
    data.type || null,
    data.category ? data.category.trim() : null,
    data.count || 1,
    data.marks_per_question !== undefined ? data.marks_per_question : 1
  );

  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_rule_added',
    details: { examId, sectionId, ruleId: res.lastInsertRowid, count: data.count }
  });

  return getExamById(examId, user);
}

/**
 * Remove rule from section.
 */
function removeRuleFromSection(examId, sectionId, ruleId, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  const del = db.prepare('DELETE FROM exam_question_rules WHERE id = ? AND section_id = ?').run(ruleId, sectionId);
  if (del.changes === 0) {
    throw new NotFoundError(`Rule ${ruleId} not found in section ${sectionId}`);
  }

  recalculateExamTotals(examId);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_rule_removed',
    details: { examId, sectionId, ruleId }
  });

  return getExamById(examId, user);
}

/**
 * Update scholarship slabs for an exam.
 */
function setScholarshipSlabs(examId, slabs, user, req = null) {
  const exam = getExamById(examId, user);
  assertExamMutable(exam);

  // Validate non-overlapping slabs
  const sorted = slabs.slice().sort((a, b) => a.min_score_pct - b.min_score_pct);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].max_score_pct > sorted[i + 1].min_score_pct) {
      throw new ValidationError(
        `Overlapping scholarship slabs detected: [${sorted[i].min_score_pct}%-${sorted[i].max_score_pct}%] overlaps with [${sorted[i + 1].min_score_pct}%-${sorted[i + 1].max_score_pct}%]`
      );
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM exam_scholarship_slabs WHERE exam_id = ?').run(examId);
    const ins = db.prepare(`
      INSERT INTO exam_scholarship_slabs (exam_id, min_score_pct, max_score_pct, discount_pct, tier_name)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const s of slabs) {
      ins.run(
        examId,
        s.min_score_pct,
        s.max_score_pct,
        s.discount_pct,
        s.tier_name ? s.tier_name.trim() : null
      );
    }
  });
  tx();

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_scholarship_updated',
    details: { examId, slabCount: slabs.length }
  });

  return getExamById(examId, user);
}

/**
 * Authoritative recalculation of section and exam question counts and total marks.
 */
function recalculateExamTotals(examId) {
  const sections = db.prepare('SELECT id, question_selection_mode FROM exam_sections WHERE exam_id = ?').all(examId);

  let grandTotalQuestions = 0;
  let grandTotalMarks = 0;

  for (const s of sections) {
    let secQuestions = 0;
    let secMarks = 0;

    if (s.question_selection_mode === 'MANUAL') {
      const qRow = db.prepare(`
        SELECT count(*) as count, COALESCE(SUM(q.marks), 0) as total_marks
        FROM exam_section_questions sq
        JOIN questions q ON q.id = sq.question_id
        WHERE sq.section_id = ?
      `).get(s.id);
      secQuestions = qRow ? qRow.count : 0;
      secMarks = qRow ? qRow.total_marks : 0;
    } else {
      const rules = db.prepare('SELECT count, marks_per_question FROM exam_question_rules WHERE section_id = ?').all(s.id);
      for (const r of rules) {
        secQuestions += r.count;
        secMarks += r.count * (r.marks_per_question || 1);
      }
    }

    db.prepare('UPDATE exam_sections SET total_questions = ?, total_marks = ? WHERE id = ?').run(secQuestions, secMarks, s.id);
    grandTotalQuestions += secQuestions;
    grandTotalMarks += secMarks;
  }

  db.prepare(`
    UPDATE exams
    SET total_marks = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(grandTotalMarks, examId);
}

/**
 * Comprehensive pre-publish validation.
 * Verifies completeness, satisfiability of question pools, duration, and scholarship rules.
 */
function validateExamForPublish(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw new NotFoundError(`Exam ${examId} not found`);

  const errors = [];

  if (!exam.name || exam.name.trim().length < 3) errors.push('Exam name must be at least 3 characters');
  if (!exam.code || exam.code.trim().length < 3) errors.push('Exam code must be at least 3 characters');
  if (!exam.duration_minutes || exam.duration_minutes <= 0) errors.push('Exam duration must be greater than 0 minutes');
  if (!exam.max_attempts || exam.max_attempts < 1) errors.push('Max attempts must be at least 1');

  const sections = db.prepare(`
    SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY display_order ASC
  `).all(examId);

  if (sections.length === 0) {
    errors.push('Exam must contain at least one section before publishing');
  }

  let totalQuestions = 0;
  let totalMarks = 0;

  for (const s of sections) {
    if (s.question_selection_mode === 'MANUAL') {
      const qs = db.prepare(`
        SELECT q.id, q.status, q.marks
        FROM exam_section_questions sq
        JOIN questions q ON q.id = sq.question_id
        WHERE sq.section_id = ?
      `).all(s.id);

      if (qs.length === 0) {
        errors.push(`Section "${s.name}" is set to MANUAL selection but has no questions attached`);
      }

      for (const q of qs) {
        if (q.status !== 'PUBLISHED') {
          errors.push(`Question #${q.id} in section "${s.name}" is ${q.status}; all questions must be PUBLISHED`);
        }
        totalMarks += q.marks;
      }
      totalQuestions += qs.length;
    } else {
      const rules = db.prepare('SELECT * FROM exam_question_rules WHERE section_id = ?').all(s.id);
      if (rules.length === 0) {
        errors.push(`Section "${s.name}" has no question selection rules configured`);
      }

      for (const r of rules) {
        // Build question pool query to check satisfiability
        const where = ["status = 'PUBLISHED'"];
        const params = [];

        if (exam.organization_id) {
          where.push('(organization_id = ? OR organization_id IS NULL)');
          params.push(exam.organization_id);
        }

        if (r.type) {
          const t = r.type.toLowerCase();
          if (t === 'coding' || t === 'code') {
            where.push("type IN ('code', 'coding')");
          } else if (t === 'mcq') {
            where.push("type COLLATE NOCASE = 'mcq'");
          } else {
            where.push('type COLLATE NOCASE = ?');
            params.push(r.type);
          }
        }
        if (r.category) {
          where.push('category COLLATE NOCASE = ?');
          params.push(r.category);
        }
        if (r.difficulty) {
          where.push('difficulty COLLATE NOCASE = ?');
          params.push(r.difficulty);
        }
        if (r.topic) {
          where.push('topic COLLATE NOCASE = ?');
          params.push(r.topic);
        }
        if (r.skill) {
          where.push('skill COLLATE NOCASE = ?');
          params.push(r.skill);
        }

        const poolRow = db.prepare(`
          SELECT count(*) as count FROM questions WHERE ${where.join(' AND ')}
        `).get(...params);

        const available = poolRow ? poolRow.count : 0;
        if (available < r.count) {
          errors.push(
            `Section "${s.name}" rule requires ${r.count} questions (${r.type || 'ANY'} ${r.category || ''} ${r.difficulty || ''}), but only ${available} published questions are available in the pool`
          );
        }

        totalQuestions += r.count;
        totalMarks += r.count * (r.marks_per_question || 1);
      }
    }
  }

  if (totalQuestions <= 0) errors.push('Exam must contain at least 1 question across its sections');
  if (totalMarks <= 0) errors.push('Exam total marks must be greater than 0');

  if (exam.passing_score > totalMarks && exam.passing_score > 100) {
    errors.push(`Passing score (${exam.passing_score}) exceeds total possible marks (${totalMarks})`);
  }

  const slabs = db.prepare('SELECT * FROM exam_scholarship_slabs WHERE exam_id = ?').all(examId);
  if (slabs.length === 0) {
    errors.push('Exam must define at least one scholarship slab');
  }

  if (errors.length > 0) {
    const err = new ValidationError('Exam cannot be published due to validation errors', errors);
    err.details = errors;
    throw err;
  }

  return {
    valid: true,
    totalQuestions,
    totalMarks,
    sectionsCount: sections.length
  };
}

/**
 * State machine transition for exams.
 * Validates allowed state transitions and records audit events.
 */
function transitionExamStatus(examId, targetStatus, user, req = null) {
  const exam = getExamById(examId, user);
  const currentStatus = exam.status;
  const target = targetStatus.toUpperCase();

  if (currentStatus === target) {
    if (target === 'PUBLISHED') throw new ConflictError('Exam is already published');
    if (target === 'ARCHIVED') throw new ConflictError('Exam is already archived');
    return exam;
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(target)) {
    throw new ConflictError(
      `Cannot transition exam status from "${currentStatus}" to "${target}".`,
      'INVALID_EXAM_STATUS_TRANSITION'
    );
  }

  if (target === 'PUBLISHED' || target === 'LIVE') {
    const validation = validateExamForPublish(examId, user);
    if (!validation.valid && validation.errors && validation.errors.length) {
      throw new ValidationError(`Cannot publish exam: ${validation.errors.join('; ')}`);
    }
  }

  const updates = ['status = ?', 'updated_by = ?', "updated_at = datetime('now')"];
  const params = [target, user.id];

  if ((target === 'PUBLISHED' || target === 'LIVE') && !exam.published_at) {
    updates.push("published_at = datetime('now')");
  }
  if (target === 'CLOSED') {
    updates.push("closed_at = datetime('now')");
  }

  params.push(examId);

  db.prepare(`UPDATE exams SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: `exam_${target.toLowerCase()}`,
    details: { examId, previousStatus: currentStatus, newStatus: target }
  });

  return getExamById(examId, user);
}

/**
 * Publish an exam atomically.
 */
function publishExam(examId, user, req = null) {
  return transitionExamStatus(examId, 'PUBLISHED', user, req);
}

/**
 * Set a published exam to LIVE (actively accepting candidate attempts).
 */
function makeExamLive(examId, user, req = null) {
  return transitionExamStatus(examId, 'LIVE', user, req);
}

/**
 * Close an active exam (no new candidate attempts allowed; existing attempts remain reproducible).
 */
function closeExam(examId, user, req = null) {
  return transitionExamStatus(examId, 'CLOSED', user, req);
}

/**
 * Transition exam to REVIEW status.
 */
function reviewExam(examId, user, req = null) {
  return transitionExamStatus(examId, 'REVIEW', user, req);
}

/**
 * Archive an exam (soft retiring).
 */
function archiveExam(examId, user, req = null) {
  return transitionExamStatus(examId, 'ARCHIVED', user, req);
}

/**
 * Create a new DRAFT version from an existing PUBLISHED, LIVE, CLOSED, or ARCHIVED exam.
 */
function createExamVersion(examId, user, req = null) {
  const exam = getExamById(examId, user);

  const newVersion = exam.version + 1;
  const rootId = exam.parent_exam_id || exam.id;
  const baseCode = exam.code.replace(/-V\d+$/i, '');
  const newCode = `${baseCode}-V${newVersion}`;

  let createdId;
  const tx = db.transaction(() => {
    const ins = db.prepare(`
      INSERT INTO exams (
        organization_id, parent_exam_id, name, code, description, status, version,
        duration_minutes, total_marks, passing_score, max_attempts,
        shuffle_questions, shuffle_options, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = ins.run(
      exam.organization_id,
      rootId,
      `${exam.name.replace(/\s*\(v\d+\)$/i, '')} (v${newVersion})`,
      newCode,
      exam.description,
      newVersion,
      exam.duration_minutes,
      exam.total_marks,
      exam.passing_score,
      exam.max_attempts,
      exam.shuffle_questions,
      exam.shuffle_options,
      user.id,
      user.id
    );
    createdId = res.lastInsertRowid;

    // Clone sections
    for (const s of exam.sections) {
      const insSec = db.prepare(`
        INSERT INTO exam_sections (exam_id, name, description, display_order, question_selection_mode, total_questions, total_marks)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(createdId, s.name, s.description, s.display_order, s.question_selection_mode, s.total_questions, s.total_marks);
      const newSecId = insSec.lastInsertRowid;

      if (s.question_selection_mode === 'MANUAL' && s.questions) {
        const insQ = db.prepare('INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (?, ?, ?)');
        for (const q of s.questions) {
          insQ.run(newSecId, q.id, q.display_order || 0);
        }
      } else if (s.rules) {
        const insR = db.prepare(`
          INSERT INTO exam_question_rules (section_id, topic, skill, difficulty, type, category, count, marks_per_question)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of s.rules) {
          insR.run(newSecId, r.topic, r.skill, r.difficulty, r.type, r.category, r.count, r.marks_per_question);
        }
      }
    }

    // Clone scholarship slabs
    const insSlab = db.prepare(`
      INSERT INTO exam_scholarship_slabs (exam_id, min_score_pct, max_score_pct, discount_pct, tier_name)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const slab of exam.scholarship_slabs) {
      insSlab.run(createdId, slab.min_score_pct, slab.max_score_pct, slab.discount_pct, slab.tier_name);
    }
  });
  tx();

  recordAuditEvent({
    req,
    userId: user.id,
    organizationId: exam.organization_id,
    event: 'exam_version_created',
    details: { baseExamId: examId, newExamId: createdId, version: newVersion }
  });

  return getExamById(createdId, user);
}

/**
 * Get all versions in an exam lineage / family.
 */
function getExamVersions(examId, user) {
  const currentExam = getExamById(examId, user);
  const rootId = currentExam.parent_exam_id || currentExam.id;

  const where = ['(e.id = ? OR e.parent_exam_id = ? OR e.id = (SELECT parent_exam_id FROM exams WHERE id = ? AND parent_exam_id IS NOT NULL))'];
  const params = [rootId, rootId, currentExam.id];

  if (user && user.role !== ROLES.SUPER_ADMIN) {
    if (user.organization_id) {
      where.push('(e.organization_id = ? OR e.organization_id IS NULL)');
      params.push(user.organization_id);
    } else {
      where.push('e.organization_id IS NULL');
    }
  }

  const rows = db.prepare(`
    SELECT e.*,
           o.name as organization_name,
           (SELECT count(*) FROM exam_sections s WHERE s.exam_id = e.id) as section_count,
           (SELECT count(*) FROM attempts a WHERE a.exam_id = e.id) as attempt_count
    FROM exams e
    LEFT JOIN organizations o ON o.id = e.organization_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.version ASC
  `).all(...params);

  return rows;
}

/**
 * Generate candidate attempt questions from an exam's sections and selection rules.
 * Builds and freezes immutable snapshots of questions, exam configuration, and deterministic shuffle map.
 */
function generateExamAttemptQuestions(examId, judge0Available = true) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) throw new NotFoundError('Target exam not found');
  if (exam.status === 'CLOSED') {
    throw new ConflictError('This exam is closed for new attempts.', 'EXAM_CLOSED');
  }
  if (exam.status === 'ARCHIVED') {
    throw new ConflictError('This exam has been archived and cannot accept new attempts.', 'EXAM_CLOSED');
  }
  if (exam.status !== 'PUBLISHED' && exam.status !== 'LIVE') {
    throw new ValidationError('Cannot attempt an unpublished exam', 'EXAM_NOT_LIVE');
  }

  const sections = db.prepare(`
    SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY display_order ASC, id ASC
  `).all(examId);

  const selectedQuestions = [];
  const questionPoolMap = new Map();

  for (const s of sections) {
    if (s.question_selection_mode === 'MANUAL') {
      const qrows = db.prepare(`
        SELECT q.*, sq.display_order as sec_order
        FROM exam_section_questions sq
        JOIN questions q ON q.id = sq.question_id
        WHERE sq.section_id = ? AND (q.status = 'PUBLISHED' OR q.status IS NULL)
        ORDER BY sq.display_order ASC
      `).all(s.id);

      for (const q of qrows) {
        if (!judge0Available && q.type === 'code') continue;
        const qCopy = { ...q, section_id: s.id };
        selectedQuestions.push(qCopy);
        questionPoolMap.set(q.id, qCopy);
      }
    } else {
      const rules = db.prepare('SELECT * FROM exam_question_rules WHERE section_id = ?').all(s.id);
      for (const r of rules) {
        const where = ["(status = 'PUBLISHED' OR status IS NULL)"];
        const params = [];

        if (exam.organization_id) {
          where.push('(organization_id = ? OR organization_id IS NULL)');
          params.push(exam.organization_id);
        }
        if (r.type) {
          const t = r.type.toLowerCase();
          if (t === 'coding' || t === 'code') {
            where.push("type IN ('code', 'coding')");
          } else if (t === 'mcq') {
            where.push("type COLLATE NOCASE = 'mcq'");
          } else {
            where.push('type COLLATE NOCASE = ?');
            params.push(r.type);
          }
        }
        if (r.category) {
          where.push('category COLLATE NOCASE = ?');
          params.push(r.category);
        }
        if (r.difficulty) {
          where.push('difficulty COLLATE NOCASE = ?');
          params.push(r.difficulty);
        }
        if (r.topic) {
          where.push('topic COLLATE NOCASE = ?');
          params.push(r.topic);
        }
        if (r.skill) {
          where.push('skill COLLATE NOCASE = ?');
          params.push(r.skill);
        }

        let ruleCount = r.count;
        if (exam.code === 'ASPIRE-SCHOLARSHIP-2026' && r.category) {
          try {
            const { getConfig } = require('../db');
            const cfg = getConfig();
            const qKey = `quota_${r.category.toLowerCase()}`;
            if (cfg && cfg[qKey] !== undefined) {
              ruleCount = Math.max(0, parseInt(cfg[qKey], 10) || 0);
            }
          } catch {}
        }
        if (ruleCount <= 0) continue;

        const candidateQuestions = db.prepare(`SELECT * FROM questions WHERE ${where.join(' AND ')}`).all(...params);
        const filtered = candidateQuestions.filter(q => judge0Available || q.type !== 'code');
        const sampled = shuffle(filtered).slice(0, Math.min(ruleCount, filtered.length));

        for (const q of sampled) {
          const qCopy = { ...q, section_id: s.id };
          selectedQuestions.push(qCopy);
          questionPoolMap.set(q.id, qCopy);
        }
      }
    }
  }

  if (selectedQuestions.length === 0) {
    throw new AppError('Question bank pool is empty for this exam configuration', 500, 'QUESTION_BANK_EMPTY');
  }

  // Generate deterministic shuffle seed and maps
  const shuffleSeed = shuffleService.generateSeed();
  const shuffleMap = shuffleService.generateShuffleMap({
    questions: selectedQuestions,
    shuffleQuestions: exam.shuffle_questions !== 0,
    shuffleOptions: exam.shuffle_options !== 0,
    seed: shuffleSeed
  });

  const orderedIds = shuffleMap.questions;
  const orderedQuestions = orderedIds.map(id => questionPoolMap.get(id)).filter(Boolean);

  // Build immutable question snapshots with answers preserved for server grading
  const frozenQuestions = snapshotService.createQuestionSnapshots(orderedQuestions, shuffleMap);

  // Frozen Exam Blueprint Snapshot
  const slabs = db.prepare('SELECT * FROM exam_scholarship_slabs WHERE exam_id = ? ORDER BY min_score_pct DESC').all(examId);
  const examSnapshot = snapshotService.createExamSnapshot(exam, sections, slabs);

  // Cryptographic snapshot integrity hash (tamper detection)
  const snapshotHash = snapshotService.computeSnapshotHash(examSnapshot, frozenQuestions, shuffleMap);

  return {
    orderedIds,
    shuffleMaps: shuffleMap.options,
    shuffleSeed,
    shuffleMap,
    frozenQuestions,
    examSnapshot,
    snapshotHash,
    durationMinutes: exam.duration_minutes
  };
}

module.exports = {
  listExams,
  getExamById,
  getExamByCode,
  getDefaultPublishedExam,
  createExam,
  updateExam,
  addSection,
  updateSection,
  deleteSection,
  reorderSections,
  addQuestionToSection,
  removeQuestionFromSection,
  addRuleToSection,
  removeRuleFromSection,
  setScholarshipSlabs,
  validateExamForPublish,
  transitionExamStatus,
  publishExam,
  makeExamLive,
  closeExam,
  reviewExam,
  archiveExam,
  createExamVersion,
  getExamVersions,
  generateExamAttemptQuestions,
  recalculateExamTotals,
  assertExamMutable
};
