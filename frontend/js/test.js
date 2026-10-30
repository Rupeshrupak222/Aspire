// Timed test page: one question at a time, palette nav, auto-submit on timeout.
// Integrates with OnlineCompiler.io Execution Layer (Day 9)
let attempt = null;
let questions = [];
let current = 0;
let answers = {};        // mcq: {qid: selectedOptionIndex}
let codeAnswers = {};    // code: {qid: sourceCode}
let codeLanguages = {};  // code: {qid: language}
let codeResults = {};    // code: {qid: { type: 'run'|'submit', data, error }}
let tabSwitches = 0;
let timerId = null;
let submitted = false;

let draftDebounceTimer = null;

async function init() {
  const token = getToken();
  if (!token) { window.location.href = '/index.html'; return; }
  try {
    attempt = await api(`/api/attempt/${token}`);
  } catch (e) {
    showErr('testErr', e.message);
    return;
  }
  if (attempt.status === 'submitted') {
    sessionStorage.setItem(RESULT_KEY, JSON.stringify(attempt));
    window.location.href = '/result.html';
    return;
  }
  questions = attempt.questions || [];
  tabSwitches = attempt.tab_switches || 0;
  if (!questions.length) { showErr('testErr', 'No questions available. Please contact support.'); return; }

  let localState = null;
  if (window.AssessmentStorage) {
    try {
      localState = await window.AssessmentStorage.init(token);
    } catch (e) {
      console.warn('Failed to initialize AssessmentStorage', e);
    }
  }

  // Restore MCQ answers: reconcile server state with local recovery
  answers = { ...(attempt.answers || {}), ...(localState?.answers || {}) };

  // Restore draft code answers
  questions.forEach(q => {
    if (q.type === 'code') {
      const localCode = localState?.draftCode?.[q.id]?.code;
      const legacyCode = localStorage.getItem(`aspire_code_${token}_${q.id}`);
      const serverCode = attempt.draft_code?.[q.id]?.code;
      if (localCode !== undefined && localCode !== null) {
        codeAnswers[q.id] = localCode;
      } else if (legacyCode !== null && legacyCode !== undefined) {
        codeAnswers[q.id] = legacyCode;
      } else if (serverCode !== undefined && serverCode !== null) {
        codeAnswers[q.id] = serverCode;
      }
    }
  });

  // Restore active question
  const savedQId = localState?.currentQuestionId || attempt.current_question_id;
  if (savedQId) {
    const idx = questions.findIndex(q => q.id === Number(savedQId));
    if (idx >= 0) current = idx;
  }

  document.getElementById('testTitle').textContent = attempt.test_title || 'Aspire Scholarship Test';
  document.getElementById('studentName').textContent = attempt.student_name || '';
  renderPalette();
  renderQuestion();
  startTimer();
  setupTabDetection();

  if (window.NetworkRecovery) {
    window.NetworkRecovery.init({
      token,
      onExpiry: () => autoSubmit()
    });
  }

  if (window.AspireProctoring) {
    window.AspireProctoring.init({ token });
  }
}

function navigateToQuestion(idx) {
  if (idx < 0 || idx >= questions.length) return;
  current = idx;
  renderQuestion();
  if (window.AssessmentStorage && questions[current]) {
    window.AssessmentStorage.saveCurrentQuestion(questions[current].id);
    if (window.NetworkRecovery) window.NetworkRecovery.triggerSync();
  }
}

function renderPalette() {
  const pal = document.getElementById('palette');
  pal.innerHTML = '';
  questions.forEach((q, i) => {
    const b = document.createElement('button');
    b.className = 'pal-btn';
    b.textContent = i + 1;
    b.id = `pal-${i}`;
    b.onclick = () => { navigateToQuestion(i); };
    pal.appendChild(b);
  });
  markPalette();
}

function markPalette() {
  questions.forEach((q, i) => {
    const b = document.getElementById(`pal-${i}`);
    if (!b) return;
    b.classList.toggle('current', i === current);
    const answered = q.type === 'mcq'
      ? answers[q.id] !== undefined
      : (codeAnswers[q.id] || '').trim().length > 0;
    b.classList.toggle('answered', answered);
  });
}

function renderQuestion() {
  const q = questions[current];
  const box = document.getElementById('qbox');
  const token = getToken();

  let html = `<div class="qtext">${esc(q.question_text)}</div>`;
  html += `<div style="color:var(--muted);font-size:13px;margin:6px 0;">${esc(q.category)} · ${q.marks} mark${q.marks > 1 ? 's' : ''}${q.type === 'code' ? ' · write and execute your solution below' : ''}</div>`;

  if (q.type === 'mcq') {
    html += q.options.map((opt, i) =>
      `<label class="opt ${answers[q.id] === i ? 'selected' : ''}">
         <input type="radio" name="opt" value="${i}" ${answers[q.id] === i ? 'checked' : ''}> ${esc(opt)}
       </label>`).join('');
  } else {
    const lang = codeLanguages[q.id] || q.language || 'python';
    const val = codeAnswers[q.id] !== undefined
      ? codeAnswers[q.id]
      : (localStorage.getItem(`aspire_code_${token}_${q.id}`) ?? (q.code_starter || ''));

    html += `
      <div class="code-toolbar">
        <div>
          <label style="margin:0 0 4px;font-size:12px;color:var(--muted)">Language</label>
          <select id="langSelect" class="code-lang-select">
            <option value="python" ${lang === 'python' ? 'selected' : ''}>Python (3.14)</option>
            <option value="javascript" ${lang === 'javascript' ? 'selected' : ''}>JavaScript (Node 24)</option>
            <option value="cpp" ${lang === 'cpp' ? 'selected' : ''}>C++ (GCC 15)</option>
            <option value="java" ${lang === 'java' ? 'selected' : ''}>Java (OpenJDK 25)</option>
          </select>
        </div>
        <div class="code-actions">
          <button id="runCodeBtn" class="btn ghost small" type="button">▶ Run Code</button>
          <button id="submitCodeBtn" class="btn small" type="button">✔ Submit Solution</button>
        </div>
      </div>
      <textarea id="codeArea" class="code" spellcheck="false">${esc(val)}</textarea>
    `;

    // Render sample test cases if available
    if (Array.isArray(q.sample_test_cases) && q.sample_test_cases.length > 0) {
      html += `<div style="margin-top:14px;font-size:13px;font-weight:600;color:var(--muted)">Sample Test Cases:</div>`;
      q.sample_test_cases.forEach((stc, idx) => {
        html += `
          <div class="test-case-card" style="margin-top:6px">
            <div><b>Sample #${idx + 1}</b></div>
            <div style="margin-top:4px"><b>Input:</b> <pre style="display:inline;margin:0;font-family:monospace">${esc(stc.input || '(empty)')}</pre></div>
            <div style="margin-top:4px"><b>Expected Output:</b> <pre style="display:inline;margin:0;font-family:monospace">${esc(stc.expected_output || '')}</pre></div>
          </div>
        `;
      });
    }

    html += `<div id="codeResultsBox" style="margin-top:14px"></div>`;
  }
  box.innerHTML = html;

  if (q.type === 'mcq') {
    box.querySelectorAll('input[name="opt"]').forEach((r) => {
      r.addEventListener('change', async () => {
        const optVal = parseInt(r.value, 10);
        answers[q.id] = optVal;
        markPalette();
        renderQuestion();
        if (window.AssessmentStorage) {
          await window.AssessmentStorage.saveMCQAnswer(q.id, optVal);
          if (window.NetworkRecovery) window.NetworkRecovery.triggerSync();
        }
      });
    });
  } else {
    const ta = document.getElementById('codeArea');
    const langSelect = document.getElementById('langSelect');
    const runBtn = document.getElementById('runCodeBtn');
    const submitCodeBtn = document.getElementById('submitCodeBtn');

    if (codeAnswers[q.id] === undefined) {
      codeAnswers[q.id] = ta.value;
    }

    ta.addEventListener('input', () => {
      codeAnswers[q.id] = ta.value;
      localStorage.setItem(`aspire_code_${token}_${q.id}`, ta.value);
      markPalette();
      if (window.AssessmentStorage) {
        if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
        draftDebounceTimer = setTimeout(async () => {
          await window.AssessmentStorage.saveDraftCode(q.id, langSelect.value, ta.value);
          if (window.NetworkRecovery) window.NetworkRecovery.triggerSync();
        }, 600);
      }
    });

    langSelect.addEventListener('change', async () => {
      codeLanguages[q.id] = langSelect.value;
      if (window.AssessmentStorage && ta.value) {
        await window.AssessmentStorage.saveDraftCode(q.id, langSelect.value, ta.value);
        if (window.NetworkRecovery) window.NetworkRecovery.triggerSync();
      }
    });

    runBtn.addEventListener('click', () => handleRunCode(q));
    submitCodeBtn.addEventListener('click', () => handleSubmitCode(q));

    // Restore any previous execution results for this question
    if (codeResults[q.id]) {
      renderCodeResultUI(codeResults[q.id]);
    }
  }

  document.getElementById('prevBtn').disabled = current === 0;
  document.getElementById('nextBtn').disabled = current === questions.length - 1;
  document.getElementById('qcount').textContent = `Question ${current + 1} of ${questions.length}`;
  markPalette();
}

async function handleRunCode(q) {
  const token = getToken();
  const ta = document.getElementById('codeArea');
  const langSelect = document.getElementById('langSelect');
  const runBtn = document.getElementById('runCodeBtn');
  const submitCodeBtn = document.getElementById('submitCodeBtn');
  const resultsBox = document.getElementById('codeResultsBox');

  const sourceCode = ta.value;
  const language = langSelect.value;

  if (!sourceCode.trim()) {
    resultsBox.innerHTML = `
      <div class="code-results">
        <div class="code-results-header">
          <span>Execution Result</span>
          <span class="badge-status warn">EMPTY_SUBMISSION</span>
        </div>
        <div class="code-results-body" style="color:var(--bad)">
          Please enter source code before running.
        </div>
      </div>
    `;
    return;
  }

  runBtn.disabled = true;
  submitCodeBtn.disabled = true;
  runBtn.textContent = 'Running…';
  resultsBox.innerHTML = `
    <div class="code-results" style="padding:16px;text-align:center;color:var(--muted)">
      ⏳ Running code against sample test cases via OnlineCompiler.io…
    </div>
  `;

  try {
    const res = await api(`/api/attempt/${token}/code-run`, {
      method: 'POST',
      body: JSON.stringify({ questionId: q.id, language, sourceCode })
    });

    codeResults[q.id] = { type: 'run', data: res.data || res };
    renderCodeResultUI(codeResults[q.id]);
  } catch (err) {
    const msg = (err.data && (err.data.message || err.data.error)) || err.message || 'Execution failed';
    codeResults[q.id] = { type: 'run', error: msg };
    renderCodeResultUI(codeResults[q.id]);
  } finally {
    runBtn.disabled = false;
    submitCodeBtn.disabled = false;
    runBtn.textContent = '▶ Run Code';
  }
}

async function handleSubmitCode(q) {
  const token = getToken();
  const ta = document.getElementById('codeArea');
  const langSelect = document.getElementById('langSelect');
  const runBtn = document.getElementById('runCodeBtn');
  const submitCodeBtn = document.getElementById('submitCodeBtn');
  const resultsBox = document.getElementById('codeResultsBox');

  const sourceCode = ta.value;
  const language = langSelect.value;

  if (!sourceCode.trim()) {
    resultsBox.innerHTML = `
      <div class="code-results">
        <div class="code-results-header">
          <span>Submission Result</span>
          <span class="badge-status warn">EMPTY_SUBMISSION</span>
        </div>
        <div class="code-results-body" style="color:var(--bad)">
          Please enter source code before submitting.
        </div>
      </div>
    `;
    return;
  }

  runBtn.disabled = true;
  submitCodeBtn.disabled = true;
  submitCodeBtn.textContent = 'Submitting…';
  resultsBox.innerHTML = `
    <div class="code-results" style="padding:16px;text-align:center;color:var(--muted)">
      ⚡ Evaluating complete test suite on OnlineCompiler.io…
    </div>
  `;

  try {
    const res = await api(`/api/attempt/${token}/code-submit`, {
      method: 'POST',
      body: JSON.stringify({ questionId: q.id, language, sourceCode })
    });

    codeAnswers[q.id] = sourceCode;
    localStorage.setItem(`aspire_code_${token}_${q.id}`, sourceCode);
    markPalette();

    const statusUrl = res.statusUrl || (res.submissionId ? `/api/attempt/${token}/code-submissions/${res.submissionId}` : null);

    if (statusUrl && (res.status === 'QUEUED' || res.status === 'RUNNING')) {
      renderCodeResultUI({
        type: 'submit',
        data: { status: res.status }
      });

      // Poll until COMPLETED or FAILED (with bounded backoff)
      const maxAttempts = 30;
      let attempts = 0;
      let finalData = null;

      while (attempts < maxAttempts) {
        attempts++;
        await new Promise((r) => setTimeout(r, res.retryAfterMs || 1500));
        try {
          const pollRes = await api(statusUrl);
          if (pollRes.status === 'RUNNING') {
            renderCodeResultUI({
              type: 'submit',
              data: { status: 'RUNNING' }
            });
          } else if (pollRes.status === 'COMPLETED' || pollRes.status === 'FAILED') {
            finalData = pollRes;
            break;
          }
        } catch (pollErr) {
          // Transient network blip during polling: continue
        }
      }

      if (finalData) {
        const displayStatus = finalData.verdict && finalData.verdict !== 'PENDING' ? finalData.verdict : finalData.status;
        codeResults[q.id] = { type: 'submit', data: { ...finalData, status: displayStatus } };
        renderCodeResultUI(codeResults[q.id]);
        toast(finalData.verdict === 'ACCEPTED' ? '🎉 Solution accepted!' : 'Coding solution evaluated and recorded.');
      } else {
        toast('Evaluation queued. Your solution is safely stored in our database.');
      }
    } else {
      codeResults[q.id] = { type: 'submit', data: res.data || res };
      renderCodeResultUI(codeResults[q.id]);
      toast('Coding solution evaluated and saved.');
    }
  } catch (err) {
    const msg = (err.data && (err.data.message || err.data.error)) || err.message || 'Submission failed';
    codeResults[q.id] = { type: 'submit', error: msg };
    renderCodeResultUI(codeResults[q.id]);
  } finally {
    runBtn.disabled = false;
    submitCodeBtn.disabled = false;
    submitCodeBtn.textContent = '✔ Submit Solution';
  }
}

function renderCodeResultUI(resultObj) {
  const resultsBox = document.getElementById('codeResultsBox');
  if (!resultsBox) return;

  if (resultObj.error) {
    resultsBox.innerHTML = `
      <div class="code-results">
        <div class="code-results-header">
          <span>Execution Error</span>
          <span class="badge-status fail">ERROR</span>
        </div>
        <div class="code-results-body">
          <div style="color:var(--bad);font-weight:600">${esc(resultObj.error)}</div>
          <div style="margin-top:8px;font-size:12px;color:var(--muted)">
            Your code is preserved locally. You can modify it and try again.
          </div>
        </div>
      </div>
    `;
    return;
  }

  const d = resultObj.data || {};
  const status = d.status || 'UNKNOWN';
  const isAccepted = status === 'ACCEPTED';
  const badgeClass = isAccepted ? 'pass' : (status === 'RUNNING' || status === 'QUEUED' ? 'info' : 'fail');

  let bodyHtml = '';

  if (resultObj.type === 'run') {
    // "Run Code" output
    bodyHtml += `
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px">
        <div><b>Sample Tests Passed:</b> ${d.testsPassed ?? 0} / ${d.testsTotal ?? 0}</div>
        <div><b>Execution Time:</b> ${d.executionTimeMs ? d.executionTimeMs + ' ms' : 'N/A'}</div>
      </div>
    `;

    if (Array.isArray(d.results) && d.results.length > 0) {
      d.results.forEach((r) => {
        const testPass = Boolean(r.passed);
        bodyHtml += `
          <div class="test-case-card ${testPass ? 'pass' : 'fail'}">
            <div style="display:flex;justify-content:space-between">
              <b>Test #${r.testIndex}</b>
              <span class="badge-status ${testPass ? 'pass' : 'fail'}">${testPass ? 'PASSED' : r.status || 'FAILED'}</span>
            </div>
            <div style="margin-top:6px"><b>Input:</b> <pre style="display:inline;margin:0;font-family:monospace">${esc(r.input || '(empty)')}</pre></div>
            <div style="margin-top:4px"><b>Expected:</b> <pre style="display:inline;margin:0;font-family:monospace">${esc(r.expectedOutput || '')}</pre></div>
            <div style="margin-top:4px"><b>Actual:</b> <pre style="display:inline;margin:0;font-family:monospace">${esc(r.actualOutput || '')}</pre></div>
            ${r.error ? `<div class="console-output" style="margin-top:6px">${esc(r.error)}</div>` : ''}
          </div>
        `;
      });
    }

    if (d.error && (!d.results || d.results.length === 0)) {
      bodyHtml += `<div class="console-output">${esc(d.error)}</div>`;
    }
  } else if (status === 'QUEUED' || status === 'RUNNING') {
    // In-flight background job
    bodyHtml += `
      <div style="text-align:center;padding:12px;font-size:14px;color:var(--muted)">
        ${status === 'QUEUED' ? '⏳ Submission queued. Waiting for worker assignment…' : '⚡ Worker evaluating private test suite in isolated runtime…'}
      </div>
    `;
  } else {
    // "Submit Solution" output
    bodyHtml += `
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px">
        <div><b>Test Cases:</b> ${d.testsPassed ?? 0} / ${d.testsTotal ?? 0} Passed</div>
        <div><b>Score Earned:</b> ${d.score ?? 0} / ${d.marks ?? 0}</div>
      </div>
      <div style="font-size:13px;color:var(--muted)">
        ${isAccepted ? '🎉 All test cases passed! Solution recorded.' : 'Some test cases failed or encountered an error. Solution recorded.'}
      </div>
    `;
    if (d.error) {
      bodyHtml += `<div class="console-output">${esc(d.error)}</div>`;
    }
  }

  resultsBox.innerHTML = `
    <div class="code-results">
      <div class="code-results-header">
        <span>${resultObj.type === 'run' ? 'Test Run Verdict' : 'Evaluation Result'}</span>
        <span class="badge-status ${badgeClass}">${esc(status)}</span>
      </div>
      <div class="code-results-body">
        ${bodyHtml}
      </div>
    </div>
  `;
}

function startTimer() {
  const end = new Date(attempt.expires_at).getTime();
  const el = document.getElementById('timerText');
  const bar = document.getElementById('timerBar');
  function tick() {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(timerId);
      autoSubmit();
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    bar.classList.toggle('danger', left < 5 * 60000);
  }
  tick();
  timerId = setInterval(tick, 1000);
}

function setupTabDetection() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !submitted) {
      tabSwitches++;
      toast(`Warning: tab switch detected (${tabSwitches}). This is recorded.`);
      const token = getToken();
      fetch(`/api/attempt/${token}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabSwitches }),
        keepalive: true
      }).catch(() => {});
    }
  });
}

async function autoSubmit() {
  if (submitted) return;
  toast('Time is up — submitting your test automatically…');
  await doSubmit(true);
}

async function doSubmit(auto = false) {
  if (submitted) return;
  const token = getToken();
  if (!auto) {
    const unanswered = questions.filter((q) => q.type === 'mcq'
      ? answers[q.id] === undefined
      : !(codeAnswers[q.id] || '').trim()).length;
    if (unanswered > 0 && !confirm(`${unanswered} question(s) unanswered. Submit anyway?`)) return;
  }
  submitted = true;
  clearInterval(timerId);
  if (window.NetworkRecovery) {
    window.NetworkRecovery.destroy();
  }
  if (window.AspireProctoring) {
    window.AspireProctoring.destroy();
  }
  document.getElementById('submitBtn').disabled = true;
  document.getElementById('submitBtn').textContent = 'Grading… (code questions may take a few seconds)';
  try {
    const data = await api(`/api/attempt/${token}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, codeAnswers, tabSwitches })
    });

    // Cleanup local storage for this attempt
    questions.forEach(q => {
      if (q.type === 'code') {
        localStorage.removeItem(`aspire_code_${token}_${q.id}`);
      }
    });
    if (window.AssessmentStorage) {
      await window.AssessmentStorage.clearAssessmentState();
    }

    sessionStorage.setItem(RESULT_KEY, JSON.stringify(data));
    window.location.href = '/result.html';
  } catch (e) {
    submitted = false;
    document.getElementById('submitBtn').disabled = false;
    document.getElementById('submitBtn').textContent = 'Submit Test';
    showErr('testErr', 'Submit failed: ' + e.message + '. Please try again.');
  }
}

document.getElementById('prevBtn').addEventListener('click', () => { if (current > 0) { navigateToQuestion(current - 1); } });
document.getElementById('nextBtn').addEventListener('click', () => { if (current < questions.length - 1) { navigateToQuestion(current + 1); } });
document.getElementById('submitBtn').addEventListener('click', () => doSubmit(false));
window.addEventListener('beforeunload', (e) => {
  if (!submitted) {
    if (window.AspireProctoring) {
      window.AspireProctoring.flushQueue(true);
    }
    e.preventDefault();
  }
});

init();
