// Aspire Admin Panel — Authentication, RBAC, and Role-Aware Navigation.
const TOKEN_KEY = 'aspire_auth_token';
const USER_KEY = 'aspire_auth_user';

let currentUser = null;

function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setSession(token, user) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);

  if (user) {
    currentUser = user;
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    currentUser = null;
    localStorage.removeItem(USER_KEY);
  }
}

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) currentUser = JSON.parse(raw);
  } catch {
    currentUser = null;
  }
}

async function aapi(path, opts = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(opts.headers || {})
  };

  const res = await fetch(path, { ...opts, headers });

  if (res.status === 401) {
    // Session expired or invalid
    setSession(null, null);
    gate();
    showErr('loginErr', 'Session expired. Please log in again.');
    throw new Error('Authentication required');
  }

  if (res.status === 403) {
    alert('Access forbidden: You do not have permission to perform this action.');
    throw new Error('Forbidden');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

function hasPermission(permission) {
  if (!currentUser || !currentUser.permissions) return false;
  return currentUser.permissions.includes(permission);
}

function applyRoleAwareUI() {
  if (!currentUser) return;

  const role = currentUser.role || '';
  const permissions = currentUser.permissions || [];

  // Top bar updates
  document.getElementById('userNameDisplay').textContent = `${currentUser.name} (${currentUser.email})`;
  const badge = document.getElementById('roleBadge');
  badge.textContent = role.replace('_', ' ');
  badge.style.display = 'inline-block';
  document.getElementById('userMenu').style.display = 'flex';

  // Tab visibility
  const canExams = permissions.includes('exams.read');
  const canQuestions = permissions.includes('questions.read');
  const canConfig = permissions.includes('settings.read');
  const canResults = permissions.includes('results.read');
  const canAnalytics = permissions.includes('analytics.read');
  const canUsers = permissions.includes('users.read');
  const canExport = permissions.includes('results.export');

  const examTab = document.getElementById('tab-exams');
  if (examTab) examTab.style.display = canExams ? 'inline-block' : 'none';
  const createExamBtn = document.getElementById('createExamBtn');
  if (createExamBtn) createExamBtn.style.display = permissions.includes('exams.create') ? 'inline-block' : 'none';

  document.getElementById('tab-questions').style.display = canQuestions ? 'inline-block' : 'none';
  document.getElementById('tab-config').style.display = canConfig ? 'inline-block' : 'none';
  document.getElementById('tab-results').style.display = canResults ? 'inline-block' : 'none';
  document.getElementById('tab-report').style.display = canAnalytics ? 'inline-block' : 'none';
  document.getElementById('tab-users').style.display = canUsers ? 'inline-block' : 'none';

  // Question bank mutation controls
  const addQBtn = document.getElementById('addQBtn');
  if (addQBtn) addQBtn.style.display = permissions.includes('questions.create') ? 'inline-block' : 'none';

  // Export CSV button
  const csvBtn = document.getElementById('csvBtn');
  if (csvBtn) csvBtn.style.display = canExport ? 'inline-block' : 'none';

  // Super Admin role option in user form
  const superOpt = document.getElementById('u_role_super');
  if (superOpt) superOpt.style.display = role === 'SUPER_ADMIN' ? 'block' : 'none';

  // Config slabs restriction (Org admin has limited config)
  const slabsSection = document.getElementById('slabsSection');
  if (slabsSection) {
    slabsSection.style.display = role === 'SUPER_ADMIN' ? 'block' : 'none';
  }

  // Switch to default permissible tab
  if (canExams) switchTab('exams');
  else if (canQuestions) switchTab('questions');
  else if (canResults) switchTab('results');
  else if (canAnalytics) switchTab('report');
  else if (canConfig) switchTab('config');
  else if (canUsers) switchTab('users');
}

function gate() {
  const has = !!getAuthToken();
  document.getElementById('loginBox').style.display = has ? 'none' : 'block';
  document.getElementById('adminBox').style.display = has ? 'block' : 'none';

  if (!has) {
    document.getElementById('userMenu').style.display = 'none';
    document.getElementById('roleBadge').style.display = 'none';
  } else {
    loadStoredUser();
    applyRoleAwareUI();
    loadJudge0();
  }
}

// Login
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('adminEmailInput').value.trim();
  const password = document.getElementById('adminPasswordInput').value;
  const errBox = document.getElementById('loginErr');
  errBox.style.display = 'none';

  if (!email || !password) {
    errBox.textContent = 'Please enter both email and password.';
    errBox.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || data.error || 'Login failed');
    }

    setSession(data.data.token, data.data.user);
    document.getElementById('adminPasswordInput').value = '';
    gate();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// Logout
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      }
    });
  } catch {}
  setSession(null, null);
  gate();
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.style.display = p.id === `pane-${name}` ? 'block' : 'none');
  if (name === 'exams') loadExams();
  if (name === 'questions') loadQuestions();
  if (name === 'config') loadConfig();
  if (name === 'results') loadResults();
  if (name === 'users') loadUsers();
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
      el.textContent = 'Judge0 NOT configured — code-writing questions are auto-excluded from tests.';
    }
  } catch (e) { /* ignore */ }
}

/* ---------- Questions ---------- */
let editingId = null;

/* ---------- Question Bank 2.0 ---------- */
let editingId = null;
let qCurrentPage = 1;
let qTotalPages = 1;

async function loadQuestions() {
  if (!hasPermission('questions.read')) return;

  const search = document.getElementById('q_search')?.value.trim() || '';
  const status = document.getElementById('q_filter_status')?.value || 'ALL';
  const difficulty = document.getElementById('q_filter_difficulty')?.value || 'ALL';
  const type = document.getElementById('q_filter_type')?.value || 'ALL';
  const category = document.getElementById('q_filter_category')?.value || 'ALL';

  const params = new URLSearchParams({
    page: String(qCurrentPage),
    limit: '15',
    paginate: 'true'
  });
  if (search) params.append('search', search);
  if (status !== 'ALL') params.append('status', status);
  if (difficulty !== 'ALL') params.append('difficulty', difficulty);
  if (type !== 'ALL') params.append('type', type);
  if (category !== 'ALL') params.append('category', category);

  const res = await aapi(`/api/admin/questions?${params.toString()}`);
  const items = Array.isArray(res) ? res : (res.data?.items || []);
  const pagination = res.data?.pagination || null;

  const tb = document.getElementById('qBody');
  const canUpdate = hasPermission('questions.update');
  const canDelete = hasPermission('questions.delete');

  if (items.length === 0) {
    tb.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--muted)">No questions found matching the selected filters.</td></tr>`;
  } else {
    tb.innerHTML = items.map((q) => {
      const scope = q.organization_id ? `Org #${q.organization_id}` : (q.is_sample ? 'Sample' : 'Platform');
      const st = (q.status || 'PUBLISHED').toUpperCase();
      const diff = (q.difficulty || 'MEDIUM').toUpperCase();
      const statusClass = `status-${st.toLowerCase()}`;
      const diffClass = `diff-${diff.toLowerCase()}`;

      const actions = [];
      actions.push(`<button class="btn small ghost" onclick="previewQ(${q.id})" title="Preview as candidate">Preview</button>`);
      if (canUpdate) {
        actions.push(`<button class="btn small ghost" onclick="editQ(${q.id})">Edit</button>`);
        if (st !== 'PUBLISHED') {
          actions.push(`<button class="btn small ghost" style="color:var(--ok)" onclick="publishQ(${q.id})">Publish</button>`);
        } else {
          actions.push(`<button class="btn small ghost" style="color:var(--bad)" onclick="archiveQ(${q.id})">Archive</button>`);
        }
      }
      if (canDelete) {
        actions.push(`<button class="btn small ghost" onclick="delQ(${q.id})">Delete</button>`);
      }

      const titleDisplay = q.title ? `<strong>${esc(q.title)}</strong><br>` : '';
      const textSnippet = esc(q.question_text.slice(0, 55)) + (q.question_text.length > 55 ? '…' : '');

      return `<tr>
        <td>${q.id}</td>
        <td>${titleDisplay}<span style="color:var(--muted);font-size:12px">${textSnippet}</span></td>
        <td><code>${esc(q.type)}</code></td>
        <td>${esc(q.category)}</td>
        <td><span class="diff-badge ${diffClass}">${esc(diff)}</span></td>
        <td><b>${q.marks}</b></td>
        <td><span class="status-badge ${statusClass}">${esc(st)}</span></td>
        <td><small style="color:var(--muted)">v${q.version || 1}</small></td>
        <td><small>${esc(scope)}</small></td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">${actions.join(' ')}</div></td>
      </tr>`;
    }).join('');
  }

  window._qs = Object.fromEntries(items.map((q) => [q.id, q]));

  // Update pagination controls
  const pBar = document.getElementById('qPaginationBar');
  if (pagination) {
    pBar.style.display = 'flex';
    qCurrentPage = pagination.page;
    qTotalPages = pagination.totalPages || 1;
    document.getElementById('qPageInfo').textContent = `Page ${pagination.page} of ${pagination.totalPages || 1} (${pagination.total} questions)`;
    document.getElementById('qPrevPageBtn').disabled = qCurrentPage <= 1;
    document.getElementById('qNextPageBtn').disabled = qCurrentPage >= qTotalPages;
  } else {
    pBar.style.display = 'none';
  }
}

const QUESTION_CATEGORIES = ['aptitude', 'technical', 'coding'];

function qFormHTML(q) {
  q = q || {
    type: 'mcq', category: 'aptitude', marks: 1, difficulty: 'MEDIUM',
    time_estimate: 120, status: 'DRAFT', options: ['', ''], correct_index: 0
  };
  const curCat = QUESTION_CATEGORIES.includes(q.category) ? q.category : 'aptitude';
  const curDiff = ['EASY', 'MEDIUM', 'HARD'].includes(q.difficulty) ? q.difficulty : 'MEDIUM';
  const curStatus = ['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'].includes(q.status) ? q.status : 'DRAFT';
  const tagsStr = Array.isArray(q.tags) ? q.tags.join(', ') : (q.tags || '');

  const opts = (q.options || []).map((o, i) =>
    `<div class="row"><input data-opt="${i}" value="${esc(o)}" placeholder="Option ${i + 1}">
     <label style="margin:0"><input type="radio" name="correct" value="${i}" ${q.correct_index === i ? 'checked' : ''} style="width:auto"> correct</label></div>`).join('');

  return `
    <div class="row">
      <div style="flex:2">
        <label>Title</label>
        <input id="f_title" value="${esc(q.title || '')}" placeholder="Short descriptive title...">
      </div>
      <div style="flex:1">
        <label>Status</label>
        <select id="f_status">
          <option value="DRAFT" ${curStatus === 'DRAFT' ? 'selected' : ''}>DRAFT</option>
          <option value="REVIEW" ${curStatus === 'REVIEW' ? 'selected' : ''}>REVIEW</option>
          <option value="PUBLISHED" ${curStatus === 'PUBLISHED' ? 'selected' : ''}>PUBLISHED</option>
          <option value="ARCHIVED" ${curStatus === 'ARCHIVED' ? 'selected' : ''}>ARCHIVED</option>
        </select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Type</label>
        <select id="f_type">
          <option value="mcq" ${q.type === 'mcq' ? 'selected' : ''}>MCQ</option>
          <option value="code" ${q.type === 'code' ? 'selected' : ''}>Code (Judge0)</option>
        </select>
      </div>
      <div>
        <label>Category</label>
        <select id="f_cat">${QUESTION_CATEGORIES.map((c) => `<option value="${c}" ${curCat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div>
        <label>Difficulty</label>
        <select id="f_diff">
          <option value="EASY" ${curDiff === 'EASY' ? 'selected' : ''}>Easy</option>
          <option value="MEDIUM" ${curDiff === 'MEDIUM' ? 'selected' : ''}>Medium</option>
          <option value="HARD" ${curDiff === 'HARD' ? 'selected' : ''}>Hard</option>
        </select>
      </div>
      <div>
        <label>Marks</label>
        <input id="f_marks" type="number" min="1" value="${q.marks || 1}">
      </div>
      <div>
        <label>Time Est. (sec)</label>
        <input id="f_time" type="number" min="10" value="${q.time_estimate || 120}">
      </div>
    </div>

    <div class="row">
      <div style="flex:1">
        <label>Topic</label>
        <input id="f_topic" value="${esc(q.topic || '')}" placeholder="e.g. Data Structures, React">
      </div>
      <div style="flex:1">
        <label>Skill</label>
        <input id="f_skill" value="${esc(q.skill || '')}" placeholder="e.g. Binary Trees, State Management">
      </div>
      <div style="flex:1">
        <label>Tags (comma-separated)</label>
        <input id="f_tags" value="${esc(tagsStr)}" placeholder="e.g. tree, dfs, beginner">
      </div>
    </div>

    <label style="margin-top:8px">Question text</label>
    <textarea id="f_text" rows="4" placeholder="Enter full question description...">${esc(q.question_text || '')}</textarea>

    <div id="mcqFields" style="display:${q.type === 'mcq' ? 'block' : 'none'};margin-top:10px">
      <label>Options (select the single correct answer)</label>
      <div id="optList">${opts}</div>
      <button type="button" class="btn small ghost" id="addOpt">+ Add Option</button>
    </div>

    <div id="codeFields" style="display:${q.type === 'code' ? 'block' : 'none'};margin-top:10px">
      <div class="row">
        <div>
          <label>Language</label>
          <input id="f_language" value="${esc(q.language || 'python')}" placeholder="e.g. python, javascript">
        </div>
        <div>
          <label>Judge0 Language ID (71 = Python 3)</label>
          <input id="f_lang" type="number" value="${q.language_id || 71}">
        </div>
      </div>
      <label>Starter code</label>
      <textarea id="f_starter" class="code" rows="5">${esc(q.code_starter || '')}</textarea>
      <label>Test cases (JSON array of {"input": "...", "expected": "..."})</label>
      <textarea id="f_tests" rows="4">${esc(q.test_cases ? JSON.stringify(q.test_cases, null, 1) : '[\n  {"input": "", "expected": ""}\n]')}</textarea>
    </div>

    <div style="margin-top:12px">
      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
        <input id="f_sample" type="checkbox" ${q.is_sample ? 'checked' : ''} style="width:auto;margin:0">
        Mark as public sample question
      </label>
    </div>`;
}

function showQForm(q) {
  if (!hasPermission(q ? 'questions.update' : 'questions.create')) return;
  editingId = q ? q.id : null;
  document.getElementById('qFormTitle').textContent = q ? `Edit Question #${q.id}` : 'Add Question';
  document.getElementById('qFormBody').innerHTML = qFormHTML(q);
  document.getElementById('qDuplicateWarning').style.display = 'none';
  document.getElementById('qFormErr').style.display = 'none';
  document.getElementById('qForm').style.display = 'block';

  document.getElementById('f_type').addEventListener('change', (e) => {
    const t = e.target.value;
    document.getElementById('mcqFields').style.display = t === 'mcq' ? 'block' : 'none';
    document.getElementById('codeFields').style.display = t === 'code' ? 'block' : 'none';
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

  // Duplicate detection on blur of question text
  document.getElementById('f_text').addEventListener('blur', async (e) => {
    const txt = e.target.value.trim();
    if (txt.length < 15) return;
    try {
      const res = await aapi('/api/admin/questions/duplicates', {
        method: 'POST',
        body: JSON.stringify({
          question_text: txt,
          type: document.getElementById('f_type').value,
          exclude_id: editingId || undefined
        })
      });
      const data = res.data;
      const warnBox = document.getElementById('qDuplicateWarning');
      if (data && data.exactDuplicate) {
        warnBox.textContent = `Warning: An identical question already exists in your question bank (ID #${data.exactMatch.id}: "${data.exactMatch.title}").`;
        warnBox.style.display = 'block';
      } else if (data && data.matches && data.matches.length > 0 && data.matches[0].similarity > 0.8) {
        warnBox.textContent = `Notice: Similar question found: #${data.matches[0].id} "${data.matches[0].title}" (${Math.round(data.matches[0].similarity * 100)}% match).`;
        warnBox.style.display = 'block';
      } else {
        warnBox.style.display = 'none';
      }
    } catch {}
  });

  window.scrollTo({ top: document.getElementById('qForm').offsetTop - 20, behavior: 'smooth' });
}

window.editQ = (id) => showQForm(window._qs[id]);
document.getElementById('addQBtn').addEventListener('click', () => showQForm(null));
document.getElementById('cancelQBtn').addEventListener('click', () => {
  document.getElementById('qForm').style.display = 'none';
  editingId = null;
});

// Delete or archive question
window.delQ = async (id) => {
  if (!confirm(`Delete or archive question #${id}?`)) return;
  const res = await aapi(`/api/admin/questions/${id}`, { method: 'DELETE' });
  if (res.archived) {
    alert('This question has historical assessment attempts and was safely ARCHIVED to preserve assessment integrity.');
  }
  loadQuestions();
};

// Publish question directly
window.publishQ = async (id) => {
  try {
    await aapi(`/api/admin/questions/${id}/publish`, { method: 'POST' });
    loadQuestions();
  } catch (err) {
    alert(err.message || 'Publishing failed. Please ensure all question fields and options are complete.');
  }
};

// Archive question directly
window.archiveQ = async (id) => {
  if (!confirm(`Archive question #${id}? Archived questions will not appear in new candidate assessments.`)) return;
  await aapi(`/api/admin/questions/${id}/archive`, { method: 'POST' });
  loadQuestions();
};

// Question Preview Modal
window.previewQ = async (id) => {
  try {
    const res = await aapi(`/api/admin/questions/${id}/preview`);
    const q = res.data;
    document.getElementById('previewTitle').textContent = `Preview: ${q.title || 'Question #' + q.id}`;

    let bodyHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <span class="diff-badge diff-${(q.difficulty||'medium').toLowerCase()}">${esc(q.difficulty||'MEDIUM')}</span>
        <span class="status-badge status-${(q.status||'draft').toLowerCase()}">${esc(q.status||'DRAFT')}</span>
        <span style="font-size:13px;color:var(--muted)">Marks: <b>${q.marks}</b> · Est: <b>${q.time_estimate||120}s</b></span>
      </div>
      <div style="font-size:16px;line-height:1.6;margin-bottom:16px;white-space:pre-wrap">${esc(q.question_text)}</div>
    `;

    if (q.type === 'mcq' && Array.isArray(q.options)) {
      bodyHTML += `<div style="margin-top:12px">`;
      q.options.forEach((opt, idx) => {
        bodyHTML += `
          <label class="opt" style="margin:8px 0;display:flex;align-items:center;gap:10px">
            <input type="radio" name="preview_choice" disabled style="width:auto;margin:0">
            <span>${esc(opt)}</span>
          </label>`;
      });
      bodyHTML += `</div>`;
    } else if (q.type === 'code') {
      bodyHTML += `
        <div style="margin-top:12px">
          <label style="font-size:12px;color:var(--muted)">Candidate Starter Code:</label>
          <pre class="q" style="font-family:monospace">${esc(q.code_starter || '# Starter code')}</pre>
        </div>
      `;
      if (q.sample_test_case) {
        bodyHTML += `
          <div style="margin-top:12px;font-size:13px;background:#F9FAFB;padding:10px;border-radius:6px">
            <b>Sample Test Case:</b><br>
            <code>Input: ${esc(q.sample_test_case.input)}</code><br>
            <code>Expected: ${esc(q.sample_test_case.expected)}</code>
          </div>
        `;
      }
    }

    document.getElementById('previewBody').innerHTML = bodyHTML;
    document.getElementById('previewModal').style.display = 'flex';
  } catch (err) {
    alert(err.message || 'Could not load preview.');
  }
};

document.getElementById('closePreviewBtn').addEventListener('click', () => {
  document.getElementById('previewModal').style.display = 'none';
});

// Save question (Add / Edit)
document.getElementById('saveQBtn').addEventListener('click', async () => {
  const type = document.getElementById('f_type').value;
  const rawTags = document.getElementById('f_tags').value;
  const tags = rawTags ? rawTags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : [];

  const payload = {
    type,
    category: document.getElementById('f_cat').value,
    title: document.getElementById('f_title').value.trim() || undefined,
    question_text: document.getElementById('f_text').value,
    difficulty: document.getElementById('f_diff').value,
    topic: document.getElementById('f_topic').value.trim() || null,
    skill: document.getElementById('f_skill').value.trim() || null,
    marks: parseInt(document.getElementById('f_marks').value, 10) || 1,
    time_estimate: parseInt(document.getElementById('f_time').value, 10) || 120,
    tags,
    status: document.getElementById('f_status').value,
    is_sample: document.getElementById('f_sample').checked
  };

  if (type === 'mcq') {
    payload.options = [...document.querySelectorAll('[data-opt]')].map((el) => el.value);
    const checked = document.querySelector('input[name="correct"]:checked');
    payload.correct_index = checked ? parseInt(checked.value, 10) : 0;
  } else {
    payload.language = document.getElementById('f_language').value.trim() || 'python';
    payload.code_starter = document.getElementById('f_starter').value;
    payload.language_id = parseInt(document.getElementById('f_lang').value, 10) || 71;
    try {
      payload.test_cases = JSON.parse(document.getElementById('f_tests').value);
    } catch {
      showErr('qFormErr', 'Test cases must be valid JSON');
      return;
    }
  }

  try {
    if (editingId) {
      await aapi(`/api/admin/questions/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await aapi('/api/admin/questions', { method: 'POST', body: JSON.stringify(payload) });
    }
    document.getElementById('qForm').style.display = 'none';
    editingId = null;
    loadQuestions();
  } catch (e) {
    showErr('qFormErr', e.message);
  }
});

// Pagination event listeners
document.getElementById('qPrevPageBtn').addEventListener('click', () => {
  if (qCurrentPage > 1) {
    qCurrentPage--;
    loadQuestions();
  }
});
document.getElementById('qNextPageBtn').addEventListener('click', () => {
  if (qCurrentPage < qTotalPages) {
    qCurrentPage++;
    loadQuestions();
  }
});

// Filter apply & reset
document.getElementById('qFilterApplyBtn').addEventListener('click', () => {
  qCurrentPage = 1;
  loadQuestions();
});
document.getElementById('qFilterResetBtn').addEventListener('click', () => {
  document.getElementById('q_search').value = '';
  document.getElementById('q_filter_status').value = 'ALL';
  document.getElementById('q_filter_difficulty').value = 'ALL';
  document.getElementById('q_filter_type').value = 'ALL';
  document.getElementById('q_filter_category').value = 'ALL';
  qCurrentPage = 1;
  loadQuestions();
});

// Export CSV handler
document.getElementById('exportCsvBtn').addEventListener('click', async () => {
  try {
    const token = getAuthToken();
    const res = await fetch('/api/admin/questions/export', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aspire-questions-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    alert(err.message || 'Export error');
  }
});

// Import CSV Modal handlers
document.getElementById('importCsvBtn').addEventListener('click', () => {
  document.getElementById('csvTextInput').value = '';
  document.getElementById('csvFileInput').value = '';
  document.getElementById('csvPreviewOutput').style.display = 'none';
  document.getElementById('csvCommitBtn').style.display = 'none';
  document.getElementById('csvErr').style.display = 'none';
  document.getElementById('csvImportModal').style.display = 'flex';
});

document.getElementById('closeCsvModalBtn').addEventListener('click', () => {
  document.getElementById('csvImportModal').style.display = 'none';
});
document.getElementById('csvCancelBtn').addEventListener('click', () => {
  document.getElementById('csvImportModal').style.display = 'none';
});

document.getElementById('csvFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    document.getElementById('csvTextInput').value = evt.target.result;
  };
  reader.readAsText(file);
});

// CSV Preview
document.getElementById('csvPreviewBtn').addEventListener('click', async () => {
  const csv = document.getElementById('csvTextInput').value.trim();
  const errBox = document.getElementById('csvErr');
  errBox.style.display = 'none';
  if (!csv) {
    errBox.textContent = 'Please paste or upload CSV data first.';
    errBox.style.display = 'block';
    return;
  }
  try {
    const res = await aapi('/api/admin/questions/import/preview', {
      method: 'POST',
      body: JSON.stringify({ csv })
    });
    const d = res.data;
    const out = document.getElementById('csvPreviewOutput');
    out.innerHTML = `
      <b>CSV Preview Analysis:</b><br>
      Total parsed rows: <b>${d.totalRows}</b><br>
      Valid questions: <span style="color:var(--ok)"><b>${d.validCount}</b></span><br>
      Invalid rows: <span style="color:var(--bad)"><b>${d.invalidCount}</b></span><br>
      Potential duplicates: <span style="color:#92400E"><b>${d.duplicateCount}</b></span>
      ${d.failures && d.failures.length > 0 ? `<div style="color:var(--bad);margin-top:6px;font-size:12px">Errors on row(s): ${d.failures.map(f => `#${f.row}: ${f.message}`).join(', ')}</div>` : ''}
    `;
    out.style.display = 'block';

    if (d.validCount > 0) {
      document.getElementById('csvCommitBtn').style.display = 'inline-block';
    }
  } catch (err) {
    errBox.textContent = err.message || 'CSV preview failed';
    errBox.style.display = 'block';
  }
});

// CSV Confirm Commit
document.getElementById('csvCommitBtn').addEventListener('click', async () => {
  const csv = document.getElementById('csvTextInput').value.trim();
  try {
    const res = await aapi('/api/admin/questions/import', {
      method: 'POST',
      body: JSON.stringify({ csv })
    });
    alert(`Successfully imported ${res.data.importedCount} questions.`);
    document.getElementById('csvImportModal').style.display = 'none';
    loadQuestions();
  } catch (err) {
    const errBox = document.getElementById('csvErr');
    errBox.textContent = err.message || 'Import failed';
    errBox.style.display = 'block';
  }
});


/* ---------- Config ---------- */
async function loadConfig() {
  if (!hasPermission('settings.read')) return;
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
}

document.getElementById('saveCfgBtn').addEventListener('click', async () => {
  if (!hasPermission('settings.update')) return;
  const payload = {
    test_title: document.getElementById('c_title').value,
    duration_minutes: document.getElementById('c_duration').value,
    quota_aptitude: document.getElementById('c_q_apt').value,
    quota_technical: document.getElementById('c_q_tech').value,
    quota_coding: document.getElementById('c_q_code').value,
    shuffle_questions: document.getElementById('c_shuffle_q').checked ? '1' : '0',
    shuffle_options: document.getElementById('c_shuffle_o').checked ? '1' : '0',
    brand_name: document.getElementById('c_brand').value,
    accent_color: document.getElementById('c_accent').value
  };
  if (currentUser && currentUser.role === 'SUPER_ADMIN') {
    payload.scholarship_slabs = document.getElementById('c_slabs').value;
  }
  try {
    await aapi('/api/admin/config', { method: 'PUT', body: JSON.stringify(payload) });
    showOk('cfgOk', 'Configuration saved.');
  } catch (e) { showErr('cfgOk', e.message); }
});

/* ---------- Results ---------- */
async function loadResults() {
  if (!hasPermission('results.read')) return;
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

  const csvBtn = document.getElementById('csvBtn');
  if (csvBtn && hasPermission('results.export')) {
    csvBtn.onclick = (e) => {
      e.preventDefault();
      fetch(`/api/admin/results.csv?${p.toString()}`, {
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      })
        .then((r) => { if (!r.ok) throw new Error('Export failed'); return r.blob(); })
        .then((b) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = 'aspire-results.csv';
          a.click();
        }).catch((err) => alert(err.message));
    };
  }
}
document.getElementById('filterBtn').addEventListener('click', loadResults);

/* ---------- College report ---------- */
document.getElementById('repBtn').addEventListener('click', async () => {
  if (!hasPermission('analytics.read')) return;
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

/* ---------- User Management ---------- */
async function loadUsers() {
  if (!hasPermission('users.read')) return;
  const users = await aapi('/api/admin/users');
  const tb = document.getElementById('usersBody');
  const canDisable = hasPermission('users.disable');

  tb.innerHTML = users.map((u) => {
    let actionBtn = '';
    if (canDisable) {
      if (u.status === 'ACTIVE') {
        actionBtn = `<button class="btn small ghost" onclick="toggleUser(${u.id}, 'disable')">Disable</button>`;
      } else {
        actionBtn = `<button class="btn small ghost" onclick="toggleUser(${u.id}, 'enable')">Enable</button>`;
      }
    }
    return `<tr>
      <td>${u.id}</td>
      <td>${esc(u.name)}</td>
      <td>${esc(u.email)}</td>
      <td><span class="tag">${esc(u.role)}</span></td>
      <td><span style="color:${u.status === 'ACTIVE' ? 'var(--accent, #F97316)' : 'gray'}">${esc(u.status)}</span></td>
      <td>${esc((u.last_login_at || 'Never').slice(0, 16))}</td>
      <td>${actionBtn || '—'}</td>
    </tr>`;
  }).join('');
}

document.getElementById('addUserBtn').addEventListener('click', () => {
  document.getElementById('userForm').style.display = 'block';
});
document.getElementById('cancelUserBtn').addEventListener('click', () => {
  document.getElementById('userForm').style.display = 'none';
  document.getElementById('userErr').style.display = 'none';
});

document.getElementById('saveUserBtn').addEventListener('click', async () => {
  const name = document.getElementById('u_name').value.trim();
  const email = document.getElementById('u_email').value.trim();
  const password = document.getElementById('u_password').value;
  const role = document.getElementById('u_role').value;
  const errBox = document.getElementById('userErr');
  errBox.style.display = 'none';

  try {
    await aapi('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, role })
    });
    document.getElementById('userForm').style.display = 'none';
    document.getElementById('u_name').value = '';
    document.getElementById('u_email').value = '';
    document.getElementById('u_password').value = '';
    loadUsers();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  }
});

window.toggleUser = async (id, action) => {
  if (!confirm(`${action === 'disable' ? 'Disable' : 'Enable'} user #${id}?`)) return;
  try {
    await aapi(`/api/admin/users/${id}/${action}`, { method: 'POST' });
    loadUsers();
  } catch (e) {
    alert(e.message);
  }
};

/* ====================================================
   Exam Builder 2.0 Frontend Controller
==================================================== */
let examCurrentPage = 1;
let examTotalPages = 1;
let currentEditingExamId = null;
let currentExamData = null;
let currentBuilderStep = 1;

async function loadExams(page = 1) {
  if (!hasPermission('exams.read')) return;
  examCurrentPage = page;

  const search = document.getElementById('examSearchInput')?.value.trim() || '';
  const status = document.getElementById('examStatusFilter')?.value || '';

  const params = new URLSearchParams({ page, limit: 10 });
  if (search) params.set('search', search);
  if (status) params.set('status', status);

  try {
    const res = await aapi(`/api/admin/exams?${params.toString()}`);
    const items = res.data?.items || [];
    const pagination = res.data?.pagination || { page: 1, limit: 10, total: 0, totalPages: 1 };

    examTotalPages = pagination.totalPages;
    const tbody = document.getElementById('examsBody');
    tbody.innerHTML = '';

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">No exams found. Click "+ Create Exam" to start.</td></tr>';
      document.getElementById('examPaginationInfo').textContent = 'Showing 0 of 0 exams';
      document.getElementById('examPrevPageBtn').disabled = true;
      document.getElementById('examNextPageBtn').disabled = true;
      return;
    }

    items.forEach((e) => {
      const tr = document.createElement('tr');
      const statusClass = `status-${(e.status || 'draft').toLowerCase()}`;
      const canEdit = hasPermission('exams.update');
      const canPublish = hasPermission('exams.publish');

      let actionHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap">`;
      actionHtml += `<button class="btn small ghost" onclick="openExamPreview(${e.id})">Preview</button>`;

      if (canEdit && (e.status === 'DRAFT' || e.status === 'REVIEW')) {
        actionHtml += `<button class="btn small ghost" onclick="openExamBuilder(${e.id})">Edit</button>`;
      }

      if (canPublish && (e.status === 'DRAFT' || e.status === 'REVIEW')) {
        actionHtml += `<button class="btn small" style="background:var(--success, #059669)" onclick="publishExamQuick(${e.id})">Publish</button>`;
      }

      if (canPublish && e.status === 'PUBLISHED') {
        actionHtml += `<button class="btn small" style="background:#2563EB" onclick="makeExamLiveQuick(${e.id})">Go Live</button>`;
      }

      if (canPublish && (e.status === 'LIVE' || e.status === 'PUBLISHED')) {
        actionHtml += `<button class="btn small ghost" onclick="closeExamQuick(${e.id})">Close</button>`;
      }

      if (canPublish && e.status === 'CLOSED') {
        actionHtml += `<button class="btn small ghost" style="color:#2563EB" onclick="makeExamLiveQuick(${e.id})">Reopen</button>`;
      }

      if (canEdit && e.status !== 'ARCHIVED' && e.status !== 'DRAFT') {
        actionHtml += `<button class="btn small ghost" onclick="versionExamQuick(${e.id})">+ v${e.version + 1}</button>`;
      }

      if (canEdit && e.status !== 'ARCHIVED') {
        actionHtml += `<button class="btn small ghost" style="color:var(--danger, #DC2626)" onclick="archiveExamQuick(${e.id})">Archive</button>`;
      }

      if (canEdit && e.status === 'ARCHIVED') {
        actionHtml += `<button class="btn small ghost" onclick="versionExamQuick(${e.id})">+ New Version</button>`;
      }

      actionHtml += `</div>`;

      tr.innerHTML = `
        <td>
          <strong>${esc(e.name)}</strong>
          <div style="font-family:monospace;font-size:12px;color:var(--muted)">${esc(e.code)}</div>
        </td>
        <td><span class="status-badge ${statusClass}">${esc(e.status)}</span></td>
        <td>v${e.version}</td>
        <td>${e.section_count || 0}</td>
        <td>${e.duration_minutes}m</td>
        <td>${e.total_marks || 0}</td>
        <td>${e.passing_score}%</td>
        <td>${actionHtml}</td>
      `;
      tbody.appendChild(tr);
    });

    const start = (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.total, pagination.page * pagination.limit);
    document.getElementById('examPaginationInfo').textContent = `Showing ${start}-${end} of ${pagination.total} exams`;
    document.getElementById('examCurrentPage').textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
    document.getElementById('examPrevPageBtn').disabled = pagination.page <= 1;
    document.getElementById('examNextPageBtn').disabled = pagination.page >= pagination.totalPages;

  } catch (err) {
    console.error('Failed to load exams', err);
  }
}

// Filter listeners for exams
document.getElementById('applyExamFiltersBtn')?.addEventListener('click', () => loadExams(1));
document.getElementById('resetExamFiltersBtn')?.addEventListener('click', () => {
  document.getElementById('examSearchInput').value = '';
  document.getElementById('examStatusFilter').value = '';
  loadExams(1);
});
document.getElementById('examPrevPageBtn')?.addEventListener('click', () => {
  if (examCurrentPage > 1) loadExams(examCurrentPage - 1);
});
document.getElementById('examNextPageBtn')?.addEventListener('click', () => {
  if (examCurrentPage < examTotalPages) loadExams(examCurrentPage + 1);
});

// Step navigation in Exam Builder
function showBuilderStep(step) {
  currentBuilderStep = step;
  document.querySelectorAll('.builder-step').forEach((el, idx) => {
    el.style.display = (idx + 1 === step) ? 'block' : 'none';
  });
  document.querySelectorAll('#examBuilderModal .tab').forEach((t) => {
    const s = parseInt(t.dataset.step, 10);
    t.classList.toggle('active', s === step);
  });
}

document.querySelectorAll('#examBuilderModal .tab').forEach((t) => {
  t.addEventListener('click', () => {
    const step = parseInt(t.dataset.step, 10);
    if (step > 1 && !currentEditingExamId) {
      alert('Please save Basic Information first.');
      return;
    }
    showBuilderStep(step);
    if (step === 2) renderBuilderSections();
    if (step === 3) renderBuilderSlabs();
    if (step === 4) renderBuilderReview();
  });
});

document.querySelectorAll('.back-step-btn').forEach((b) => {
  b.addEventListener('click', () => showBuilderStep(parseInt(b.dataset.back, 10)));
});
document.querySelectorAll('.next-step-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const next = parseInt(b.dataset.next, 10);
    showBuilderStep(next);
    if (next === 2) renderBuilderSections();
    if (next === 3) renderBuilderSlabs();
    if (next === 4) renderBuilderReview();
  });
});

// Open Exam Builder
window.openExamBuilder = async (examId = null) => {
  currentEditingExamId = examId;
  const modal = document.getElementById('examBuilderModal');
  const errBox = document.getElementById('builderGlobalErr');
  errBox.style.display = 'none';

  if (!examId) {
    document.getElementById('builderModalTitle').textContent = 'Create New Exam';
    document.getElementById('eb_name').value = '';
    document.getElementById('eb_code').value = '';
    document.getElementById('eb_desc').value = '';
    document.getElementById('eb_duration').value = 90;
    document.getElementById('eb_passing').value = 40;
    document.getElementById('eb_attempts').value = 1;
    document.getElementById('eb_shuffle_q').checked = true;
    document.getElementById('eb_shuffle_o').checked = true;
    currentExamData = null;
    showBuilderStep(1);
  } else {
    document.getElementById('builderModalTitle').textContent = 'Edit Exam';
    try {
      const res = await aapi(`/api/admin/exams/${examId}`);
      currentExamData = res.data;
      document.getElementById('eb_name').value = currentExamData.name || '';
      document.getElementById('eb_code').value = currentExamData.code || '';
      document.getElementById('eb_desc').value = currentExamData.description || '';
      document.getElementById('eb_duration').value = currentExamData.duration_minutes || 90;
      document.getElementById('eb_passing').value = currentExamData.passing_score || 40;
      document.getElementById('eb_attempts').value = currentExamData.max_attempts || 1;
      document.getElementById('eb_shuffle_q').checked = currentExamData.shuffle_questions !== 0;
      document.getElementById('eb_shuffle_o').checked = currentExamData.shuffle_options !== 0;
      showBuilderStep(1);
    } catch (err) {
      alert(err.message);
      return;
    }
  }
  modal.style.display = 'block';
};

document.getElementById('createExamBtn')?.addEventListener('click', () => openExamBuilder(null));
document.getElementById('closeBuilderModalBtn')?.addEventListener('click', () => {
  document.getElementById('examBuilderModal').style.display = 'none';
  loadExams(examCurrentPage);
});

// Step 1: Save & Next
document.getElementById('step1SaveNextBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('eb_name').value.trim();
  const code = document.getElementById('eb_code').value.trim().toUpperCase();
  const description = document.getElementById('eb_desc').value.trim();
  const duration_minutes = parseInt(document.getElementById('eb_duration').value, 10);
  const passing_score = parseFloat(document.getElementById('eb_passing').value);
  const max_attempts = parseInt(document.getElementById('eb_attempts').value, 10);
  const shuffle_questions = document.getElementById('eb_shuffle_q').checked;
  const shuffle_options = document.getElementById('eb_shuffle_o').checked;

  const errBox = document.getElementById('builderGlobalErr');
  errBox.style.display = 'none';

  if (!name || name.length < 3) {
    errBox.textContent = 'Exam name must be at least 3 characters.';
    errBox.style.display = 'block';
    return;
  }
  if (!code || code.length < 3) {
    errBox.textContent = 'Exam code must be at least 3 characters.';
    errBox.style.display = 'block';
    return;
  }

  try {
    if (!currentEditingExamId) {
      const res = await aapi('/api/admin/exams', {
        method: 'POST',
        body: JSON.stringify({ name, code, description, duration_minutes, passing_score, max_attempts, shuffle_questions, shuffle_options })
      });
      currentEditingExamId = res.data.id;
      currentExamData = res.data;
    } else {
      const res = await aapi(`/api/admin/exams/${currentEditingExamId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, code, description, duration_minutes, passing_score, max_attempts, shuffle_questions, shuffle_options, expected_version: currentExamData?.version })
      });
      currentExamData = res.data;
    }
    showBuilderStep(2);
    renderBuilderSections();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// Step 2: Render Sections
async function renderBuilderSections() {
  if (!currentEditingExamId) return;
  try {
    const res = await aapi(`/api/admin/exams/${currentEditingExamId}`);
    currentExamData = res.data;
    const container = document.getElementById('sectionsListContainer');
    container.innerHTML = '';

    const sections = currentExamData.sections || [];
    if (sections.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px;border:1px dashed var(--line);border-radius:6px">No sections configured yet. Click "+ Add Section" above.</div>';
      return;
    }

    sections.forEach((s, idx) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.sectionId = s.id;
      card.style.background = '#FAFAFA';
      card.style.border = '1px solid var(--line)';
      card.style.padding = '14px';

      let contentHtml = '';
      if (s.question_selection_mode === 'MANUAL') {
        const qs = s.questions || [];
        contentHtml = `
          <div style="margin-top:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-size:12px;font-weight:600;color:var(--muted)">ATTACHED QUESTIONS (${qs.length})</span>
              <button class="btn small ghost" onclick="promptAddQuestionToSection(${s.id})">+ Add Question ID</button>
            </div>
            ${qs.length === 0 ? '<div style="font-size:12px;color:var(--muted)">No questions attached yet.</div>' :
              qs.map(q => `
                <div style="display:flex;justify-content:space-between;align-items:center;background:#fff;padding:6px 10px;margin-bottom:4px;border:1px solid var(--line);border-radius:4px;font-size:13px">
                  <span>#${q.id} [${esc(q.type)}] ${esc(q.question_text.substring(0, 60))}... (<strong>${q.marks}m</strong>)</span>
                  <button class="btn small ghost" style="color:red;padding:2px 6px" onclick="removeQuestionFromSec(${s.id}, ${q.id})">&times;</button>
                </div>
              `).join('')}
          </div>
        `;
      } else {
        const rules = s.rules || [];
        contentHtml = `
          <div style="margin-top:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-size:12px;font-weight:600;color:var(--muted)">SELECTION RULES (${rules.length})</span>
              <button class="btn small ghost" onclick="promptAddRuleToSection(${s.id})">+ Add Rule</button>
            </div>
            ${rules.length === 0 ? '<div style="font-size:12px;color:var(--muted)">No rules configured yet.</div>' :
              rules.map(r => `
                <div style="display:flex;justify-content:space-between;align-items:center;background:#fff;padding:6px 10px;margin-bottom:4px;border:1px solid var(--line);border-radius:4px;font-size:13px">
                  <span>Sample <strong>${r.count}</strong> questions (Type: ${esc(r.type || 'ANY')}, Cat: ${esc(r.category || 'ANY')}, Diff: ${esc(r.difficulty || 'ANY')}) &mdash; ${r.marks_per_question} marks each</span>
                  <button class="btn small ghost" style="color:red;padding:2px 6px" onclick="removeRuleFromSec(${s.id}, ${r.id})">&times;</button>
                </div>
              `).join('')}
          </div>
        `;
      }

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="handle" style="cursor:grab;color:var(--muted);font-size:16px">&#9776;</span>
            <span style="font-weight:600">${idx + 1}. ${esc(s.name)}</span>
            <span class="tag">${s.question_selection_mode}</span>
            <span style="font-size:12px;color:var(--muted)">(${s.total_questions || 0} questions &middot; ${s.total_marks || 0} marks)</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn small ghost" onclick="moveSectionOrder(${s.id}, 'up')" ${idx === 0 ? 'disabled' : ''}>&uarr;</button>
            <button class="btn small ghost" onclick="moveSectionOrder(${s.id}, 'down')" ${idx === sections.length - 1 ? 'disabled' : ''}>&darr;</button>
            <button class="btn small ghost" style="color:red" onclick="deleteSectionConfirm(${s.id})">Delete</button>
          </div>
        </div>
        ${s.description ? `<div style="font-size:12px;color:var(--muted);margin:4px 0 0 26px">${esc(s.description)}</div>` : ''}
        ${contentHtml}
      `;
      container.appendChild(card);
    });

    // Initialize SortableJS if loaded
    if (typeof Sortable !== 'undefined') {
      new Sortable(container, {
        handle: '.handle',
        animation: 150,
        onEnd: async () => {
          const newOrder = Array.from(container.children).map(c => parseInt(c.dataset.sectionId, 10));
          await aapi(`/api/admin/exams/${currentEditingExamId}/sections-reorder`, {
            method: 'PUT',
            body: JSON.stringify({ sectionIds: newOrder })
          });
          renderBuilderSections();
        }
      });
    }

  } catch (err) {
    console.error('Failed to render sections', err);
  }
}

// Section inline controls
document.getElementById('addSectionPromptBtn')?.addEventListener('click', () => {
  document.getElementById('newSectionBox').style.display = 'block';
});
document.getElementById('cancelSectionBtn')?.addEventListener('click', () => {
  document.getElementById('newSectionBox').style.display = 'none';
});
document.getElementById('saveSectionBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('sec_name').value.trim();
  const question_selection_mode = document.getElementById('sec_mode').value;
  const description = document.getElementById('sec_desc').value.trim();

  if (!name) return alert('Section name is required');
  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections`, {
      method: 'POST',
      body: JSON.stringify({ name, question_selection_mode, description })
    });
    document.getElementById('newSectionBox').style.display = 'none';
    document.getElementById('sec_name').value = '';
    document.getElementById('sec_desc').value = '';
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
});

window.moveSectionOrder = async (sectionId, direction) => {
  const sections = currentExamData.sections || [];
  const idx = sections.findIndex(s => s.id === sectionId);
  if (idx < 0) return;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= sections.length) return;

  const order = sections.map(s => s.id);
  const temp = order[idx];
  order[idx] = order[targetIdx];
  order[targetIdx] = temp;

  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections-reorder`, {
      method: 'PUT',
      body: JSON.stringify({ sectionIds: order })
    });
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
};

window.deleteSectionConfirm = async (sectionId) => {
  if (!confirm('Are you sure you want to delete this section?')) return;
  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections/${sectionId}`, { method: 'DELETE' });
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
};

window.promptAddQuestionToSection = async (sectionId) => {
  const qidStr = prompt('Enter the Question ID from the Question Bank to attach:');
  if (!qidStr) return;
  const question_id = parseInt(qidStr, 10);
  if (isNaN(question_id) || question_id <= 0) return alert('Please enter a valid numeric Question ID');

  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections/${sectionId}/questions`, {
      method: 'POST',
      body: JSON.stringify({ question_id })
    });
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
};

window.removeQuestionFromSec = async (sectionId, questionId) => {
  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections/${sectionId}/questions/${questionId}`, { method: 'DELETE' });
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
};

window.promptAddRuleToSection = async (sectionId) => {
  const countStr = prompt('How many questions should this rule select?', '5');
  if (!countStr) return;
  const count = parseInt(countStr, 10) || 5;

  const category = prompt('Category filter (e.g. aptitude, technical, coding, or blank for any):', 'technical');
  const type = prompt('Type filter (MCQ, CODING, or blank for any):', 'MCQ');
  const difficulty = prompt('Difficulty filter (EASY, MEDIUM, HARD, or blank for any):', 'MEDIUM');
  const marksStr = prompt('Marks per question:', '2');
  const marks_per_question = parseFloat(marksStr) || 1;

  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections/${sectionId}/rules`, {
      method: 'POST',
      body: JSON.stringify({
        count,
        category: category?.trim() || null,
        type: type?.trim().toUpperCase() || null,
        difficulty: difficulty?.trim().toUpperCase() || null,
        marks_per_question
      })
    });
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
};

window.removeRuleFromSec = async (sectionId, ruleId) => {
  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/sections/${sectionId}/rules/${ruleId}`, { method: 'DELETE' });
    renderBuilderSections();
  } catch (err) {
    alert(err.message);
  }
};

// Step 3: Scholarship Slabs
async function renderBuilderSlabs() {
  if (!currentEditingExamId) return;
  const tbody = document.getElementById('slabsConfigBody');
  tbody.innerHTML = '';

  const slabs = currentExamData.scholarship_slabs || [
    { min_score_pct: 90, max_score_pct: 100, discount_pct: 100, tier_name: 'Tier 1 (100% Scholarship)' },
    { min_score_pct: 75, max_score_pct: 89.99, discount_pct: 50, tier_name: 'Tier 2 (50% Scholarship)' },
    { min_score_pct: 60, max_score_pct: 74.99, discount_pct: 25, tier_name: 'Tier 3 (25% Scholarship)' },
    { min_score_pct: 40, max_score_pct: 59.99, discount_pct: 10, tier_name: 'Tier 4 (10% Scholarship)' },
    { min_score_pct: 0, max_score_pct: 39.99, discount_pct: 0, tier_name: 'No Scholarship' }
  ];

  slabs.forEach((s) => {
    addSlabRow(s.min_score_pct, s.max_score_pct, s.discount_pct, s.tier_name);
  });
}

function addSlabRow(min = 0, max = 100, disc = 0, name = '') {
  const tbody = document.getElementById('slabsConfigBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="number" min="0" max="100" class="slab-min" value="${min}" style="width:70px;margin:0"></td>
    <td><input type="number" min="0" max="100" class="slab-max" value="${max}" style="width:70px;margin:0"></td>
    <td><input type="number" min="0" max="100" class="slab-disc" value="${disc}" style="width:70px;margin:0"></td>
    <td><input type="text" class="slab-name" value="${esc(name)}" placeholder="Label" style="margin:0"></td>
    <td><button class="btn small ghost" style="color:red" onclick="this.closest('tr').remove()">&times;</button></td>
  `;
  tbody.appendChild(tr);
}

document.getElementById('addSlabRowBtn')?.addEventListener('click', () => addSlabRow());

document.getElementById('saveSlabsAndContinueBtn')?.addEventListener('click', async () => {
  const rows = Array.from(document.querySelectorAll('#slabsConfigBody tr'));
  const slabs = rows.map((tr) => ({
    min_score_pct: parseFloat(tr.querySelector('.slab-min').value) || 0,
    max_score_pct: parseFloat(tr.querySelector('.slab-max').value) || 0,
    discount_pct: parseFloat(tr.querySelector('.slab-disc').value) || 0,
    tier_name: tr.querySelector('.slab-name').value.trim()
  }));

  try {
    const res = await aapi(`/api/admin/exams/${currentEditingExamId}/scholarship-slabs`, {
      method: 'PUT',
      body: JSON.stringify({ slabs })
    });
    currentExamData = res.data;
    showBuilderStep(4);
    renderBuilderReview();
  } catch (err) {
    alert(err.message);
  }
});

// Step 4: Review & Publish Validation
async function renderBuilderReview() {
  if (!currentEditingExamId) return;
  const statusBox = document.getElementById('publishValidationResults');
  const summaryBox = document.getElementById('examReviewSummaryCard');

  try {
    const res = await aapi(`/api/admin/exams/${currentEditingExamId}/preview`);
    const { exam, publishStatus } = res.data;
    currentExamData = exam;

    if (publishStatus.publishable) {
      statusBox.innerHTML = `
        <div class="okmsg" style="padding:10px;margin-bottom:12px;background:#ECFDF5;color:#065F46;border-radius:6px">
          &#10003; <strong>Ready to Publish:</strong> All sections, question pools, and scoring thresholds are valid.
        </div>
      `;
      document.getElementById('builderPublishBtn').disabled = false;
    } else {
      statusBox.innerHTML = `
        <div class="err" style="padding:10px;margin-bottom:12px">
          <strong>Cannot publish yet:</strong>
          <ul style="margin:6px 0 0 16px;padding:0">
            ${(publishStatus.errors || []).map(e => `<li>${esc(e)}</li>`).join('')}
          </ul>
        </div>
      `;
      document.getElementById('builderPublishBtn').disabled = true;
    }

    summaryBox.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <div><strong>Exam:</strong> ${esc(exam.name)} (<code>${esc(exam.code)}</code>)</div>
        <div><strong>Status:</strong> <span class="status-badge status-${exam.status.toLowerCase()}">${esc(exam.status)}</span></div>
        <div><strong>Version:</strong> v${exam.version}</div>
      </div>
      <div class="row" style="margin-bottom:10px">
        <div><strong>Duration:</strong> ${exam.duration_minutes} minutes</div>
        <div><strong>Total Marks:</strong> ${exam.total_marks || 0}</div>
        <div><strong>Passing Score:</strong> ${exam.passing_score}%</div>
        <div><strong>Max Attempts:</strong> ${exam.max_attempts}</div>
      </div>
      <div style="font-size:13px;color:var(--muted)">
        ${(exam.sections || []).map((s, i) => `${i + 1}. ${esc(s.name)} (${s.total_questions || 0}Q, ${s.total_marks || 0} marks)`).join(' &middot; ')}
      </div>
    `;

  } catch (err) {
    statusBox.innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
}

// Publish Exam in Builder
document.getElementById('builderPublishBtn')?.addEventListener('click', async () => {
  if (!confirm(`Are you sure you want to publish "${currentExamData?.name}"? Candidates will immediately be able to take this assessment.`)) return;
  try {
    await aapi(`/api/admin/exams/${currentEditingExamId}/publish`, { method: 'POST' });
    alert('Exam published successfully!');
    document.getElementById('examBuilderModal').style.display = 'none';
    loadExams(examCurrentPage);
  } catch (err) {
    alert(err.message);
  }
});

// Quick action handlers
window.publishExamQuick = async (id) => {
  if (!confirm('Publish this exam and make it available for assessments?')) return;
  try {
    await aapi(`/api/admin/exams/${id}/publish`, { method: 'POST' });
    loadExams(examCurrentPage);
  } catch (err) {
    alert(err.message);
  }
};

window.makeExamLiveQuick = async (id) => {
  if (!confirm('Transition this exam to LIVE? Candidates will be actively permitted to register and attempt.')) return;
  try {
    await aapi(`/api/admin/exams/${id}/live`, { method: 'POST' });
    loadExams(examCurrentPage);
  } catch (err) {
    alert(err.message);
  }
};

window.closeExamQuick = async (id) => {
  if (!confirm('Close this exam? New candidate attempts will be blocked, but existing attempts remain accessible.')) return;
  try {
    await aapi(`/api/admin/exams/${id}/close`, { method: 'POST' });
    loadExams(examCurrentPage);
  } catch (err) {
    alert(err.message);
  }
};

window.archiveExamQuick = async (id) => {
  if (!confirm('Archive this exam? Candidates will no longer be able to start new attempts.')) return;
  try {
    await aapi(`/api/admin/exams/${id}/archive`, { method: 'POST' });
    loadExams(examCurrentPage);
  } catch (err) {
    alert(err.message);
  }
};

window.versionExamQuick = async (id) => {
  if (!confirm('Create a new DRAFT version from this exam?')) return;
  try {
    const res = await aapi(`/api/admin/exams/${id}/version`, { method: 'POST' });
    alert(`Created new version: ${res.data.name} (${res.data.code})`);
    loadExams(1);
    openExamBuilder(res.data.id);
  } catch (err) {
    alert(err.message);
  }
};

// Exam Preview Modal Handler
window.openExamPreview = async (examId) => {
  try {
    const res = await aapi(`/api/admin/exams/${examId}/preview`);
    const exam = res.data.exam;
    const modal = document.getElementById('examPreviewModal');
    document.getElementById('previewModalTitle').textContent = exam.name;
    document.getElementById('previewModalMeta').textContent = `Code: ${exam.code} · Duration: ${exam.duration_minutes}m · Total Marks: ${exam.total_marks} · Passing: ${exam.passing_score}%`;

    const content = document.getElementById('examPreviewContent');
    let html = `<div style="display:flex;flex-direction:column;gap:16px">`;

    (exam.sections || []).forEach((s, idx) => {
      html += `
        <div class="card" style="background:#F9FAFB;padding:14px;border:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h4 style="margin:0">${idx + 1}. ${esc(s.name)}</h4>
            <span class="tag">${s.question_selection_mode} (${s.total_questions || 0} questions &middot; ${s.total_marks || 0} marks)</span>
          </div>
          ${s.description ? `<p style="font-size:12px;color:var(--muted);margin:0 0 10px 0">${esc(s.description)}</p>` : ''}
          ${s.question_selection_mode === 'MANUAL' && s.questions ?
            s.questions.map((q, qi) => `
              <div style="background:#fff;padding:8px;border-radius:4px;margin-bottom:6px;border:1px solid var(--line)">
                <div style="font-size:13px;font-weight:600">Q${qi + 1}. [${esc(q.type)}] ${esc(q.question_text)} (${q.marks} marks)</div>
              </div>
            `).join('') :
            `<div style="font-size:13px;color:var(--muted)">Random pool selection from question bank (${s.rules?.length || 0} active rules).</div>`
          }
        </div>
      `;
    });

    html += `</div>`;
    content.innerHTML = html;
    modal.style.display = 'block';

  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('closeExamPreviewBtn')?.addEventListener('click', () => {
  document.getElementById('examPreviewModal').style.display = 'none';
});
document.getElementById('builderPreviewExamBtn')?.addEventListener('click', () => {
  if (currentEditingExamId) openExamPreview(currentEditingExamId);
});

// Initial boot
gate();

