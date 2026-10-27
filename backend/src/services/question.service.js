// Question Bank 2.0 Service Layer
// Handles metadata, lifecycle, search, filtering, pagination, duplicate detection,
// bulk import/export, preview, version awareness, and multi-tenant isolation.

const Papa = require('papaparse');
const Fuse = require('fuse.js');
const { db } = require('../db');
const { ROLES } = require('../security/rbac');
const { NotFoundError, ValidationError, AuthorizationError, ConflictError } = require('../errors/app-error');

const VALID_STATUSES = ['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'];
const VALID_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const VALID_TYPES = ['mcq', 'code'];
const VALID_CATEGORIES = ['aptitude', 'technical', 'coding'];

// Lifecycle state transitions table
const ALLOWED_TRANSITIONS = {
  DRAFT: ['REVIEW', 'PUBLISHED', 'ARCHIVED'],
  REVIEW: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED', 'REVIEW'],
  ARCHIVED: ['DRAFT', 'REVIEW']
};

/**
 * Text normalization for consistent comparison and duplicate detection
 */
function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize tags array: lowercased, trimmed, unique strings
 */
function normalizeTags(tags) {
  if (!tags) return [];
  let arr = [];
  if (Array.isArray(tags)) {
    arr = tags;
  } else if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) arr = parsed;
      else arr = tags.split(/[,;]/);
    } catch {
      arr = tags.split(/[,;]/);
    }
  }
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Publish validation: strict rules required before a question can be PUBLISHED
 */
function validateForPublish(q) {
  if (!q.question_text || !q.question_text.trim()) {
    throw new ValidationError('Question text cannot be empty for published questions');
  }

  const marks = Number(q.marks);
  if (!Number.isFinite(marks) || marks <= 0) {
    throw new ValidationError('Marks must be a positive number');
  }

  if (q.type === 'mcq') {
    let opts = q.options;
    if (typeof opts === 'string') {
      try { opts = JSON.parse(opts); } catch { opts = []; }
    }
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 6) {
      throw new ValidationError('Published MCQ questions must have between 2 and 6 options');
    }
    for (const opt of opts) {
      if (!opt || !String(opt).trim()) {
        throw new ValidationError('MCQ options cannot be empty strings');
      }
    }
    const idx = Number(q.correct_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) {
      throw new ValidationError('Published MCQ questions must specify a valid correct_index within the options range');
    }
  } else if (q.type === 'code') {
    let testCases = q.test_cases;
    if (typeof testCases === 'string') {
      try { testCases = JSON.parse(testCases); } catch { testCases = []; }
    }
    if (!Array.isArray(testCases) || testCases.length === 0) {
      throw new ValidationError('Published code questions must have at least one test case');
    }
    for (const tc of testCases) {
      if (!tc || typeof tc.input === 'undefined' || typeof tc.expected === 'undefined') {
        throw new ValidationError('Each code test case must define input and expected output');
      }
    }
  }
}

/**
 * Find exact and fuzzy duplicates
 */
function findDuplicates({ question_text, type, organization_id, excludeId = null, threshold = 0.3 }) {
  const normTarget = normalizeText(question_text);
  if (!normTarget) return { exactDuplicate: false, matches: [] };

  // Fetch candidate pool within organization scope
  let sql = 'SELECT id, title, question_text, type, category, status FROM questions WHERE 1=1';
  const params = [];

  if (organization_id !== undefined && organization_id !== null) {
    sql += ' AND (organization_id = ? OR organization_id IS NULL)';
    params.push(organization_id);
  }
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }

  const pool = db.prepare(sql).all(...params);

  let exactMatch = null;
  const normalizedPool = pool.map((q) => {
    const norm = normalizeText(q.question_text);
    if (!exactMatch && norm === normTarget) {
      exactMatch = q;
    }
    return {
      ...q,
      normText: norm
    };
  });

  // Fuzzy search using Fuse.js
  const fuse = new Fuse(normalizedPool, {
    keys: ['normText', 'title'],
    threshold,
    includeScore: true
  });

  const fuzzyResults = fuse.search(normTarget).slice(0, 5).map((r) => ({
    id: r.item.id,
    title: r.item.title,
    question_text: r.item.question_text.slice(0, 100),
    type: r.item.type,
    category: r.item.category,
    status: r.item.status,
    similarity: Math.round((1 - r.score) * 100) / 100
  }));

  return {
    exactDuplicate: !!exactMatch,
    exactMatch: exactMatch ? { id: exactMatch.id, title: exactMatch.title } : null,
    matches: fuzzyResults
  };
}

/**
 * List questions with search, filtering, sorting, and pagination
 */
function listQuestions({ user, query = {} }) {
  const isSuperAdmin = user.role === ROLES.SUPER_ADMIN;

  let whereClauses = [];
  const params = [];

  // Tenant Scoping
  if (isSuperAdmin) {
    if (query.organization_id !== undefined) {
      whereClauses.push('organization_id = ?');
      params.push(query.organization_id);
    }
  } else {
    whereClauses.push('(organization_id = ? OR organization_id IS NULL)');
    params.push(user.organization_id);
  }

  // Filters
  if (query.status && query.status !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(query.status.toUpperCase());
  }

  if (query.difficulty && query.difficulty !== 'ALL') {
    whereClauses.push('difficulty = ?');
    params.push(query.difficulty.toUpperCase());
  }

  if (query.topic && query.topic.trim()) {
    whereClauses.push('topic LIKE ?');
    params.push(`%${query.topic.trim()}%`);
  }

  if (query.skill && query.skill.trim()) {
    whereClauses.push('skill LIKE ?');
    params.push(`%${query.skill.trim()}%`);
  }

  if (query.type && query.type !== 'ALL') {
    whereClauses.push('type = ?');
    params.push(query.type.toLowerCase());
  }

  if (query.category && query.category !== 'ALL') {
    whereClauses.push('category = ?');
    params.push(query.category.toLowerCase());
  }

  // Structured search across title, question_text, topic, skill, tags
  if (query.search && query.search.trim()) {
    const s = `%${query.search.trim()}%`;
    whereClauses.push('(title LIKE ? OR question_text LIKE ? OR topic LIKE ? OR skill LIKE ? OR tags LIKE ?)');
    params.push(s, s, s, s, s);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Safe sorting allowlist
  const allowedSortCols = {
    id: 'id',
    title: 'title',
    created_at: 'created_at',
    updated_at: 'updated_at',
    difficulty: 'difficulty',
    marks: 'marks',
    status: 'status'
  };

  const sortCol = allowedSortCols[query.sort] || 'id';
  const sortDir = (query.order && query.order.toLowerCase() === 'desc') ? 'DESC' : 'ASC';

  // Count total matches
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM questions ${whereSql}`).get(...params);
  const total = countRow ? countRow.total : 0;

  // Pagination determination
  const hasPagination = query.page !== undefined || query.limit !== undefined || query.paginate === 'true';
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  let querySql = `SELECT * FROM questions ${whereSql} ORDER BY ${sortCol} ${sortDir}`;
  const queryParams = [...params];

  if (hasPagination) {
    querySql += ' LIMIT ? OFFSET ?';
    queryParams.push(limit, offset);
  }

  const rows = db.prepare(querySql).all(...queryParams);

  const items = rows.map((r) => ({
    ...r,
    options: r.options_json ? JSON.parse(r.options_json) : null,
    test_cases: r.test_cases_json ? JSON.parse(r.test_cases_json) : null,
    tags: r.tags ? JSON.parse(r.tags) : []
  }));

  if (hasPagination) {
    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  return { items, pagination: null };
}

/**
 * Get single question by ID with tenant security check
 */
function getQuestionById({ id, user }) {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!q) throw new NotFoundError('Question not found');

  // Multi-tenant isolation check
  if (user.role !== ROLES.SUPER_ADMIN) {
    if (q.organization_id !== null && q.organization_id !== user.organization_id) {
      throw new AuthorizationError('Cannot access question belonging to another organization');
    }
  }

  return {
    ...q,
    options: q.options_json ? JSON.parse(q.options_json) : null,
    test_cases: q.test_cases_json ? JSON.parse(q.test_cases_json) : null,
    tags: q.tags ? JSON.parse(q.tags) : []
  };
}

/**
 * Create a new question with validation and server-controlled metadata
 */
function createQuestion({ user, data }) {
  const isSuperAdmin = user.role === ROLES.SUPER_ADMIN;

  const orgId = isSuperAdmin
    ? (data.organization_id !== undefined ? data.organization_id : null)
    : user.organization_id;

  const type = data.type;
  const category = data.category;
  const questionText = data.question_text.trim();
  const title = (data.title && data.title.trim()) || questionText.slice(0, 60);
  const difficulty = data.difficulty || 'MEDIUM';
  const topic = data.topic ? data.topic.trim() : null;
  const skill = data.skill ? data.skill.trim() : null;
  const timeEstimate = parseInt(data.time_estimate, 10) || 120;
  const tags = normalizeTags(data.tags);
  const language = data.language ? data.language.trim().toLowerCase() : (type === 'code' ? 'python' : null);
  const status = data.status || 'DRAFT';
  const marks = Number(data.marks) || 1;
  const isSample = data.is_sample ? 1 : 0;
  const codeStarter = data.code_starter || null;
  const languageId = data.language_id || 71;

  // If publishing immediately, run strict publish validation
  if (status === 'PUBLISHED') {
    validateForPublish({
      type,
      question_text: questionText,
      marks,
      options: data.options,
      correct_index: data.correct_index,
      test_cases: data.test_cases,
      language
    });
  }

  const optionsJson = data.options ? JSON.stringify(data.options) : null;
  const testCasesJson = data.test_cases ? JSON.stringify(data.test_cases) : null;
  const tagsJson = JSON.stringify(tags);

  const r = db.prepare(`
    INSERT INTO questions (
      type, category, title, question_text, difficulty, topic, skill,
      time_estimate, tags, language, version, status,
      options_json, correct_index, code_starter, language_id, test_cases_json,
      marks, is_sample, organization_id, created_by, updated_by
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, 1, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    type, category, title, questionText, difficulty, topic, skill,
    timeEstimate, tagsJson, language, status,
    optionsJson, data.correct_index ?? null, codeStarter, languageId, testCasesJson,
    marks, isSample, orgId, user.id, user.id
  );

  return { id: r.lastInsertRowid, title, status };
}

/**
 * Update existing question with versioning awareness and tenant enforcement
 */
function updateQuestion({ id, user, data }) {
  const cur = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!cur) throw new NotFoundError('Question not found');

  // Tenant Isolation Check
  if (user.role !== ROLES.SUPER_ADMIN) {
    if (cur.organization_id === null) {
      throw new AuthorizationError('Cannot modify platform-level question');
    }
    if (cur.organization_id !== user.organization_id) {
      throw new AuthorizationError('Cannot modify question belonging to another organization');
    }
  }

  const newStatus = data.status ?? cur.status;

  // Check state machine if status is changing
  if (data.status && data.status !== cur.status) {
    const allowed = ALLOWED_TRANSITIONS[cur.status] || [];
    if (!allowed.includes(data.status)) {
      throw new ValidationError(`Invalid status transition from ${cur.status} to ${data.status}`);
    }
  }

  const merged = {
    type: data.type ?? cur.type,
    category: data.category ?? cur.category,
    title: data.title !== undefined ? (data.title ? data.title.trim() : null) : cur.title,
    question_text: data.question_text !== undefined ? data.question_text.trim() : cur.question_text,
    difficulty: data.difficulty ?? cur.difficulty,
    topic: data.topic !== undefined ? (data.topic ? data.topic.trim() : null) : cur.topic,
    skill: data.skill !== undefined ? (data.skill ? data.skill.trim() : null) : cur.skill,
    time_estimate: data.time_estimate !== undefined ? parseInt(data.time_estimate, 10) : cur.time_estimate,
    tags: data.tags !== undefined ? normalizeTags(data.tags) : (cur.tags ? JSON.parse(cur.tags) : []),
    language: data.language !== undefined ? data.language : cur.language,
    status: newStatus,
    options: data.options ?? (cur.options_json ? JSON.parse(cur.options_json) : undefined),
    correct_index: data.correct_index ?? cur.correct_index,
    code_starter: data.code_starter ?? cur.code_starter,
    language_id: data.language_id ?? cur.language_id,
    test_cases: data.test_cases ?? (cur.test_cases_json ? JSON.parse(cur.test_cases_json) : undefined),
    marks: data.marks ?? cur.marks,
    is_sample: data.is_sample !== undefined ? (data.is_sample ? 1 : 0) : cur.is_sample
  };

  // Category <-> Type coupling validation
  if (merged.category === 'coding' && merged.type !== 'code') {
    throw new ValidationError('coding-category questions must be type "code"');
  }
  if (merged.category !== 'coding' && merged.type !== 'mcq') {
    throw new ValidationError(`${merged.category}-category questions must be type "mcq"`);
  }

  // If status is PUBLISHED, enforce strict publish validation
  if (merged.status === 'PUBLISHED') {
    validateForPublish(merged);
  }

  // Versioning protection: If editing a question already used in attempts, increment version
  let newVersion = cur.version || 1;
  const isUsedInAttempts = db.prepare('SELECT 1 FROM attempts WHERE question_ids_json LIKE ? LIMIT 1').get(`%${id}%`);
  if (isUsedInAttempts && cur.status === 'PUBLISHED') {
    newVersion += 1;
  }

  db.prepare(`
    UPDATE questions SET
      type = ?, category = ?, title = ?, question_text = ?, difficulty = ?,
      topic = ?, skill = ?, time_estimate = ?, tags = ?, language = ?,
      version = ?, status = ?, options_json = ?, correct_index = ?,
      code_starter = ?, language_id = ?, test_cases_json = ?, marks = ?,
      is_sample = ?, updated_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.type,
    merged.category,
    merged.title || merged.question_text.slice(0, 60),
    merged.question_text,
    merged.difficulty,
    merged.topic,
    merged.skill,
    merged.time_estimate || 120,
    JSON.stringify(merged.tags),
    merged.language,
    newVersion,
    merged.status,
    merged.options ? JSON.stringify(merged.options) : null,
    merged.correct_index ?? null,
    merged.code_starter,
    merged.language_id,
    merged.test_cases ? JSON.stringify(merged.test_cases) : null,
    merged.marks,
    merged.is_sample,
    user.id,
    id
  );

  return { id, version: newVersion, status: merged.status };
}

/**
 * Publish a question
 */
function publishQuestion({ id, user }) {
  return updateQuestion({ id, user, data: { status: 'PUBLISHED' } });
}

/**
 * Archive a question (soft deletion preserving historical integrity)
 */
function archiveQuestion({ id, user }) {
  return updateQuestion({ id, user, data: { status: 'ARCHIVED' } });
}

/**
 * Bulk CSV Import with preview and transactional execution
 */
function bulkImportCSV({ user, csvContent, dryRun = false }) {
  if (!csvContent || typeof csvContent !== 'string') {
    throw new ValidationError('CSV content is required');
  }

  if (Buffer.byteLength(csvContent, 'utf8') > 5 * 1024 * 1024) {
    throw new ValidationError('CSV file size exceeds 5MB limit');
  }

  const parsed = Papa.parse(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_')
  });

  if (parsed.errors && parsed.errors.length > 0 && parsed.data.length === 0) {
    throw new ValidationError(`Malformed CSV: ${parsed.errors[0].message}`);
  }

  const rows = parsed.data;
  if (rows.length === 0) {
    throw new ValidationError('CSV file contains no question rows');
  }
  if (rows.length > 500) {
    throw new ValidationError('CSV file exceeds 500 questions per batch limit');
  }

  const validatedRows = [];
  const failures = [];
  const warnings = [];
  let duplicateCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const rowNum = idx + 2; // header is row 1
    const raw = rows[idx];

    try {
      const type = (raw.type || 'mcq').toLowerCase().trim();
      if (!VALID_TYPES.includes(type)) {
        throw new Error(`Invalid type "${raw.type}". Must be "mcq" or "code"`);
      }

      let category = (raw.category || (type === 'code' ? 'coding' : 'technical')).toLowerCase().trim();
      if (!VALID_CATEGORIES.includes(category)) {
        category = type === 'code' ? 'coding' : 'technical';
      }

      const questionText = (raw.question_text || raw.question || '').trim();
      if (!questionText) {
        throw new Error('question_text is required');
      }

      const title = (raw.title || '').trim() || questionText.slice(0, 60);
      let difficulty = (raw.difficulty || 'MEDIUM').toUpperCase().trim();
      if (!VALID_DIFFICULTIES.includes(difficulty)) difficulty = 'MEDIUM';

      const topic = (raw.topic || '').trim() || null;
      const skill = (raw.skill || '').trim() || null;
      const marks = Math.max(1, parseFloat(raw.marks) || 1);
      const timeEstimate = parseInt(raw.time_estimate, 10) || 120;
      const tags = normalizeTags(raw.tags);
      const language = (raw.language || (type === 'code' ? 'python' : '')).trim().toLowerCase() || null;
      let status = (raw.status || 'DRAFT').toUpperCase().trim();
      if (!VALID_STATUSES.includes(status)) status = 'DRAFT';

      let options = null;
      let correctIndex = null;
      let codeStarter = null;
      let testCases = null;

      if (type === 'mcq') {
        if (raw.options) {
          try {
            options = JSON.parse(raw.options);
          } catch {
            options = String(raw.options).split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
          }
        }
        if (raw.correct_index !== undefined && raw.correct_index !== '') {
          correctIndex = parseInt(raw.correct_index, 10);
        } else if (raw.correct_answer && Array.isArray(options)) {
          const matchIdx = options.findIndex((o) => o.toLowerCase() === String(raw.correct_answer).toLowerCase().trim());
          if (matchIdx >= 0) correctIndex = matchIdx;
        }
      } else {
        codeStarter = raw.code_starter || null;
        if (raw.test_cases) {
          try {
            testCases = JSON.parse(raw.test_cases);
          } catch {
            testCases = [{ input: raw.test_input || '', expected: raw.test_expected || '' }];
          }
        }
      }

      // Check duplicate within DB
      const dup = findDuplicates({
        question_text: questionText,
        type,
        organization_id: user.role === ROLES.SUPER_ADMIN ? null : user.organization_id
      });

      if (dup.exactDuplicate) {
        duplicateCount++;
        warnings.push({ row: rowNum, message: `Exact duplicate of existing question #${dup.exactMatch.id}` });
      }

      const rowObj = {
        rowNumber: rowNum,
        type,
        category,
        title,
        question_text: questionText,
        difficulty,
        topic,
        skill,
        marks,
        time_estimate: timeEstimate,
        tags,
        language,
        status,
        options,
        correct_index: correctIndex,
        code_starter: codeStarter,
        test_cases: testCases,
        isDuplicate: dup.exactDuplicate
      };

      // If status is PUBLISHED, check publish requirements
      if (status === 'PUBLISHED') {
        validateForPublish(rowObj);
      }

      validatedRows.push(rowObj);
    } catch (err) {
      failures.push({
        row: rowNum,
        error: 'INVALID_ROW',
        message: err.message
      });
    }
  }

  // Dry Run Preview
  if (dryRun) {
    return {
      dryRun: true,
      totalRows: rows.length,
      validCount: validatedRows.length,
      invalidCount: failures.length,
      duplicateCount,
      warnings,
      failures,
      preview: validatedRows.slice(0, 10)
    };
  }

  // Commit valid rows transactionally
  if (validatedRows.length === 0) {
    throw new ValidationError('No valid questions found to import', failures);
  }

  const executeImport = db.transaction(() => {
    let imported = 0;
    for (const q of validatedRows) {
      createQuestion({
        user,
        data: q
      });
      imported++;
    }
    return imported;
  });

  const importedCount = executeImport();

  return {
    success: true,
    totalRows: rows.length,
    importedCount,
    failedCount: failures.length,
    duplicateCount,
    failures
  };
}

/**
 * Bulk CSV Export
 */
function exportQuestionsCSV({ user, query = {} }) {
  // Query without pagination limit
  const { items } = listQuestions({ user, query: { ...query, page: undefined, limit: undefined, paginate: undefined } });

  const exportRows = items.map((q) => ({
    id: q.id,
    type: q.type,
    category: q.category,
    title: q.title || '',
    question_text: q.question_text,
    difficulty: q.difficulty,
    topic: q.topic || '',
    skill: q.skill || '',
    marks: q.marks,
    time_estimate: q.time_estimate,
    tags: Array.isArray(q.tags) ? q.tags.join(';') : '',
    language: q.language || '',
    version: q.version || 1,
    status: q.status,
    options: q.options ? JSON.stringify(q.options) : '',
    correct_index: q.correct_index !== null ? q.correct_index : '',
    code_starter: q.code_starter || '',
    test_cases: q.test_cases ? JSON.stringify(q.test_cases) : '',
    organization_id: q.organization_id || 'PLATFORM'
  }));

  return Papa.unparse(exportRows);
}

module.exports = {
  VALID_STATUSES,
  VALID_DIFFICULTIES,
  VALID_TYPES,
  VALID_CATEGORIES,
  ALLOWED_TRANSITIONS,
  normalizeText,
  normalizeTags,
  validateForPublish,
  findDuplicates,
  listQuestions,
  getQuestionById,
  createQuestion,
  updateQuestion,
  publishQuestion,
  archiveQuestion,
  bulkImportCSV,
  exportQuestionsCSV
};
