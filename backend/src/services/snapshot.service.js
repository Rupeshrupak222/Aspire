// Snapshot Service for Aspire.
// Guarantees immutable assessment execution records, tamper detection via cryptographic hashes,
// and airtight question sanitization ensuring zero candidate leakage of answers or hidden tests.

const crypto = require('crypto');
const { ConflictError } = require('../errors/app-error');

/**
 * Compute SHA-256 cryptographic hash of exam snapshot, questions snapshot, and shuffle map.
 * Detects any live mutation or unauthorized alteration of historical attempts.
 *
 * @param {string|object} examSnapshot
 * @param {string|object} questionsSnapshot
 * @param {string|object} shuffleMap
 * @returns {string} SHA-256 hex digest
 */
function computeSnapshotHash(examSnapshot, questionsSnapshot, shuffleMap) {
  const eStr = typeof examSnapshot === 'string' ? examSnapshot : JSON.stringify(examSnapshot || {});
  const qStr = typeof questionsSnapshot === 'string' ? questionsSnapshot : JSON.stringify(questionsSnapshot || []);
  const sStr = typeof shuffleMap === 'string' ? shuffleMap : JSON.stringify(shuffleMap || {});

  return crypto.createHash('sha256')
    .update(eStr)
    .update('::')
    .update(qStr)
    .update('::')
    .update(sStr)
    .digest('hex');
}

/**
 * Verifies that the attempt's snapshots match their recorded cryptographic hash.
 *
 * @param {Object} attempt
 * @throws {ConflictError} if tampering or mismatch is detected
 */
function verifySnapshotIntegrity(attempt) {
  if (!attempt || !attempt.snapshot_hash) return true; // legacy attempts without hash pass

  const expectedHash = computeSnapshotHash(
    attempt.exam_snapshot_json,
    attempt.questions_snapshot_json,
    attempt.shuffle_map_json
  );

  if (attempt.snapshot_hash !== expectedHash) {
    throw new ConflictError(
      'Attempt snapshot integrity verification failed. Assessment record has been tampered with.',
      'SNAPSHOT_INTEGRITY_FAILURE'
    );
  }

  return true;
}

/**
 * Assemble and freeze an immutable exam blueprint snapshot.
 *
 * @param {Object} exam
 * @param {Array} [sections=[]]
 * @param {Array} [slabs=[]]
 * @returns {Object} frozen exam snapshot object
 */
function createExamSnapshot(exam, sections = [], slabs = []) {
  return {
    id: exam.id,
    version: exam.version || 1,
    name: exam.name,
    code: exam.code,
    description: exam.description || null,
    duration_minutes: exam.duration_minutes || 90,
    total_marks: exam.total_marks || 0,
    passing_score: exam.passing_score || 40,
    max_attempts: exam.max_attempts || 1,
    shuffle_questions: exam.shuffle_questions !== 0 ? 1 : 0,
    shuffle_options: exam.shuffle_options !== 0 ? 1 : 0,
    sections: (sections || []).map(s => ({
      id: s.id,
      name: s.name,
      description: s.description || null,
      display_order: s.display_order,
      question_selection_mode: s.question_selection_mode,
      total_questions: s.total_questions || 0,
      total_marks: s.total_marks || 0
    })),
    scholarship_slabs: (slabs || []).map(s => ({
      min_score_pct: s.min_score_pct,
      max_score_pct: s.max_score_pct,
      discount_pct: s.discount_pct,
      tier_name: s.tier_name || null
    }))
  };
}

/**
 * Assemble and freeze questions snapshot for an attempt.
 * Retains authoritative grading data (correct_index, hidden test cases, negative marks)
 * inside the server-side frozen snapshot.
 *
 * @param {Array} questionsWithPool
 * @param {Object} shuffleMap
 * @returns {Array} frozen questions list
 */
function createQuestionSnapshots(questionsWithPool, shuffleMap = {}) {
  const frozen = [];

  for (const q of questionsWithPool) {
    const isCode = q.type === 'code' || q.type === 'CODING';
    const snap = {
      id: q.id,
      version: q.version || 1,
      type: isCode ? 'code' : 'mcq',
      category: q.category || 'general',
      title: q.title || null,
      question_text: q.question_text,
      marks: q.marks !== undefined ? q.marks : 1,
      negative_marks: q.negative_marks !== undefined ? q.negative_marks : 0,
      section_id: q.section_id || null
    };

    if (snap.type === 'mcq') {
      let rawOpts = [];
      if (Array.isArray(q.options)) {
        rawOpts = q.options;
      } else if (typeof q.options_json === 'string') {
        try { rawOpts = JSON.parse(q.options_json); } catch {}
      }

      // If shuffle map specifies option order, apply it to frozen snapshot
      const optPerm = (shuffleMap.options && (shuffleMap.options[q.id] || shuffleMap.options[String(q.id)])) || null;
      if (optPerm && Array.isArray(optPerm) && optPerm.length === rawOpts.length) {
        snap.options = optPerm.map(i => rawOpts[i]);
      } else {
        snap.options = rawOpts.slice();
      }

      snap.correct_index = q.correct_index; // Preserved for server-authoritative grading
    } else {
      snap.code_starter = q.code_starter || '';
      snap.language_id = q.language_id || 71;
      snap.language = q.language || 'python';

      // Full test cases for code execution engine
      let rawTcs = [];
      if (Array.isArray(q.test_cases)) {
        rawTcs = q.test_cases;
      } else if (typeof q.test_cases_json === 'string') {
        try { rawTcs = JSON.parse(q.test_cases_json); } catch {}
      }
      snap.test_cases = rawTcs;
    }

    frozen.push(snap);
  }

  return frozen;
}

/**
 * Air-tight question sanitization for candidate client delivery.
 * STRIPS:
 * - correct_index
 * - answer_key
 * - hidden test cases
 * - private evaluator logic / solutions
 * - admin notes
 *
 * @param {Array} frozenQuestions
 * @returns {Array} sanitized questions safe to send over HTTP to candidate
 */
function sanitizeCandidateQuestions(frozenQuestions) {
  if (!Array.isArray(frozenQuestions)) return [];

  return frozenQuestions.map(q => {
    const isCode = q.type === 'code' || q.type === 'CODING';
    const out = {
      id: q.id,
      type: isCode ? 'code' : 'mcq',
      category: q.category || 'general',
      title: q.title || null,
      question_text: q.question_text,
      marks: q.marks !== undefined ? q.marks : 1,
      negative_marks: q.negative_marks !== undefined ? q.negative_marks : 0,
      section_id: q.section_id || null
    };

    if (out.type === 'mcq') {
      out.options = Array.isArray(q.options) ? q.options.slice() : [];
      // STRICT: correct_index is NEVER included
    } else {
      out.code_starter = q.code_starter || '';
      out.language_id = q.language_id || 71;
      out.language = q.language || 'python';

      // STRICT: Only public / sample test cases are delivered to candidate browser
      if (Array.isArray(q.test_cases)) {
        out.sample_test_cases = q.test_cases
          .filter(tc => !tc.is_hidden && !tc.hidden)
          .map(tc => ({
            input: tc.input,
            expected_output: tc.expected_output !== undefined ? tc.expected_output : tc.expected
          }));
      } else {
        out.sample_test_cases = [];
      }
      // STRICT: hidden test cases and complete test_cases array are NEVER sent
    }

    return out;
  });
}

module.exports = {
  computeSnapshotHash,
  verifySnapshotIntegrity,
  createExamSnapshot,
  createQuestionSnapshots,
  sanitizeCandidateQuestions
};
