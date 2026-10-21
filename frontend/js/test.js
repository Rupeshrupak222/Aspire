// Timed test page: one question at a time, palette nav, auto-submit on timeout.
let attempt = null;
let questions = [];
let current = 0;
let answers = {};      // mcq: {qid: selectedOptionIndex}
let codeAnswers = {};  // code: {qid: sourceCode}
let tabSwitches = 0;
let timerId = null;
let submitted = false;

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

  document.getElementById('testTitle').textContent = attempt.test_title || 'Aspire Scholarship Test';
  document.getElementById('studentName').textContent = attempt.student_name || '';
  renderPalette();
  renderQuestion();
  startTimer();
  setupTabDetection();
}

function renderPalette() {
  const pal = document.getElementById('palette');
  pal.innerHTML = '';
  questions.forEach((q, i) => {
    const b = document.createElement('button');
    b.className = 'pal-btn';
    b.textContent = i + 1;
    b.id = `pal-${i}`;
    b.onclick = () => { current = i; renderQuestion(); };
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
  let html = `<div class="qtext">${esc(q.question_text)}</div>`;
  html += `<div style="color:var(--muted);font-size:13px;margin:6px 0;">${esc(q.category)} · ${q.marks} mark${q.marks > 1 ? 's' : ''}${q.type === 'code' ? ' · write code below, it runs automatically' : ''}</div>`;
  if (q.type === 'mcq') {
    html += q.options.map((opt, i) =>
      `<label class="opt ${answers[q.id] === i ? 'selected' : ''}">
         <input type="radio" name="opt" value="${i}" ${answers[q.id] === i ? 'checked' : ''}> ${esc(opt)}
       </label>`).join('');
  } else {
    const val = codeAnswers[q.id] !== undefined ? codeAnswers[q.id] : (q.code_starter || '');
    html += `<textarea id="codeArea" class="code" spellcheck="false">${esc(val)}</textarea>`;
  }
  box.innerHTML = html;

  if (q.type === 'mcq') {
    box.querySelectorAll('input[name="opt"]').forEach((r) => {
      r.addEventListener('change', () => {
        answers[q.id] = parseInt(r.value, 10);
        markPalette();
        renderQuestion(); // refresh selected styling
      });
    });
  } else {
    const ta = document.getElementById('codeArea');
    ta.addEventListener('input', () => { codeAnswers[q.id] = ta.value; markPalette(); });
    if (codeAnswers[q.id] === undefined) codeAnswers[q.id] = q.code_starter || '';
  }
  document.getElementById('prevBtn').disabled = current === 0;
  document.getElementById('nextBtn').disabled = current === questions.length - 1;
  document.getElementById('qcount').textContent = `Question ${current + 1} of ${questions.length}`;
  markPalette();
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
  if (!auto) {
    const unanswered = questions.filter((q) => q.type === 'mcq'
      ? answers[q.id] === undefined
      : !(codeAnswers[q.id] || '').trim()).length;
    if (unanswered > 0 && !confirm(`${unanswered} question(s) unanswered. Submit anyway?`)) return;
  }
  submitted = true;
  clearInterval(timerId);
  document.getElementById('submitBtn').disabled = true;
  document.getElementById('submitBtn').textContent = 'Grading… (code questions may take a few seconds)';
  try {
    const data = await api(`/api/attempt/${getToken()}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, codeAnswers, tabSwitches })
    });
    sessionStorage.setItem(RESULT_KEY, JSON.stringify(data));
    window.location.href = '/result.html';
  } catch (e) {
    submitted = false;
    document.getElementById('submitBtn').disabled = false;
    document.getElementById('submitBtn').textContent = 'Submit Test';
    showErr('testErr', 'Submit failed: ' + e.message + '. Please try again.');
  }
}

document.getElementById('prevBtn').addEventListener('click', () => { if (current > 0) { current--; renderQuestion(); } });
document.getElementById('nextBtn').addEventListener('click', () => { if (current < questions.length - 1) { current++; renderQuestion(); } });
document.getElementById('submitBtn').addEventListener('click', () => doSubmit(false));
window.addEventListener('beforeunload', (e) => { if (!submitted) e.preventDefault(); });

init();
