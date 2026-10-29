// Constants, execution statuses, and language mapping for Code Execution Engine

const EXECUTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  ACCEPTED: 'ACCEPTED',
  WRONG_ANSWER: 'WRONG_ANSWER',
  COMPILATION_ERROR: 'COMPILATION_ERROR',
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  TIME_LIMIT_EXCEEDED: 'TIME_LIMIT_EXCEEDED',
  MEMORY_LIMIT_EXCEEDED: 'MEMORY_LIMIT_EXCEEDED',
  EMPTY_SUBMISSION: 'EMPTY_SUBMISSION',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  PROVIDER_ERROR: 'PROVIDER_ERROR'
});

const CANONICAL_LANGUAGES = Object.freeze({
  PYTHON: 'python',
  JAVASCRIPT: 'javascript',
  CPP: 'cpp',
  JAVA: 'java'
});

// Mapping from canonical language to OnlineCompiler.io compiler identifiers
const ONLINECOMPILER_LANGUAGE_MAP = Object.freeze({
  [CANONICAL_LANGUAGES.PYTHON]: 'python-3.14',
  [CANONICAL_LANGUAGES.JAVASCRIPT]: 'nodejs-24',
  [CANONICAL_LANGUAGES.CPP]: 'g++-15',
  [CANONICAL_LANGUAGES.JAVA]: 'openjdk-25'
});

// Mapping from canonical language to Judge0 language IDs
const JUDGE0_LANGUAGE_MAP = Object.freeze({
  [CANONICAL_LANGUAGES.PYTHON]: 71,
  [CANONICAL_LANGUAGES.JAVASCRIPT]: 63,
  [CANONICAL_LANGUAGES.CPP]: 54,
  [CANONICAL_LANGUAGES.JAVA]: 62
});

// Normalized language alias resolver
const LANGUAGE_ALIASES = Object.freeze({
  // Python
  python: CANONICAL_LANGUAGES.PYTHON,
  python3: CANONICAL_LANGUAGES.PYTHON,
  py: CANONICAL_LANGUAGES.PYTHON,
  py3: CANONICAL_LANGUAGES.PYTHON,
  'python-3.14': CANONICAL_LANGUAGES.PYTHON,
  '71': CANONICAL_LANGUAGES.PYTHON,

  // JavaScript
  javascript: CANONICAL_LANGUAGES.JAVASCRIPT,
  js: CANONICAL_LANGUAGES.JAVASCRIPT,
  node: CANONICAL_LANGUAGES.JAVASCRIPT,
  nodejs: CANONICAL_LANGUAGES.JAVASCRIPT,
  'nodejs-24': CANONICAL_LANGUAGES.JAVASCRIPT,
  '63': CANONICAL_LANGUAGES.JAVASCRIPT,

  // C++
  cpp: CANONICAL_LANGUAGES.CPP,
  'c++': CANONICAL_LANGUAGES.CPP,
  'c-plus-plus': CANONICAL_LANGUAGES.CPP,
  'g++': CANONICAL_LANGUAGES.CPP,
  gcc: CANONICAL_LANGUAGES.CPP,
  'g++-15': CANONICAL_LANGUAGES.CPP,
  '54': CANONICAL_LANGUAGES.CPP,

  // Java
  java: CANONICAL_LANGUAGES.JAVA,
  openjdk: CANONICAL_LANGUAGES.JAVA,
  'openjdk-25': CANONICAL_LANGUAGES.JAVA,
  '62': CANONICAL_LANGUAGES.JAVA
});

/**
 * Normalizes user-supplied language string or id into canonical language name.
 * Throws ValidationError if language is not supported.
 */
function normalizeLanguage(input) {
  if (input === undefined || input === null || (typeof input === 'string' && !input.trim())) {
    const { ValidationError } = require('../../errors/app-error');
    throw new ValidationError('UNSUPPORTED_LANGUAGE: Language is required', 'UNSUPPORTED_LANGUAGE');
  }

  const clean = String(input).trim().toLowerCase();
  const canonical = LANGUAGE_ALIASES[clean];
  if (!canonical) {
    const { ValidationError } = require('../../errors/app-error');
    throw new ValidationError(`UNSUPPORTED_LANGUAGE: Unsupported language '${input}'. Supported languages are python, javascript, cpp, java.`, 'UNSUPPORTED_LANGUAGE');
  }
  return canonical;
}

const SUBMISSION_LIFECYCLE = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  RETRYING: 'RETRYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

const LEGAL_LIFECYCLE_TRANSITIONS = Object.freeze({
  [SUBMISSION_LIFECYCLE.QUEUED]: [SUBMISSION_LIFECYCLE.RUNNING, SUBMISSION_LIFECYCLE.CANCELLED, SUBMISSION_LIFECYCLE.FAILED],
  [SUBMISSION_LIFECYCLE.RUNNING]: [SUBMISSION_LIFECYCLE.COMPLETED, SUBMISSION_LIFECYCLE.RETRYING, SUBMISSION_LIFECYCLE.FAILED, SUBMISSION_LIFECYCLE.CANCELLED],
  [SUBMISSION_LIFECYCLE.RETRYING]: [SUBMISSION_LIFECYCLE.RUNNING, SUBMISSION_LIFECYCLE.FAILED, SUBMISSION_LIFECYCLE.CANCELLED],
  [SUBMISSION_LIFECYCLE.COMPLETED]: [], // Terminal
  [SUBMISSION_LIFECYCLE.FAILED]: [],    // Terminal
  [SUBMISSION_LIFECYCLE.CANCELLED]: []  // Terminal
});

const OUTBOX_STATUS = Object.freeze({
  PENDING: 'PENDING',
  DISPATCHED: 'DISPATCHED',
  FAILED: 'FAILED'
});

const LIMITS = Object.freeze({
  MAX_SOURCE_BYTES: 100 * 1024,      // 100 KB
  MAX_STDIN_BYTES: 100 * 1024,       // 100 KB
  MAX_OUTPUT_BYTES: 100 * 1024,      // 100 KB
  MAX_RESPONSE_BYTES: 512 * 1024,    // 512 KB
  DEFAULT_TIMEOUT_MS: 10000,         // 10 seconds per test
  MAX_TIMEOUT_MS: 30000              // 30 seconds max
});

module.exports = {
  EXECUTION_STATUS,
  SUBMISSION_LIFECYCLE,
  LEGAL_LIFECYCLE_TRANSITIONS,
  OUTBOX_STATUS,
  CANONICAL_LANGUAGES,
  ONLINECOMPILER_LANGUAGE_MAP,
  JUDGE0_LANGUAGE_MAP,
  normalizeLanguage,
  LIMITS
};

