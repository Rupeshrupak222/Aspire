// Backward-compatible Judge0 adapter layer for Aspire.
// Adapts calls to the unified Code Execution Engine (OnlineCompiler / Judge0).
// Ensures zero regression for Day 1-8 tests while empowering Day 9 OnlineCompiler integration.

const { executionService } = require('./code-execution/execution.service');
const { EXECUTION_STATUS } = require('./code-execution/constants');

function isConfigured() {
  return executionService.isConfigured();
}

function status() {
  const active = executionService.getActiveProvider();
  if (!active || !executionService.isConfigured()) {
    return {
      configured: false,
      mode: 'disabled',
      endpoint: null
    };
  }
  return active.getStatus();
}

// Run one submission, wait for the verdict.
async function runSubmission({ source_code, language_id, stdin = '', expected_output = '', timeoutMs = 15000 }) {
  const r = await executionService.executeSingleTest({
    language: language_id || 'python',
    sourceCode: source_code,
    stdin,
    expectedOutput: expected_output,
    timeoutMs
  });

  return {
    accepted: r.status === EXECUTION_STATUS.ACCEPTED,
    statusDescription: r.status,
    stdout: r.stdout,
    stderr: r.stderr || r.compileOutput || '',
    time: r.executionTimeMs ? (r.executionTimeMs / 1000).toFixed(3) : null
  };
}

// Grade one code question against its hidden test cases.
async function gradeCodeQuestion({ source_code, language_id = 71, language, test_cases = [] }) {
  return executionService.gradeCodeQuestion({
    source_code,
    language_id,
    language,
    test_cases
  });
}

module.exports = {
  isConfigured,
  status,
  runSubmission,
  gradeCodeQuestion
};
