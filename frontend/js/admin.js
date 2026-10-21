// Admin panel logic. Token stored in localStorage.
const ADMIN_KEY = 'aspire_admin_token';
function adminToken() { return localStorage.getItem(ADMIN_KEY) || ''; }

async function aapi(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken(), ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function gate() {
  const has = !!adminToken();
  document.getElementById('loginBox').style.display = has ? 'none' : 'block';
  document.getElementById('adminBox').style.display = has ? 'block' : 'none';
  if (has) { loadJudge0(); loadQuestions(); loadConfig(); }
}

document.getElementById('loginBtn').addEventListener('click', () => {
  const t = document.getElementById('adminTokenInput').value.trim();
  if (!t) return;
  localStorage.setItem(ADMIN_KEY, t);
  gate();
});
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem(ADMIN_KEY);
  gate();
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.style.display = p.id === `pane-${name}` ? 'block' : 'none');
  if (name === 'results') loadResults();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

async function loadJudge0() {
  try {
    const s = await aapi('/api/admin/judge0-status');
    const el = document.getElementById('judge0note');
    if (s.configured) {
      el.className = 'okmsg'; el.style.display = 'block';
      el.textContent = `Judge0 connected (${s.mode}: ${s.endpoint}). Code questions are live.`;
    } else {
      el.className = 'err'; el.style.display = 'block';
      el.textContent = 'Judge0 NOT configured — code-writing questions are auto-excluded from tests. Set JUDGE0_ENDPOINT (and key) in .env to enable.';
    }
  } catch (e) { /* ignore */ }
}

/* ---------- Questions ---------- */
let editingId = null;

async function loadQuestions() {
  const qs = await aapi('/api/admin/questions');
  const tb = document.getElementById('qBody');
  tb.innerHTML = qs.map((q) => `<tr>
    <td>${q.id}</td><td>${esc(q.type)}</td><td>${esc(q.category)}</td>
    <td>${esc(q.question_text.slice(0, 60))}${q.question_text.length > 60 ? '…' : ''}</td>
    <td>${q.marks}</td><td>${q.is_sample ? 'SAMPLE' : ''}</td>
    <td><button class="btn small ghost" onclick="editQ(${q.id})">Edit</button>
        <button class="btn small ghost" onclick="delQ(${q.id})">Delete</button></td>
  </tr>`).join('');
  window._qs = Object.fromEntries(qs.map((q) => [q.id, q]));
}

const QUESTION_CATEGORIES = ['aptitude', 'technical', 'coding'];

function qFormHTML(q) {
  q = q || { type: 'mcq', category: 'aptitude', marks: 1, options: ['', ''], correct_index: 0 };
  const curCat = QUESTION_CATEGORIES.includes(q.category) ? q.category : 'aptitude';
  const opts = (q.options || []).map((o, i) =>
    `<div class="row"><input data-opt="${i}" value="${esc(o)}" placeholder="Option ${i + 1}">
     <label style="margin:0"><input type="radio" name="correct" value="${i}" ${q.correct_index === i ? 'checked' : ''} style="width:auto"> correct</label></div>`).join('');
  return `
    <label>Type</label>
    <select id="f_type"><option value="mcq" ${q.type === 'mcq' ? 'selected' : ''}>MCQ</option>
    <option value="code" ${q.type === 'code' ? 'selected' : ''}>Code (Judge0)</option></select>
    <label>Category</label>
    <select id="f_cat">${QUESTION_CATEGORIES.map((c) => `<option value="${c}" ${curCat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <div class="hint" style="color:var(--muted);font-size:12px;margin:-6px 0 10px">aptitude + technical are MCQ · coding is code-writing (needs Judge0)</div>
    <label>Question text</label><textarea id="f_text" rows="4">${esc(q.question_text || '')}</textarea>
    <div id="mcqFields" style="display:${q.type === 'mcq' ? 'block' : 'none'}">
      <label>Options (tick the correct one)</label><div id="optList">${opts}</div>
      <button type="button" class="btn small ghost" id="addOpt">+ Add option</button>
    </div>
    <div id="codeFields" style="display:${q.type === 'code' ? 'block' : 'none'}">
      <label>Starter code</label><textarea id="f_starter" class="code" rows="6">${esc(q.code_starter || '')}</textarea>
      <label>Judge0 language id (71 = Python 3)</label><input id="f_lang" type="number" value="${q.language_id || 71}">
      <label>Test cases (JSON array of {"input": "...", "expected": "..."})</label>
      <textarea id="f_tests" rows="5">${esc(q.test_cases ? JSON.stringify(q.test_cases, null, 1) : '[\n  {"input": "", "expected": ""}\n]')}</textarea>
    </div>
    <div class="row">
      <div><label>Marks</label><input id="f_marks" type="number" min="1" value="${q.marks || 1}"></div>
      <div><label>&nbsp;</label><label style="margin:0"><input id="f_sample" type="checkbox" ${q.is_sample ? 'checked' : ''} style="width:auto"> sample question</label></div>
    </div>`;
}

function showQForm(q) {
  editingId = q ? q.id : null;
  document.getElementById('qFormTitle').textContent = q ? `Edit question #${q.id}` : 'Add question';
  document.getElementById('qFormBody').innerHTML = qFormHTML(q);
  document.getElementById('qForm').style.display = 'block';
  document.getElementById('f_type').addEventListener('change', (e) => {
    const t = e.target.value;
    document.getElementById('mcqFields').style.display = t === 'mcq' ? 'block' : 'none';
    document.getElementById('codeFields').style.display = t === 'code' ? 'block' : 'none';
    // Keep category <-> type consistent: coding is always code-writing.
    const cat = document.getElementById('f_cat');
    cat.value = t === 'code' ? 'coding' : (cat.value === 'coding' ? 'technical' : cat.value);
  });
  document.getElementById('f_cat').addEventListener('change', (e) => {
    const c = e.target.value;
    const t = document.getElementById('f_type');
    t.value = c === 'coding' ? 'code' : 'mcq';
    document.getElementById('mcqFields').style.display = c === 'coding' ? 'none' : 'block';
    document.getElementById('codeFields').style.display = c === 'coding' ? 'block' : 'none';
  });
  document.getElementById('addOpt').addEventListener('click', () => {
    const list = document.getElementById('optList');
    const i = list.querySelectorAll('[data-opt]').length;
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<input data-opt="${i}" placeholder="Option ${i + 1}">
      <label style="margin:0"><input type="radio" name="correct" value="${i}" style="width:auto"> correct</label>`;
    list.appendChild(div);
  });
  window.scrollTo({ top: document.getElementById('qForm').offsetTop - 20, behavior: 'smooth' });
}

window.editQ = (id) => showQForm(window._qs[id]);
document.getElementById('addQBtn').addEventListener('click', () => showQForm(null));
document.getElementById('cancelQBtn').addEventListener('click', () => {
  document.getElementById('qForm').style.display = 'none';
  editingId = null;
});
window.delQ = async (id) => {
  if (!confirm(`Delete question #${id}?`)) return;
  await aapi(`/api/admin/questions/${id}`, { method: 'DELETE' });
  loadQuestions();
};

document.getElementById('saveQBtn').addEventListener('click', async () => {
  const type = document.getElementById('f_type').value;
  const payload = {
    type,
    category: document.getElementById('f_cat').value,
    question_text: document.getElementById('f_text').value,
    marks: parseInt(document.getElementById('f_marks').value, 10) || 1,
    is_sample: document.getElementById('f_sample').checked
  };
  if (type === 'mcq') {
    payload.options = [...document.querySelectorAll('[data-opt]')].map((el) => el.value);
    const checked = document.querySelector('input[name="correct"]:checked');
    payload.correct_index = checked ? parseInt(checked.value, 10) : 0;
  } else {
    payload.code_starter = document.getElementById('f_starter').value;
    payload.language_id = parseInt(document.getElementById('f_lang').value, 10) || 71;
    try {
      payload.test_cases = JSON.parse(document.getElementById('f_tests').value);
    } catch { showErr('qFormErr', 'Test cases must be valid JSON'); return; }
  }
  try {
    if (editingId) await aapi(`/api/admin/questions/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await aapi('/api/admin/questions', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('qForm').style.display = 'none';
    editingId = null;
    loadQuestions();
  } catch (e) { showErr('qFormErr', e.message); }
});

/* ---------- Config ---------- */
async function loadConfig() {
  const cfg = await aapi('/api/admin/config');
  document.getElementById('c_title').value = cfg.test_title || '';
  document.getElementById('c_duration').value = cfg.duration_minutes || '90';
  document.getElementById('c_q_apt').value = cfg.quota_aptitude || '10';
  document.getElementById('c_q_tech').value = cfg.quota_technical || '25';
  document.getElementById('c_q_code').value = cfg.quota_coding || '5';
  document.getElementById('c_shuffle_q').checked = cfg.shuffle_questions !== '0';
  document.getElementById('c_shuffle_o').checked = cfg.shuffle_options !== '0';
  document.getElementById('c_brand').value = cfg.brand_name || '';
  document.getElementById('c_accent').value = cfg.accent_color || '#F97316';
  try {
    document.getElementById('c_slabs').value = JSON.stringify(JSON.parse(cfg.scholarship_slabs), null, 2);
  } catch { document.getElementById('c_slabs').value = cfg.scholarship_slabs || ''; }
  // Judge0 notice: coding questions are excluded from tests until configured.
  try {
    const j = await aapi('/api/admin/judge0-status');
    const n = document.getElementById('judge0Notice');
    if (j.configured) {
      n.className = 'okmsg';
      n.textContent = `Judge0 connected (${j.mode}). Coding questions are included in tests.`;
    } else {
      n.className = 'err';
      n.textContent = 'Judge0 is NOT configured — coding questions are automatically excluded from tests (test runs with 35 questions). Set JUDGE0_ENDPOINT on the server to enable them.';
    }
  } catch { /* status fetch is best-effort */ }
}
document.getElementById('saveCfgBtn').addEventListener('click', async () => {
  const payload = {
    test_title: document.getElementById('c_title').value,
    duration_minutes: document.getElementById('c_duration').value,
    quota_aptitude: document.getElementById('c_q_apt').value,
    quota_technical: document.getElementById('c_q_tech').value,
    quota_coding: document.getElementById('c_q_code').value,
    shuffle_questions: document.getElementById('c_shuffle_q').checked ? '1' : '0',
    shuffle_options: document.getElementById('c_shuffle_o').checked ? '1' : '0',
    scholarship_slabs: document.getElementById('c_slabs').value,
    brand_name: document.getElementById('c_brand').value,
    accent_color: document.getElementById('c_accent').value
  };
  try {
    await aapi('/api/admin/config', { method: 'PUT', body: JSON.stringify(payload) });
    showOk('cfgOk', 'Configuration saved.');
  } catch (e) { showErr('cfgOk', e.message); }
});

/* ---------- Results ---------- */
async function loadResults() {
  const p = new URLSearchParams();
  const college = document.getElementById('f_college').value.trim();
  const track = document.getElementById('f_track').value.trim();
  const minp = document.getElementById('f_minp').value.trim();
  if (college) p.set('college', college);
  if (track) p.set('track', track);
  if (minp) p.set('min_percentage', minp);
  const rows = await aapi(`/api/admin/results?${p.toString()}`);
  document.getElementById('resCount').textContent = `${rows.length} result(s)`;
  document.getElementById('resBody').innerHTML = rows.map((r) => `<tr>
    <td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.college || '')}</td>
    <td>${esc(r.track || '')}</td><td>${r.score}/${r.total_marks}</td>
    <td>${Number(r.percentage).toFixed(1)}%</td><td>${r.scholarship_pct}%</td>
    <td>${esc(r.claim_code || '')}</td><td>${esc((r.submitted_at || '').slice(0, 16))}</td>
  </tr>`).join('');
  document.getElementById('csvBtn').href = `/api/admin/results.csv?${p.toString()}`;
  // attach token for CSV (browser download can't set headers) — use query param fallback
  document.getElementById('csvBtn').onclick = (e) => {
    e.preventDefault();
    fetch(`/api/admin/results.csv?${p.toString()}`, { headers: { 'x-admin-token': adminToken() } })
      .then((r) => { if (!r.ok) throw new Error('export failed'); return r.blob(); })
      .then((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'aspire-results.csv';
        a.click();
      }).catch((err) => toast(err.message));
  };
}
document.getElementById('filterBtn').addEventListener('click', loadResults);

/* ---------- College report ---------- */
document.getElementById('repBtn').addEventListener('click', async () => {
  const college = document.getElementById('repCollege').value.trim();
  if (!college) return;
  const r = await aapi(`/api/admin/report/college?college=${encodeURIComponent(college)}`);
  const cats = Object.entries(r.category_avg || {}).map(([c, v]) => `<tr><td>${esc(c)}</td><td>${v}%</td></tr>`).join('');
  const top = (r.top10 || []).map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td>${esc(t.track || '')}</td><td>${Number(t.percentage).toFixed(1)}%</td><td>${t.scholarship_pct}%</td></tr>`).join('');
  document.getElementById('repOut').innerHTML = `
    <div class="kv"><b>College</b><span>${esc(r.college)}</span></div>
    <div class="kv"><b>Started</b><span>${r.started_attempts}</span></div>
    <div class="kv"><b>Submitted</b><span>${r.submitted}</span></div>
    <div class="kv"><b>Average score</b><span>${r.avg_percentage}%</span></div>
    <h3>Category averages</h3>
    <table class="data"><tr><th>Category</th><th>Average</th></tr>${cats || '<tr><td colspan="2">No data</td></tr>'}</table>
    <h3>Top 10 performers</h3>
    <table class="data"><tr><th>#</th><th>Name</th><th>Track</th><th>Score</th><th>Scholarship</th></tr>${top || '<tr><td colspan="5">No data</td></tr>'}</table>`;
});

gate();
