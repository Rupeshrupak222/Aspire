// Aspire Admin Panel — Authentication, RBAC, and Role-Aware Navigation.
const ADMIN_AUTH_TOKEN_KEY = 'aspire_auth_token';
const USER_KEY = 'aspire_auth_user';

let currentUser = null;

function getAuthToken() {
  return localStorage.getItem(ADMIN_AUTH_TOKEN_KEY) || '';
}

function setSession(token, user) {
  if (token) localStorage.setItem(ADMIN_AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(ADMIN_AUTH_TOKEN_KEY);

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

  // SaaS Analytics Dashboard tab (Day 18)
  const canDashboard = canAnalytics || canResults || canExams || role === 'SUPER_ADMIN' || role === 'ORG_ADMIN' || role === 'EXAM_MANAGER' || role === 'VIEWER';
  const dashTab = document.getElementById('tab-dashboard');
  if (dashTab) dashTab.style.display = canDashboard ? 'inline-block' : 'none';

  const examTab = document.getElementById('tab-exams');
  if (examTab) examTab.style.display = canExams ? 'inline-block' : 'none';
  const createExamBtn = document.getElementById('createExamBtn');
  if (createExamBtn) createExamBtn.style.display = permissions.includes('exams.create') ? 'inline-block' : 'none';

  document.getElementById('tab-questions').style.display = canQuestions ? 'inline-block' : 'none';
  document.getElementById('tab-config').style.display = canConfig ? 'inline-block' : 'none';
  document.getElementById('tab-results').style.display = canResults ? 'inline-block' : 'none';
  document.getElementById('tab-report').style.display = canAnalytics ? 'inline-block' : 'none';
  document.getElementById('tab-users').style.display = canUsers ? 'inline-block' : 'none';

  // Organizations tab (Platform SUPER_ADMIN only)
  const orgsTab = document.getElementById('tab-organizations');
  if (orgsTab) orgsTab.style.display = role === 'SUPER_ADMIN' ? 'inline-block' : 'none';

  // Branding & Profile tab (Organization Admin or tenant member)
  const brandingTab = document.getElementById('tab-branding');
  if (brandingTab) {
    brandingTab.style.display = (role === 'ORG_ADMIN' || (currentUser && currentUser.organization_id)) ? 'inline-block' : 'none';
  }

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
  if (canDashboard) switchTab('dashboard');
  else if (canExams) switchTab('exams');
  else if (canQuestions) switchTab('questions');
  else if (canResults) switchTab('results');
  else if (canAnalytics) switchTab('report');
  else if (canConfig) switchTab('config');
  else if (canUsers) switchTab('users');
  else if (role === 'SUPER_ADMIN') switchTab('organizations');
  else if (brandingTab && brandingTab.style.display !== 'none') switchTab('branding');
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
  if (name === 'dashboard') loadDashboard();
  if (name === 'exams') loadExams();
  if (name === 'questions') loadQuestions();
  if (name === 'config') loadConfig();
  if (name === 'results') loadResults();
  if (name === 'users') loadUsers();
  if (name === 'organizations') loadOrganizations();
  if (name === 'branding') loadOrgBranding();
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
  document.getElementById('resBody').innerHTML = rows.map((r) => {
    const riskLevel = r.proctoring_risk_level || 'NORMAL';
    const riskScore = r.proctoring_risk_score || 0;
    let badgeColor = '#10B981';
    if (riskLevel === 'WARNING') badgeColor = '#F59E0B';
    else if (riskLevel === 'SUSPICIOUS') badgeColor = '#F97316';
    else if (riskLevel === 'HIGH_RISK') badgeColor = '#EF4444';

    const riskBadge = `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:12px;font-weight:600;background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}44">${riskLevel} (${riskScore} pts)</span>`;

    return `<tr>
      <td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.college || '')}</td>
      <td>${esc(r.track || '')}</td><td>${r.score}/${r.total_marks}</td>
      <td>${Number(r.percentage).toFixed(1)}%</td><td>${r.scholarship_pct}%</td>
      <td>${esc(r.claim_code || '')}</td>
      <td>${riskBadge}</td>
      <td>${esc((r.submitted_at || '').slice(0, 16))}</td>
      <td><button class="btn small ghost" onclick="inspectProctoring(${r.attempt_id})">Inspect</button></td>
    </tr>`;
  }).join('');

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

/* ---------- Proctoring Behavioral Analytics Modal (Day 11) ---------- */
async function inspectProctoring(attemptId) {
  if (!hasPermission('results.read')) return;
  const modal = document.getElementById('proctoringModal');
  const title = document.getElementById('procModalTitle');
  const meta = document.getElementById('procModalMeta');
  const body = document.getElementById('procModalBody');

  body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted)">Loading proctoring timeline…</div>';
  modal.style.display = 'block';

  try {
    const res = await aapi(`/api/admin/attempts/${attemptId}/proctoring`);
    const d = res.data;

    title.textContent = `Proctoring Analytics — ${d.candidate.name || 'Candidate'}`;
    meta.textContent = `${d.candidate.phone || ''} · ${d.examName || 'Assessment'} · Attempt #${d.attemptId}`;

    const risk = d.risk || { score: 0, level: 'NORMAL' };
    let badgeColor = '#10B981';
    if (risk.level === 'WARNING') badgeColor = '#F59E0B';
    else if (risk.level === 'SUSPICIOUS') badgeColor = '#F97316';
    else if (risk.level === 'HIGH_RISK') badgeColor = '#EF4444';

    const breakdown = (d.summary && d.summary.breakdown) || {};
    const breakdownItems = Object.entries(breakdown).map(([type, stats]) => `
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:8px 12px;min-width:140px">
        <div style="font-size:12px;color:var(--muted)">${esc(type)}</div>
        <div style="font-size:16px;font-weight:700">${stats.count} <span style="font-size:12px;font-weight:normal;color:${stats.points > 0 ? '#EF4444' : '#64748B'}">(+${stats.points} pts)</span></div>
      </div>
    `).join('');

    const timelineRows = (d.timeline || []).map((e, idx) => {
      let metaStr = '';
      if (e.metadata) {
        metaStr = Object.entries(e.metadata).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(String(v))}`).join(' · ');
      }
      return `<tr>
        <td style="font-size:12px;color:var(--muted)">${idx + 1}</td>
        <td style="font-size:12px">${esc(new Date(e.timestamp).toLocaleTimeString())}</td>
        <td><b>${esc(e.eventType)}</b></td>
        <td>${e.riskPoints > 0 ? `<span style="color:#EF4444;font-weight:600">+${e.riskPoints}</span>` : '<span style="color:#64748B">0</span>'}</td>
        <td style="font-size:13px">${metaStr || '<span style="color:var(--muted)">—</span>'}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#F1F5F9;padding:12px 16px;border-radius:8px;margin-bottom:16px">
        <div>
          <div style="font-size:13px;color:var(--muted)">Risk Assessment Score</div>
          <div style="font-size:24px;font-weight:800;color:${badgeColor}">${risk.score} <span style="font-size:16px;font-weight:600">(${risk.level})</span></div>
        </div>
        <div>
          <span style="font-size:13px;color:var(--muted)">Status: <b>${esc(d.status)}</b> · Tab switches: <b>${d.tabSwitches}</b> · Total events: <b>${d.totalEvents}</b></span>
        </div>
      </div>

      <h4 style="margin:16px 0 8px">Event Breakdown</h4>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        ${breakdownItems || '<div style="color:var(--muted)">No events recorded</div>'}
      </div>

      <h4 style="margin:16px 0 8px">Chronological Behavioral Timeline (${d.totalEvents} events)</h4>
      <div style="max-height:360px;overflow-y:auto;border:1px solid #E2E8F0;border-radius:6px">
        <table class="data" style="margin:0">
          <thead><tr><th>#</th><th>Time</th><th>Event</th><th>Risk</th><th>Context</th></tr></thead>
          <tbody>
            ${timelineRows || '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--muted)">No proctoring events recorded for this attempt</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="err">Failed to load proctoring data: ${esc(err.message)}</div>`;
  }
}

document.getElementById('closeProcModalBtn')?.addEventListener('click', () => {
  document.getElementById('proctoringModal').style.display = 'none';
});

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

      if (hasPermission('analytics.read')) {
        actionHtml += `<button class="btn small" style="background:#4F46E5;color:#fff" onclick="openExamAnalytics(${e.id})">Analytics</button>`;
      }

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

// ---------------------------------------------------------------------------
// Day 17: Organization Management (SUPER_ADMIN)
// ---------------------------------------------------------------------------
let currentOrgPage = 1;
const orgLimit = 10;
let currentOrgSearch = '';
let currentOrgStatus = 'ALL';

async function loadOrganizations(page = 1, search = currentOrgSearch, status = currentOrgStatus) {
  if (currentUser?.role !== 'SUPER_ADMIN') return;
  currentOrgPage = page;
  currentOrgSearch = search;
  currentOrgStatus = status;

  try {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(orgLimit)
    });
    if (search) params.append('search', search);
    if (status && status !== 'ALL') params.append('status', status);

    const res = await aapi(`/api/admin/organizations?${params.toString()}`);
    const orgs = res.data || [];
    const pagination = res.pagination || { total: orgs.length, page: 1, limit: orgLimit, totalPages: 1 };

    const tb = document.getElementById('orgsBody');
    if (!tb) return;

    if (orgs.length === 0) {
      tb.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">No organizations found.</td></tr>`;
    } else {
      tb.innerHTML = orgs.map((org) => {
        const isSuspended = org.status === 'SUSPENDED';
        const statusBadge = isSuspended
          ? `<span class="tag" style="background:#FEE2E2;color:#991B1B">SUSPENDED</span>`
          : `<span class="tag" style="background:#DEF7EC;color:#03543F">ACTIVE</span>`;

        return `<tr>
          <td>${org.id}</td>
          <td>
            <strong>${esc(org.name)}</strong>
            ${org.email ? `<div style="font-size:12px;color:var(--muted)">${esc(org.email)}</div>` : ''}
          </td>
          <td><code>${esc(org.slug)}</code></td>
          <td>${esc(org.email || '-')}</td>
          <td>${statusBadge}</td>
          <td>${esc((org.created_at || '').slice(0, 10))}</td>
          <td>
            <div style="display:flex;gap:6px">
              <button class="btn small ghost" onclick="showOrgDetails(${org.id})">Details</button>
              <button class="btn small ${isSuspended ? '' : 'ghost'}" onclick="toggleOrgStatus(${org.id}, '${org.status}')">
                ${isSuspended ? 'Enable' : 'Disable'}
              </button>
            </div>
          </td>
        </tr>`;
      }).join('');
    }

    // Update pagination controls
    const info = document.getElementById('orgPaginationInfo');
    if (info) {
      const from = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
      const to = Math.min(pagination.page * pagination.limit, pagination.total);
      info.textContent = `Showing ${from}–${to} of ${pagination.total} organizations (Page ${pagination.page} of ${pagination.totalPages || 1})`;
    }

    const prevBtn = document.getElementById('orgPrevBtn');
    if (prevBtn) prevBtn.disabled = pagination.page <= 1;

    const nextBtn = document.getElementById('orgNextBtn');
    if (nextBtn) nextBtn.disabled = pagination.page >= (pagination.totalPages || 1);

  } catch (err) {
    const tb = document.getElementById('orgsBody');
    if (tb) tb.innerHTML = `<tr><td colspan="7" class="err" style="text-align:center">${esc(err.message)}</td></tr>`;
  }
}

// Search & filter event bindings
document.getElementById('orgSearchInput')?.addEventListener('input', (e) => {
  const val = e.target.value.trim();
  loadOrganizations(1, val, currentOrgStatus);
});

document.getElementById('orgStatusFilter')?.addEventListener('change', (e) => {
  loadOrganizations(1, currentOrgSearch, e.target.value);
});

document.getElementById('orgRefreshBtn')?.addEventListener('click', () => {
  loadOrganizations(currentOrgPage, currentOrgSearch, currentOrgStatus);
});

document.getElementById('orgPrevBtn')?.addEventListener('click', () => {
  if (currentOrgPage > 1) loadOrganizations(currentOrgPage - 1, currentOrgSearch, currentOrgStatus);
});

document.getElementById('orgNextBtn')?.addEventListener('click', () => {
  loadOrganizations(currentOrgPage + 1, currentOrgSearch, currentOrgStatus);
});

// Create Organization Modal bindings
const createOrgModal = document.getElementById('createOrgModal');
document.getElementById('createOrgBtn')?.addEventListener('click', () => {
  if (createOrgModal) {
    document.getElementById('m_org_name').value = '';
    document.getElementById('m_org_slug').value = '';
    document.getElementById('m_org_email').value = '';
    document.getElementById('m_org_phone').value = '';
    document.getElementById('m_org_website').value = '';
    document.getElementById('m_org_timezone').value = 'Asia/Kolkata';
    document.getElementById('m_org_status').value = 'ACTIVE';
    const errBox = document.getElementById('createOrgErr');
    if (errBox) errBox.style.display = 'none';
    createOrgModal.style.display = 'block';
  }
});

document.getElementById('closeCreateOrgModalBtn')?.addEventListener('click', () => {
  if (createOrgModal) createOrgModal.style.display = 'none';
});

document.getElementById('cancelCreateOrgBtn')?.addEventListener('click', () => {
  if (createOrgModal) createOrgModal.style.display = 'none';
});

document.getElementById('submitCreateOrgBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('m_org_name').value.trim();
  const slug = document.getElementById('m_org_slug').value.trim();
  const email = document.getElementById('m_org_email').value.trim();
  const phone = document.getElementById('m_org_phone').value.trim();
  const website = document.getElementById('m_org_website').value.trim();
  const timezone = document.getElementById('m_org_timezone').value;
  const status = document.getElementById('m_org_status').value;
  const errBox = document.getElementById('createOrgErr');

  if (errBox) errBox.style.display = 'none';
  if (!name) {
    if (errBox) { errBox.textContent = 'Organization name is required.'; errBox.style.display = 'block'; }
    return;
  }

  try {
    const payload = { name };
    if (slug) payload.slug = slug;
    if (email) payload.email = email;
    if (phone) payload.phone = phone;
    if (website) payload.website = website;
    if (timezone) payload.timezone = timezone;
    if (status) payload.status = status;

    await aapi('/api/admin/organizations', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (createOrgModal) createOrgModal.style.display = 'none';
    loadOrganizations(1, currentOrgSearch, currentOrgStatus);
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  }
});

// Toggle Status (Enable / Disable)
window.toggleOrgStatus = async function(id, currentStatus) {
  const isSuspended = currentStatus === 'SUSPENDED';
  const actionWord = isSuspended ? 'enable' : 'disable';

  if (!confirm(`Are you sure you want to ${actionWord} organization #${id}?`)) return;

  try {
    if (isSuspended) {
      await aapi(`/api/admin/organizations/${id}/enable`, { method: 'POST' });
    } else {
      const reason = prompt('Please provide a reason for disabling this organization:', 'Administrative suspension') || 'Administrative suspension';
      await aapi(`/api/admin/organizations/${id}/disable`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
    }
    loadOrganizations(currentOrgPage, currentOrgSearch, currentOrgStatus);
  } catch (err) {
    alert(err.message);
  }
};

// Organization Details Modal
window.showOrgDetails = async function(id) {
  const modal = document.getElementById('orgDetailsModal');
  if (!modal) return;

  try {
    const [orgRes, usageRes] = await Promise.all([
      aapi(`/api/admin/organizations/${id}`),
      aapi(`/api/admin/organizations/${id}/usage`).catch(() => ({ data: {} }))
    ]);

    const org = orgRes.data || orgRes;
    const usage = usageRes.data || {};

    document.getElementById('od_title').textContent = org.name;
    document.getElementById('od_subtitle').textContent = `Slug: ${org.slug} | Timezone: ${org.timezone || 'Asia/Kolkata'} | Status: ${org.status}`;

    // Usage cards
    const usageGrid = document.getElementById('od_usage_grid');
    if (usageGrid) {
      usageGrid.innerHTML = `
        <div style="padding:12px;background:var(--cream);border-radius:6px;border:1px solid var(--line);text-align:center">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">Candidates</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy);margin-top:4px">${usage.candidatesCount || 0}</div>
        </div>
        <div style="padding:12px;background:var(--cream);border-radius:6px;border:1px solid var(--line);text-align:center">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">Exams</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy);margin-top:4px">${usage.examsCount || 0}</div>
        </div>
        <div style="padding:12px;background:var(--cream);border-radius:6px;border:1px solid var(--line);text-align:center">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">Attempts</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy);margin-top:4px">${usage.attemptsCount || 0}</div>
        </div>
        <div style="padding:12px;background:var(--cream);border-radius:6px;border:1px solid var(--line);text-align:center">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">Certificates</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy);margin-top:4px">${usage.certificatesCount || 0}</div>
        </div>
        <div style="padding:12px;background:var(--cream);border-radius:6px;border:1px solid var(--line);text-align:center">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">Questions</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy);margin-top:4px">${usage.questionsCount || 0}</div>
        </div>
        <div style="padding:12px;background:var(--cream);border-radius:6px;border:1px solid var(--line);text-align:center">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">Admin Users</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy);margin-top:4px">${usage.usersCount || 0}</div>
        </div>
      `;
    }

    // Profile Details Content
    const content = document.getElementById('od_details_content');
    if (content) {
      content.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
          <div><strong>Official Email:</strong> ${esc(org.email || 'Not configured')}</div>
          <div><strong>Phone:</strong> ${esc(org.phone || 'Not configured')}</div>
          <div><strong>Website:</strong> ${org.website ? `<a href="${esc(org.website)}" target="_blank">${esc(org.website)}</a>` : 'Not configured'}</div>
          <div><strong>Branding Colors:</strong> 
            <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${org.primary_color || '#0B1F3A'};vertical-align:middle;margin:0 2px 0 6px"></span> ${org.primary_color || '#0B1F3A'}
            <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${org.secondary_color || '#13294B'};vertical-align:middle;margin:0 2px 0 6px"></span> ${org.secondary_color || '#13294B'}
            <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${org.accent_color || '#F97316'};vertical-align:middle;margin:0 2px 0 6px"></span> ${org.accent_color || '#F97316'}
          </div>
          <div><strong>Logo:</strong> ${org.logo_url ? `<img src="${esc(org.logo_url)}" style="height:32px;vertical-align:middle;margin-left:8px;border:1px solid var(--line);border-radius:3px">` : 'Default Aspire logo'}</div>
          <div><strong>Created At:</strong> ${esc(org.created_at || '-')}</div>
        </div>
      `;
    }

    const toggleBtn = document.getElementById('od_toggle_status_btn');
    if (toggleBtn) {
      const isSuspended = org.status === 'SUSPENDED';
      toggleBtn.textContent = isSuspended ? 'Enable Organization' : 'Disable Organization';
      toggleBtn.className = `btn small ${isSuspended ? '' : 'ghost'}`;
      toggleBtn.onclick = async () => {
        await toggleOrgStatus(org.id, org.status);
        modal.style.display = 'none';
      };
    }

    modal.style.display = 'block';
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('closeOrgDetailsModalBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('orgDetailsModal');
  if (modal) modal.style.display = 'none';
});
document.getElementById('closeOrgDetailsBottomBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('orgDetailsModal');
  if (modal) modal.style.display = 'none';
});

// ---------------------------------------------------------------------------
// Day 17: Organization Profile & Branding (ORG_ADMIN)
// ---------------------------------------------------------------------------

// Color Pickers <-> Inputs Two-Way Sync
function syncColorPicker(pickerId, inputId) {
  const picker = document.getElementById(pickerId);
  const input = document.getElementById(inputId);
  if (!picker || !input) return;

  picker.addEventListener('input', () => {
    input.value = picker.value.toUpperCase();
  });
  input.addEventListener('change', () => {
    if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(input.value)) {
      picker.value = input.value;
    }
  });
}
syncColorPicker('b_primary_color_picker', 'b_primary_color');
syncColorPicker('b_secondary_color_picker', 'b_secondary_color');
syncColorPicker('b_accent_color_picker', 'b_accent_color');

async function loadOrgBranding() {
  try {
    const res = await aapi('/api/organization');
    const org = res.data || res;

    // Fill profile fields
    const nameEl = document.getElementById('b_name');
    if (nameEl) nameEl.value = org.name || '';
    const emailEl = document.getElementById('b_email');
    if (emailEl) emailEl.value = org.email || '';
    const phoneEl = document.getElementById('b_phone');
    if (phoneEl) phoneEl.value = org.phone || '';
    const websiteEl = document.getElementById('b_website');
    if (websiteEl) websiteEl.value = org.website || '';
    const tzEl = document.getElementById('b_timezone');
    if (tzEl) tzEl.value = org.timezone || 'Asia/Kolkata';

    // Brand colors
    const pri = org.primary_color || '#0B1F3A';
    const sec = org.secondary_color || '#13294B';
    const acc = org.accent_color || '#F97316';

    const priIn = document.getElementById('b_primary_color');
    const priPk = document.getElementById('b_primary_color_picker');
    if (priIn && priPk) { priIn.value = pri; priPk.value = pri; }

    const secIn = document.getElementById('b_secondary_color');
    const secPk = document.getElementById('b_secondary_color_picker');
    if (secIn && secPk) { secIn.value = sec; secPk.value = sec; }

    const accIn = document.getElementById('b_accent_color');
    const accPk = document.getElementById('b_accent_color_picker');
    if (accIn && accPk) { accIn.value = acc; accPk.value = acc; }

    // Logo preview
    const preview = document.getElementById('b_logo_preview');
    if (preview) {
      if (org.logo_url) {
        preview.src = org.logo_url;
        preview.style.display = 'block';
      } else {
        preview.style.display = 'none';
      }
    }

    // Certificate branding
    const cert = org.certificate_branding || {};
    const cTitle = document.getElementById('b_cert_title');
    if (cTitle) cTitle.value = cert.title || '';
    const cOrgName = document.getElementById('b_cert_org_name');
    if (cOrgName) cOrgName.value = cert.org_name || '';
    const cSignatory = document.getElementById('b_cert_signatory');
    if (cSignatory) cSignatory.value = cert.signatory_name || '';
    const cSigTitle = document.getElementById('b_cert_signatory_title');
    if (cSigTitle) cSigTitle.value = cert.signatory_title || '';
    const cFooter = document.getElementById('b_cert_footer');
    if (cFooter) cFooter.value = cert.footer_text || '';

    // Load usage stats
    loadOrgUsageStats();

    // Load team invitations
    loadOrgInvitations();

  } catch (err) {
    const errBox = document.getElementById('brandingErr');
    if (errBox) {
      errBox.textContent = `Failed to load organization settings: ${err.message}`;
      errBox.style.display = 'block';
    }
  }
}

async function loadOrgUsageStats() {
  try {
    const res = await aapi('/api/organization/usage');
    const u = res.data || {};
    const cCand = document.getElementById('usageCandidates');
    if (cCand) cCand.textContent = u.candidatesCount ?? 0;
    const cExams = document.getElementById('usageExams');
    if (cExams) cExams.textContent = u.examsCount ?? 0;
    const cAttempts = document.getElementById('usageAttempts');
    if (cAttempts) cAttempts.textContent = u.attemptsCount ?? 0;
    const cCerts = document.getElementById('usageCertificates');
    if (cCerts) cCerts.textContent = u.certificatesCount ?? 0;
  } catch {}
}

// Save Changes to Organization Profile & Branding
document.getElementById('saveOrgBrandingBtn')?.addEventListener('click', async () => {
  const msgBox = document.getElementById('brandingMsg');
  const errBox = document.getElementById('brandingErr');
  if (msgBox) msgBox.style.display = 'none';
  if (errBox) errBox.style.display = 'none';

  try {
    const payload = {
      name: document.getElementById('b_name')?.value.trim(),
      phone: document.getElementById('b_phone')?.value.trim() || null,
      website: document.getElementById('b_website')?.value.trim() || null,
      timezone: document.getElementById('b_timezone')?.value || 'Asia/Kolkata',
      primary_color: document.getElementById('b_primary_color')?.value.trim() || '#0B1F3A',
      secondary_color: document.getElementById('b_secondary_color')?.value.trim() || '#13294B',
      accent_color: document.getElementById('b_accent_color')?.value.trim() || '#F97316',
      certificate_branding: {
        title: document.getElementById('b_cert_title')?.value.trim() || undefined,
        org_name: document.getElementById('b_cert_org_name')?.value.trim() || undefined,
        signatory_name: document.getElementById('b_cert_signatory')?.value.trim() || undefined,
        signatory_title: document.getElementById('b_cert_signatory_title')?.value.trim() || undefined,
        footer_text: document.getElementById('b_cert_footer')?.value.trim() || undefined
      }
    };

    const res = await aapi('/api/organization', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });

    if (msgBox) {
      msgBox.textContent = 'Organization profile and branding updated successfully.';
      msgBox.style.display = 'block';
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  }
});

// Upload Logo
document.getElementById('uploadLogoBtn')?.addEventListener('click', async () => {
  const fileInput = document.getElementById('b_logo_file');
  const file = fileInput?.files?.[0];
  const errBox = document.getElementById('brandingErr');
  const msgBox = document.getElementById('brandingMsg');
  if (errBox) errBox.style.display = 'none';
  if (msgBox) msgBox.style.display = 'none';

  if (!file) {
    if (errBox) { errBox.textContent = 'Please choose an image file first (PNG, JPEG, or WebP).'; errBox.style.display = 'block'; }
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    if (errBox) { errBox.textContent = 'Logo image exceeds 2MB limit.'; errBox.style.display = 'block'; }
    return;
  }

  try {
    const formData = new FormData();
    formData.append('logo', file);

    const token = getAuthToken();
    const res = await fetch('/api/organization/branding/logo', {
      method: 'POST',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: formData
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || 'Failed to upload logo');
    }

    const preview = document.getElementById('b_logo_preview');
    if (preview && data.data?.logo_url) {
      preview.src = data.data.logo_url;
      preview.style.display = 'block';
    }

    if (msgBox) {
      msgBox.textContent = 'Logo uploaded and updated successfully.';
      msgBox.style.display = 'block';
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  }
});

// Team Invitations
async function loadOrgInvitations() {
  const tb = document.getElementById('b_invitations_body');
  if (!tb) return;

  try {
    const res = await aapi('/api/organization/invitations');
    const invites = res.data || [];

    if (invites.length === 0) {
      tb.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">No pending or recent invitations.</td></tr>`;
      return;
    }

    tb.innerHTML = invites.map((inv) => {
      const isPending = inv.status === 'PENDING';
      const statusBadge = isPending
        ? `<span class="tag" style="background:#FEF3C7;color:#92400E">PENDING</span>`
        : (inv.status === 'ACCEPTED'
          ? `<span class="tag" style="background:#DEF7EC;color:#03543F">ACCEPTED</span>`
          : `<span class="tag" style="background:#F3F4F6;color:#6B7280">${esc(inv.status)}</span>`);

      const revokeBtn = isPending
        ? `<button class="btn small ghost" onclick="revokeOrgInvite(${inv.id})">Revoke</button>`
        : '-';

      return `<tr>
        <td><strong>${esc(inv.email)}</strong></td>
        <td><span class="tag">${esc(inv.role)}</span></td>
        <td>${esc((inv.expires_at || '').slice(0, 16))}</td>
        <td>${statusBadge}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tb.innerHTML = `<tr><td colspan="5" class="err" style="text-align:center">${esc(err.message)}</td></tr>`;
  }
}

document.getElementById('sendInviteBtn')?.addEventListener('click', async () => {
  const emailInput = document.getElementById('b_invite_email');
  const roleSelect = document.getElementById('b_invite_role');
  const email = emailInput?.value.trim();
  const role = roleSelect?.value || 'ORG_ADMIN';

  const msgBox = document.getElementById('inviteMsg');
  const errBox = document.getElementById('inviteErr');
  if (msgBox) msgBox.style.display = 'none';
  if (errBox) errBox.style.display = 'none';

  if (!email) {
    if (errBox) { errBox.textContent = 'Please enter invitee email.'; errBox.style.display = 'block'; }
    return;
  }

  try {
    const res = await aapi('/api/organization/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, role })
    });

    if (emailInput) emailInput.value = '';

    if (msgBox) {
      msgBox.textContent = `Invitation created for ${email}. (Link: ${res.data?.invitationLink || 'Sent'})`;
      msgBox.style.display = 'block';
    }

    loadOrgInvitations();
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  }
});

window.revokeOrgInvite = async function(id) {
  if (!confirm('Are you sure you want to revoke this invitation?')) return;
  try {
    await aapi(`/api/organization/invitations/${id}/revoke`, { method: 'POST' });
    loadOrgInvitations();
  } catch (err) {
    alert(err.message);
  }
};

/* ==========================================================================
   DAY 18: SAAS ANALYTICS DASHBOARD & CHART.JS INTEGRATION
   ========================================================================== */

let dashboardCharts = {
  attempts: null,
  score: null,
  completion: null,
  college: null,
  question: null
};

function destroyAllDashboardCharts() {
  Object.keys(dashboardCharts).forEach((key) => {
    if (dashboardCharts[key]) {
      try { dashboardCharts[key].destroy(); } catch (e) {}
      dashboardCharts[key] = null;
    }
  });
}

function renderEmptyChart(canvasId, message = 'No data available for the selected period') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const parent = canvas.parentElement;
  if (!parent) return;
  canvas.style.display = 'none';
  let emptyEl = parent.querySelector('.empty-chart');
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'empty-chart';
    parent.appendChild(emptyEl);
  }
  emptyEl.innerHTML = `<span style="font-size:28px;margin-bottom:8px">📊</span><span style="font-weight:600">${message}</span>`;
  emptyEl.style.display = 'flex';
}

function resetChartCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  canvas.style.display = 'block';
  const parent = canvas.parentElement;
  if (parent) {
    const emptyEl = parent.querySelector('.empty-chart');
    if (emptyEl) emptyEl.style.display = 'none';
  }
  return canvas;
}

function renderKpiTrend(elementId, change, comparisonAvailable) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!comparisonAvailable) {
    el.className = 'kpi-trend neutral';
    el.innerHTML = '&mdash; no prior data';
    return;
  }
  if (change > 0) {
    el.className = 'kpi-trend positive';
    el.innerHTML = `&uarr; +${change}% vs prior`;
  } else if (change < 0) {
    el.className = 'kpi-trend negative';
    el.innerHTML = `&darr; ${change}% vs prior`;
  } else {
    el.className = 'kpi-trend neutral';
    el.innerHTML = `0% vs prior`;
  }
}

function renderAttemptsChart(data) {
  if (!data || !data.labels || data.labels.length === 0 || typeof Chart === 'undefined') {
    renderEmptyChart('chartAttemptsOverTime', 'No attempt history recorded for this date range');
    return;
  }
  const canvas = resetChartCanvas('chartAttemptsOverTime');
  if (!canvas) return;
  if (dashboardCharts.attempts) {
    dashboardCharts.attempts.destroy();
    dashboardCharts.attempts = null;
  }
  const ctx = canvas.getContext('2d');
  dashboardCharts.attempts = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: 'Completed Attempts',
          data: data.completed,
          borderColor: '#10B981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: true,
          tension: 0.3,
          borderWidth: 2
        },
        {
          label: 'In Progress Attempts',
          data: data.inProgress,
          borderColor: '#3B82F6',
          backgroundColor: 'rgba(59, 130, 246, 0.05)',
          fill: false,
          tension: 0.3,
          borderWidth: 2
        },
        {
          label: 'Total Sessions',
          data: data.total,
          borderColor: '#9CA3AF',
          borderDash: [4, 4],
          fill: false,
          tension: 0.3,
          borderWidth: 1.5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { padding: 10 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 11 } } }
      }
    }
  });
}

function renderScoreChart(data) {
  if (!data || !data.buckets || data.buckets.length === 0 || typeof Chart === 'undefined') {
    renderEmptyChart('chartScoreDistribution', 'No completed attempts to analyze score distribution');
    return;
  }
  const hasData = (data.counts || []).some(c => c > 0);
  if (!hasData) {
    renderEmptyChart('chartScoreDistribution', 'No graded attempts available in this period');
    return;
  }
  const canvas = resetChartCanvas('chartScoreDistribution');
  if (!canvas) return;
  if (dashboardCharts.score) {
    dashboardCharts.score.destroy();
    dashboardCharts.score = null;
  }
  const ctx = canvas.getContext('2d');
  dashboardCharts.score = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.buckets,
      datasets: [{
        label: 'Candidates',
        data: data.counts,
        backgroundColor: ['#EF4444', '#F59E0B', '#FCD34D', '#60A5FA', '#10B981'],
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (context) => {
              const pct = (data.percentages && data.percentages[context.dataIndex]) || 0;
              return `${pct}% of total attempts`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 11 } } }
      }
    }
  });
}

function renderCompletionChart(data) {
  if (!data || !data.counts || data.totalEligible === 0 || typeof Chart === 'undefined') {
    renderEmptyChart('chartCompletionRate', 'No attempt sessions started in this period');
    return;
  }
  const canvas = resetChartCanvas('chartCompletionRate');
  if (!canvas) return;
  if (dashboardCharts.completion) {
    dashboardCharts.completion.destroy();
    dashboardCharts.completion = null;
  }
  const ctx = canvas.getContext('2d');
  dashboardCharts.completion = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.labels,
      datasets: [{
        data: data.counts,
        backgroundColor: ['#10B981', '#3B82F6', '#EF4444'],
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (context) => {
              const count = context.raw || 0;
              const pct = (data.percentages && data.percentages[context.dataIndex]) || 0;
              return ` ${context.label}: ${count} (${pct}%)`;
            }
          }
        }
      },
      cutout: '65%'
    }
  });
}

function renderCollegeChart(data) {
  if (!data || !data.colleges || data.colleges.length === 0 || typeof Chart === 'undefined') {
    renderEmptyChart('chartCollegeDistribution', 'No candidate college registrations found');
    return;
  }
  const canvas = resetChartCanvas('chartCollegeDistribution');
  if (!canvas) return;
  if (dashboardCharts.college) {
    dashboardCharts.college.destroy();
    dashboardCharts.college = null;
  }
  const ctx = canvas.getContext('2d');
  dashboardCharts.college = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.colleges,
      datasets: [{
        label: 'Students',
        data: data.studentCounts,
        backgroundColor: '#6366F1',
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0, font: { size: 11 } } },
        y: { ticks: { font: { size: 11 } } }
      }
    }
  });
}

function renderQuestionPerformanceChart(data) {
  if (!data || !data.questions || data.questions.length === 0 || typeof Chart === 'undefined') {
    renderEmptyChart('chartQuestionPerformance', 'No graded questions recorded in this period');
    return;
  }
  const canvas = resetChartCanvas('chartQuestionPerformance');
  if (!canvas) return;
  if (dashboardCharts.question) {
    dashboardCharts.question.destroy();
    dashboardCharts.question = null;
  }
  const labels = data.questions.map(q => {
    const t = q.title || `Q#${q.questionId}`;
    return t.length > 22 ? t.slice(0, 20) + '...' : t;
  });
  const accuracies = data.questions.map(q => q.accuracy);
  const colors = accuracies.map(acc => acc >= 70 ? '#10B981' : (acc >= 40 ? '#F59E0B' : '#EF4444'));

  const ctx = canvas.getContext('2d');
  dashboardCharts.question = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Accuracy %',
        data: accuracies,
        backgroundColor: colors,
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (ctx) => {
              const q = data.questions[ctx.dataIndex];
              return `Correct: ${q.correctCount} / ${q.totalAttempts} (Avg: ${q.avgScore} pts)`;
            }
          }
        }
      },
      scales: {
        x: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%', font: { size: 11 } } },
        y: { ticks: { font: { size: 11 } } }
      }
    }
  });
}

async function populateDashboardExams() {
  const select = document.getElementById('dashExamSelect');
  if (!select || select.children.length > 1) return;

  try {
    const res = await aapi('/api/admin/exams');
    const exams = Array.isArray(res) ? res : (res.data?.items || res.data || []);
    for (const ex of exams) {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = `${ex.name} (${ex.code})`;
      select.appendChild(opt);
    }
  } catch (err) {
    // Non-fatal if exams cannot be loaded
  }
}

async function populateSuperAdminOrgScope() {
  if (!currentUser || currentUser.role !== 'SUPER_ADMIN') return;
  const scopeWrap = document.getElementById('dashSuperAdminScope');
  const scopeSelect = document.getElementById('dashOrgScopeSelect');
  if (!scopeWrap || !scopeSelect) return;

  scopeWrap.style.display = 'flex';
  if (scopeSelect.children.length > 1) return;

  try {
    const res = await aapi('/api/admin/organizations');
    const orgs = Array.isArray(res) ? res : (res.data?.items || res.data || []);
    for (const org of orgs) {
      const opt = document.createElement('option');
      opt.value = org.id;
      opt.textContent = org.name;
      scopeSelect.appendChild(opt);
    }
  } catch (err) {
    // Non-fatal
  }
}

async function loadDashboard() {
  if (!currentUser) return;
  const isSuperAdmin = currentUser.role === 'SUPER_ADMIN';

  // Setup scopes & dropdowns
  if (isSuperAdmin) {
    await populateSuperAdminOrgScope();
  } else {
    const scopeWrap = document.getElementById('dashSuperAdminScope');
    if (scopeWrap) scopeWrap.style.display = 'none';
  }
  await populateDashboardExams();

  const errBanner = document.getElementById('dashErrorBanner');
  if (errBanner) {
    errBanner.style.display = 'none';
    errBanner.textContent = '';
  }

  // Determine active filters
  const period = document.getElementById('dashPeriodSelect')?.value || '30d';
  const examId = document.getElementById('dashExamSelect')?.value || '';
  const orgScope = document.getElementById('dashOrgScopeSelect')?.value || 'platform';

  const queryParams = new URLSearchParams({ period });
  if (examId) queryParams.append('exam_id', examId);

  if (period === 'custom') {
    const start = document.getElementById('dashStartDate')?.value;
    const end = document.getElementById('dashEndDate')?.value;
    if (start && end) {
      queryParams.append('start_date', start);
      queryParams.append('end_date', end);
    }
  }

  const badgeEl = document.getElementById('dashOrgBadge');
  const orgBreakdownCard = document.getElementById('superAdminOrgBreakdownCard');

  try {
    let kpiData = null;
    let attemptsData = null;
    let scoreData = null;
    let completionData = null;
    let collegeData = null;
    let questionData = null;

    if (isSuperAdmin && orgScope === 'platform') {
      // Platform-wide overview
      if (badgeEl) {
        badgeEl.textContent = 'Platform Overview';
        badgeEl.className = 'status-badge status-live';
      }
      if (orgBreakdownCard) orgBreakdownCard.style.display = 'block';

      const res = await aapi(`/api/admin/dashboard/platform-overview?${queryParams.toString()}`);
      const payload = res.data || res;
      kpiData = payload.kpis || payload;
      attemptsData = payload.attemptsOverTime;
      scoreData = payload.scoreDistribution;
      completionData = payload.completionRate;
      collegeData = payload.collegeDistribution;
      questionData = payload.questionPerformance;

      // Render platform organizations breakdown table
      const tbody = document.getElementById('platformOrgsBody');
      if (tbody) {
        tbody.innerHTML = '';
        const orgs = payload.organizationsBreakdown || [];
        if (orgs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No organizations found.</td></tr>';
        } else {
          for (const org of orgs) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><strong>${escapeHtml(org.name)}</strong> <span style="font-size:11px;color:var(--muted)">(${escapeHtml(org.slug)})</span></td>
              <td><span class="status-badge ${org.status === 'ACTIVE' ? 'status-published' : 'status-archived'}">${org.status}</span></td>
              <td>${org.total_students || 0}</td>
              <td>${org.active_exams || 0}</td>
              <td>${org.completed_attempts || 0}</td>
              <td>${org.avg_score !== null ? org.avg_score + '%' : '—'}</td>
            `;
            tbody.appendChild(tr);
          }
        }
      }
    } else if (isSuperAdmin && orgScope !== 'platform') {
      // Super Admin viewing a single organization
      if (orgBreakdownCard) orgBreakdownCard.style.display = 'none';
      const res = await aapi(`/api/admin/dashboard/organizations/${orgScope}?${queryParams.toString()}`);
      const payload = res.data || res;
      kpiData = payload.kpis;
      attemptsData = payload.attemptsOverTime;
      scoreData = payload.scoreDistribution;
      completionData = payload.completionRate;
      collegeData = payload.collegeDistribution;
      questionData = payload.questionPerformance;

      if (badgeEl && kpiData?.meta?.organizationName) {
        badgeEl.textContent = kpiData.meta.organizationName;
        badgeEl.className = 'status-badge status-live';
      }
    } else {
      // Tenant Admin / Manager / Viewer
      if (orgBreakdownCard) orgBreakdownCard.style.display = 'none';

      const [kpiRes, attRes, scRes, compRes, colRes, qRes] = await Promise.all([
        aapi(`/api/organization/dashboard/overview?${queryParams.toString()}`),
        aapi(`/api/organization/dashboard/attempts-over-time?${queryParams.toString()}`),
        aapi(`/api/organization/dashboard/score-distribution?${queryParams.toString()}`),
        aapi(`/api/organization/dashboard/completion-rate?${queryParams.toString()}`),
        aapi(`/api/organization/dashboard/college-distribution?${queryParams.toString()}`),
        aapi(`/api/organization/dashboard/question-performance?${queryParams.toString()}`)
      ]);

      kpiData = kpiRes.data || kpiRes;
      attemptsData = attRes.data || attRes;
      scoreData = scRes.data || scRes;
      completionData = compRes.data || compRes;
      collegeData = colRes.data || colRes;
      questionData = qRes.data || qRes;

      if (badgeEl && kpiData?.meta?.organizationName) {
        badgeEl.textContent = kpiData.meta.organizationName;
        badgeEl.className = 'status-badge status-live';
      }
    }

    // Populate 8 KPI Cards
    const kpis = kpiData.kpis || kpiData;
    if (kpis) {
      if (kpis.totalStudents) {
        document.getElementById('kpiTotalStudents').textContent = kpis.totalStudents.value.toLocaleString();
        renderKpiTrend('kpiTrendStudents', kpis.totalStudents.percentageChange, kpis.totalStudents.comparisonAvailable);
      }
      if (kpis.totalExams) {
        document.getElementById('kpiTotalExams').textContent = kpis.totalExams.value.toLocaleString();
        renderKpiTrend('kpiTrendExams', kpis.totalExams.percentageChange, kpis.totalExams.comparisonAvailable);
      }
      if (kpis.activeExams) {
        document.getElementById('kpiActiveExams').textContent = kpis.activeExams.value.toLocaleString();
        renderKpiTrend('kpiTrendActiveExams', kpis.activeExams.percentageChange, kpis.activeExams.comparisonAvailable);
      }
      if (kpis.completedAttempts) {
        document.getElementById('kpiCompletedAttempts').textContent = kpis.completedAttempts.value.toLocaleString();
        renderKpiTrend('kpiTrendAttempts', kpis.completedAttempts.percentageChange, kpis.completedAttempts.comparisonAvailable);
      }
      if (kpis.averageScore) {
        document.getElementById('kpiAverageScore').textContent = `${kpis.averageScore.value}%`;
        renderKpiTrend('kpiTrendScore', kpis.averageScore.percentageChange, kpis.averageScore.comparisonAvailable);
      }
      if (kpis.passRate) {
        document.getElementById('kpiPassRate').textContent = `${kpis.passRate.value}%`;
        renderKpiTrend('kpiTrendPassRate', kpis.passRate.percentageChange, kpis.passRate.comparisonAvailable);
        const ratioEl = document.getElementById('kpiPassRateRatio');
        if (ratioEl && kpis.passRate.metadata) {
          ratioEl.textContent = `${kpis.passRate.metadata.passedCount} / ${kpis.passRate.metadata.totalEligibleCount} passed`;
        }
      }
      if (kpis.scholarshipsAwarded) {
        document.getElementById('kpiScholarshipsAwarded').textContent = kpis.scholarshipsAwarded.value.toLocaleString();
        renderKpiTrend('kpiTrendScholarships', kpis.scholarshipsAwarded.percentageChange, kpis.scholarshipsAwarded.comparisonAvailable);
      }
      if (kpis.certificatesGenerated) {
        document.getElementById('kpiCertificatesGenerated').textContent = kpis.certificatesGenerated.value.toLocaleString();
        renderKpiTrend('kpiTrendCertificates', kpis.certificatesGenerated.percentageChange, kpis.certificatesGenerated.comparisonAvailable);
      }
    }

    // Render Charts
    renderAttemptsChart(attemptsData);
    renderScoreChart(scoreData);
    renderCompletionChart(completionData);
    renderCollegeChart(collegeData);
    renderQuestionPerformanceChart(questionData);

  } catch (err) {
    if (errBanner) {
      errBanner.textContent = `Failed to load analytics: ${err.message}`;
      errBanner.style.display = 'block';
    }
  }
}

// Wire Dashboard Filter Event Listeners
document.getElementById('dashPeriodSelect')?.addEventListener('change', (e) => {
  const isCustom = e.target.value === 'custom';
  const customBox = document.getElementById('dashCustomDates');
  if (customBox) customBox.style.display = isCustom ? 'flex' : 'none';
  if (!isCustom) loadDashboard();
});

document.getElementById('dashApplyCustomBtn')?.addEventListener('click', () => {
  loadDashboard();
});

document.getElementById('dashExamSelect')?.addEventListener('change', () => {
  loadDashboard();
});

document.getElementById('dashOrgScopeSelect')?.addEventListener('change', () => {
  loadDashboard();
});

document.getElementById('dashRefreshBtn')?.addEventListener('click', () => {
  loadDashboard();
});

// ============================================================================
// DAY 19: EXAM ANALYTICS DASHBOARD FRONTEND LOGIC
// ============================================================================

let currentAnalyticsExamId = null;
let currentAnalyticsSection = 'overview';
let currentCandidatePage = 1;

const examAnalyticsCharts = {
  score: null,
  duration: null,
  passFail: null,
  category: null
};

function destroyAllExamAnalyticsCharts() {
  Object.keys(examAnalyticsCharts).forEach((k) => {
    if (examAnalyticsCharts[k]) {
      try { examAnalyticsCharts[k].destroy(); } catch (e) {}
      examAnalyticsCharts[k] = null;
    }
  });
}

function renderEmptyAnalyticsChart(canvasId, message = 'No data available') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const parent = canvas.parentElement;
  if (!parent) return;
  canvas.style.display = 'none';
  let emptyEl = parent.querySelector('.empty-chart');
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'empty-chart';
    parent.appendChild(emptyEl);
  }
  emptyEl.innerHTML = `<span style="font-size:28px;margin-bottom:8px">📊</span><span style="font-weight:600">${message}</span>`;
  emptyEl.style.display = 'flex';
}

function resetAnalyticsCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  canvas.style.display = 'block';
  const parent = canvas.parentElement;
  if (parent) {
    const emptyEl = parent.querySelector('.empty-chart');
    if (emptyEl) emptyEl.style.display = 'none';
  }
  return canvas;
}

window.openExamAnalytics = async function(examId) {
  if (!examId) return;
  currentAnalyticsExamId = examId;
  currentAnalyticsSection = 'overview';
  currentCandidatePage = 1;

  switchTab('exam-analytics');
  showAnalyticsSubSec('overview');
  await loadCurrentExamAnalytics();
};

function showAnalyticsSubSec(secName) {
  currentAnalyticsSection = secName;
  document.querySelectorAll('.analytics-sub-sec').forEach((el) => {
    el.style.display = 'none';
  });
  document.querySelectorAll('.analytics-nav-btn').forEach((btn) => {
    if (btn.dataset.sec === secName) {
      btn.classList.remove('ghost');
      btn.style.background = '#4F46E5';
      btn.style.color = '#fff';
    } else {
      btn.classList.add('ghost');
      btn.style.background = '';
      btn.style.color = '';
    }
  });

  const targetEl = document.getElementById(`analyticsSec${secName.charAt(0).toUpperCase() + secName.slice(1)}`);
  if (targetEl) targetEl.style.display = 'block';
}

async function loadCurrentExamAnalytics() {
  if (!currentAnalyticsExamId) return;
  const errBanner = document.getElementById('analyticsErrorBanner');
  if (errBanner) errBanner.style.display = 'none';

  const period = document.getElementById('analyticsPeriodSelect')?.value || 'all';

  try {
    // 1. Load Overview (always needed for header & KPI cards)
    const overviewRes = await aapi(`/api/organization/exams/${currentAnalyticsExamId}/analytics/overview?period=${period}`);
    if (overviewRes.success && overviewRes.data) {
      renderExamHeader(overviewRes.data.exam);
      renderExamOverview(overviewRes.data);
    }

    // 2. Load section-specific data based on active tab
    if (currentAnalyticsSection === 'questions') {
      await loadExamQuestionsView();
    } else if (currentAnalyticsSection === 'coding') {
      await loadExamCodingView();
    } else if (currentAnalyticsSection === 'performance') {
      await loadExamPerformanceView();
    } else if (currentAnalyticsSection === 'candidates') {
      await loadExamCandidatesView();
    }
  } catch (err) {
    if (errBanner) {
      errBanner.textContent = `Failed to load exam analytics: ${err.message}`;
      errBanner.style.display = 'block';
    }
  }
}

function renderExamHeader(exam) {
  if (!exam) return;
  const nameEl = document.getElementById('analyticsExamName');
  const statusEl = document.getElementById('analyticsExamStatus');
  const metaEl = document.getElementById('analyticsExamMeta');

  if (nameEl) nameEl.textContent = exam.name || `Exam #${exam.id}`;
  if (statusEl) {
    statusEl.textContent = exam.status;
    statusEl.className = `status-badge status-${(exam.status || 'draft').toLowerCase()}`;
  }
  if (metaEl) {
    metaEl.textContent = `Code: ${exam.code || 'N/A'} | Duration: ${exam.duration_minutes || 0} mins | Marks: ${exam.total_marks || 0} | Passing Score: ${exam.passing_score ?? 40}%`;
  }
}

function renderExamOverview(data) {
  const kpis = data.kpis || {};
  const funnel = data.funnel || [];

  // KPIs
  document.getElementById('kpiExamRegistered').textContent = (kpis.registered ?? 0).toLocaleString();
  document.getElementById('kpiExamStarted').textContent = (kpis.started ?? 0).toLocaleString();
  document.getElementById('kpiExamStartRate').textContent = `${kpis.completionRate ?? 0}% started`;
  document.getElementById('kpiExamCompleted').textContent = (kpis.completed ?? 0).toLocaleString();
  document.getElementById('kpiExamCompletionRate').textContent = `${kpis.completionRate ?? 0}% completion rate`;
  document.getElementById('kpiExamPassed').textContent = (kpis.passed ?? 0).toLocaleString();
  document.getElementById('kpiExamPassRate').textContent = `${kpis.passRate ?? 0}% pass rate`;
  document.getElementById('kpiExamFailed').textContent = (kpis.failed ?? 0).toLocaleString();
  document.getElementById('kpiExamFailRate').textContent = `${kpis.failRate ?? 0}% fail rate`;
  document.getElementById('kpiExamAbandoned').textContent = (kpis.abandoned ?? 0).toLocaleString();
  document.getElementById('kpiExamAbandonRate').textContent = `${kpis.abandonmentRate ?? 0}% drop-off rate`;

  // Secondary metrics
  document.getElementById('kpiExamAvgScore').textContent = `${kpis.averageScore ?? 0}%`;
  document.getElementById('kpiExamMedianScore').textContent = kpis.medianScore !== null ? `${kpis.medianScore}%` : '—';
  document.getElementById('kpiExamHighestScore').textContent = kpis.highestScore !== null ? `${kpis.highestScore}%` : '—';
  document.getElementById('kpiExamAvgDuration').textContent = kpis.averageDurationMinutes !== null ? `${kpis.averageDurationMinutes}m` : '—';
  document.getElementById('kpiExamScholarships').textContent = (kpis.scholarshipsAwarded ?? 0).toLocaleString();

  // Funnel visualization
  renderFunnelProgression(funnel);
}

function renderFunnelProgression(funnel) {
  const container = document.getElementById('funnelContainer');
  if (!container) return;
  container.innerHTML = '';

  if (!funnel || funnel.length === 0) {
    container.innerHTML = '<div style="color:var(--muted);padding:12px">No funnel data available</div>';
    return;
  }

  funnel.forEach((step, idx) => {
    const card = document.createElement('div');
    card.style.cssText = 'flex:1;min-width:140px;background:#fff;padding:12px 14px;border-radius:6px;border:1px solid var(--line);box-shadow:0 1px 2px rgba(0,0,0,0.05);position:relative';

    const stageColors = {
      Registered: '#4B5563',
      Started: '#2563EB',
      Completed: '#7C3AED',
      Passed: '#059669'
    };
    const accentColor = stageColors[step.stage] || '#4F46E5';

    card.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:${accentColor};text-transform:uppercase;letter-spacing:0.5px">${step.stage}</div>
      <div style="font-size:22px;font-weight:700;margin:4px 0">${(step.count || 0).toLocaleString()}</div>
      <div style="font-size:12px;color:var(--muted)">Conversion: <strong>${step.conversionRate || 0}%</strong></div>
      ${step.dropOff > 0 ? `<div style="font-size:11px;color:var(--danger, #DC2626);margin-top:2px">-${step.dropOff} (${step.dropOffRate}%)</div>` : ''}
    `;
    container.appendChild(card);
  });
}

async function loadExamQuestionsView() {
  if (!currentAnalyticsExamId) return;
  const tbody = document.getElementById('examQuestionsBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:20px;color:var(--muted)">Loading questions psychometrics...</td></tr>';

  const type = document.getElementById('qAnalyticsTypeFilter')?.value || 'all';
  const difficulty = document.getElementById('qAnalyticsDifficultyFilter')?.value || 'all';
  const sort = document.getElementById('qAnalyticsSortFilter')?.value || 'order_asc';
  const search = document.getElementById('qAnalyticsSearch')?.value || '';

  const params = new URLSearchParams();
  if (type !== 'all') params.append('type', type);
  if (difficulty !== 'all') params.append('difficulty', difficulty);
  if (sort) params.append('sort', sort);
  if (search) params.append('search', search);

  const res = await aapi(`/api/organization/exams/${currentAnalyticsExamId}/analytics/questions?${params.toString()}`);
  if (!res.success || !res.data) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--danger);padding:20px">Failed to load question analytics</td></tr>';
    return;
  }

  const badge = document.getElementById('qAnalyticsSampleBadge');
  if (badge) {
    badge.textContent = `Sample Size: ${res.data.sampleSize || 0} completed attempts ${res.data.sampleSizeInsufficient ? '(Insufficient for D calculation, min 10 required)' : ''}`;
  }

  const items = res.data.questions || [];
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:24px;color:var(--muted)">No questions matched the selected filters.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  items.forEach((q, idx) => {
    const tr = document.createElement('tr');

    const diffColors = {
      VERY_EASY: '#059669',
      EASY: '#10B981',
      MODERATE: '#3B82F6',
      DIFFICULT: '#D97706',
      VERY_DIFFICULT: '#DC2626'
    };
    const diffColor = diffColors[q.difficulty] || '#6B7280';

    let discHtml = '<span style="color:var(--muted)">N/A</span>';
    if (!q.sampleSizeInsufficient && q.discriminationIndex !== null) {
      const d = q.discriminationIndex;
      const dColor = d >= 0.40 ? '#059669' : (d >= 0.20 ? '#2563EB' : (d >= 0.00 ? '#D97706' : '#DC2626'));
      discHtml = `<strong style="color:${dColor}">${d > 0 ? '+' : ''}${d}</strong> <span style="font-size:11px;color:var(--muted)">(${q.discriminationRating})</span>`;
    }

    const timeHtml = q.hasTimingData && q.averageTimeSeconds !== null ? `${q.averageTimeSeconds}s` : '<span style="color:var(--muted)">—</span>';

    tr.innerHTML = `
      <td>${q.questionNumber || idx + 1}</td>
      <td><span class="status-badge" style="background:#F3F4F6;color:#374151;text-transform:uppercase">${q.type}</span></td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(q.title)}">
        <strong>${escapeHtml(q.title)}</strong>
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(q.sectionName || q.category)}</div>
      </td>
      <td>${q.marks}</td>
      <td>${q.totalEligibleAttempts}</td>
      <td><strong style="color:#059669">${q.correctPercentage}%</strong> <span style="font-size:11px;color:var(--muted)">(${q.correctCount})</span></td>
      <td><strong style="color:#DC2626">${q.wrongPercentage}%</strong> <span style="font-size:11px;color:var(--muted)">(${q.wrongCount})</span></td>
      <td>${q.unansweredCount} <span style="font-size:11px;color:var(--muted)">(${q.unansweredPercentage}%)</span></td>
      <td>${timeHtml}</td>
      <td><span class="status-badge" style="background:${diffColor}15;color:${diffColor};font-weight:600">${q.difficulty}</span></td>
      <td>${discHtml}</td>
      <td>
        <button class="btn small ghost" onclick="inspectQuestionDetail(${currentAnalyticsExamId}, ${q.questionId})">Inspect</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.inspectQuestionDetail = async function(examId, questionId) {
  const modal = document.getElementById('questionAnalyticsModal');
  const body = document.getElementById('qModalBody');
  const title = document.getElementById('qModalTitle');
  const meta = document.getElementById('qModalMeta');

  if (!modal || !body) return;
  modal.style.display = 'block';
  body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Loading question details...</div>';

  try {
    const res = await aapi(`/api/organization/exams/${examId}/analytics/questions/${questionId}`);
    if (!res.success || !res.data) {
      body.innerHTML = '<div style="color:var(--danger)">Failed to load question details.</div>';
      return;
    }

    const { question, stats, optionsBreakdown, codingBreakdown } = res.data;
    if (title) title.textContent = `Question #${question.id} — ${question.type.toUpperCase()}`;
    if (meta) meta.textContent = `Category: ${question.category} | Marks: ${question.marks} | Accuracy: ${stats.overallAccuracy}% (${stats.difficulty})`;

    let html = `
      <div style="background:#F9FAFB;padding:12px;border-radius:6px;border:1px solid var(--line);margin-bottom:16px">
        <strong>Prompt / Text:</strong>
        <p style="margin:6px 0 0;font-size:14px;white-space:pre-wrap">${escapeHtml(question.questionText || question.title)}</p>
      </div>
    `;

    if (question.type === 'mcq' && optionsBreakdown) {
      html += `
        <h4 style="margin-top:0;margin-bottom:12px">Candidate Option Selection Distribution</h4>
        <div style="display:flex;flex-direction:column;gap:10px">
      `;

      optionsBreakdown.forEach((opt) => {
        const borderCol = opt.isCorrect ? '#059669' : '#E5E7EB';
        const bgCol = opt.isCorrect ? '#ECFDF5' : '#FFFFFF';
        html += `
          <div style="padding:10px 14px;border:1px solid ${borderCol};background:${bgCol};border-radius:6px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-weight:600">Option ${String.fromCharCode(65 + opt.index)}: ${escapeHtml(opt.text)} ${opt.isCorrect ? '<span class="status-badge status-live" style="margin-left:6px">Correct Answer</span>' : ''}</span>
              <span><strong>${opt.count}</strong> votes (${opt.percentage}%)</span>
            </div>
            <div style="background:#E5E7EB;height:8px;border-radius:4px;overflow:hidden">
              <div style="background:${opt.isCorrect ? '#059669' : '#6B7280'};height:100%;width:${opt.percentage}%"></div>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    } else if (question.type === 'code' && codingBreakdown) {
      html += `
        <h4 style="margin-top:0;margin-bottom:12px">Execution Architecture Outcomes</h4>
        <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(130px, 1fr))">
          <div class="kpi-card">
            <div class="kpi-label">Submissions</div>
            <div class="kpi-value">${codingBreakdown.totalSubmissions}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Accepted</div>
            <div class="kpi-value" style="color:#059669">${codingBreakdown.acceptedCount}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Compile Errors</div>
            <div class="kpi-value" style="color:#DC2626">${codingBreakdown.compilationFailures}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Runtime Errors</div>
            <div class="kpi-value" style="color:#D97706">${codingBreakdown.runtimeFailures}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Timeouts</div>
            <div class="kpi-value" style="color:#B45309">${codingBreakdown.timeouts}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Pass Rate</div>
            <div class="kpi-value">${codingBreakdown.testCasePassRate}%</div>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div style="color:var(--danger)">Error: ${err.message}</div>`;
  }
};

document.getElementById('closeQModalBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('questionAnalyticsModal');
  if (modal) modal.style.display = 'none';
});

async function loadExamCodingView() {
  if (!currentAnalyticsExamId) return;
  const tbody = document.getElementById('examCodingQuestionsBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--muted)">Loading asynchronous coding analytics...</td></tr>';

  const period = document.getElementById('analyticsPeriodSelect')?.value || 'all';
  const res = await aapi(`/api/organization/exams/${currentAnalyticsExamId}/analytics/coding?period=${period}`);
  if (!res.success || !res.data) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--danger);padding:20px">Failed to load coding metrics</td></tr>';
    return;
  }

  const { summary, questions } = res.data;

  document.getElementById('kpiCodingTotal').textContent = (summary.totalCodingSubmissions || 0).toLocaleString();
  document.getElementById('kpiCodingUniqueStudents').textContent = `${summary.uniqueCandidatesSubmitting || 0} unique candidates`;
  document.getElementById('kpiCodingAccepted').textContent = (summary.successfulExecutions || 0).toLocaleString();
  document.getElementById('kpiCodingCompileErrors').textContent = (summary.compilationFailures || 0).toLocaleString();
  document.getElementById('kpiCodingRuntimeErrors').textContent = (summary.runtimeFailures || 0).toLocaleString();
  document.getElementById('kpiCodingTimeouts').textContent = (summary.timeouts || 0).toLocaleString();
  document.getElementById('kpiCodingTcPassRate').textContent = `${summary.testCasePassRate || 0}%`;
  document.getElementById('kpiCodingTcRatio').textContent = `${summary.testCasesPassed || 0} / ${summary.testCasesEvaluated || 0} evaluated`;

  if (!questions || questions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--muted)">No coding questions or submissions recorded for this exam.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  questions.forEach((q) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(q.title || `Question #${q.questionId}`)}</strong></td>
      <td>${q.marks}</td>
      <td>${q.submissionsCount}</td>
      <td>${q.uniqueCandidates}</td>
      <td><strong style="color:#059669">${q.acceptedCount}</strong></td>
      <td><span style="color:#DC2626">${q.compilationFailures}</span></td>
      <td><span style="color:#D97706">${q.runtimeFailures}</span></td>
      <td><span style="color:#B45309">${q.timeouts}</span></td>
      <td><strong>${q.testCasePassRate}%</strong></td>
      <td>${q.averageScore} / ${q.marks}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadExamPerformanceView() {
  if (!currentAnalyticsExamId) return;
  const period = document.getElementById('analyticsPeriodSelect')?.value || 'all';

  const res = await aapi(`/api/organization/exams/${currentAnalyticsExamId}/analytics/performance?period=${period}`);
  if (!res.success || !res.data) return;

  const { scoreDistribution, durationDistribution, passFail, statistics, categoryPerformance } = res.data;

  // 1. Score Distribution Chart
  renderExamScoreChart(scoreDistribution);

  // 2. Duration Distribution Chart
  renderExamDurationChart(durationDistribution);

  // 3. Pass / Fail Chart
  renderExamPassFailChart(passFail);

  // 4. Category Performance Chart
  renderExamCategoryChart(categoryPerformance);

  // 5. Statistics Table
  renderExamStatsGrid(statistics);
}

function renderExamScoreChart(distribution) {
  if (!window.Chart) return;
  if (!distribution || distribution.length === 0 || distribution.every(d => d.count === 0)) {
    renderEmptyAnalyticsChart('chartExamScoreDistribution', 'No completed attempts to analyze score distribution');
    return;
  }

  const canvas = resetAnalyticsCanvas('chartExamScoreDistribution');
  if (!canvas) return;

  if (examAnalyticsCharts.score) {
    try { examAnalyticsCharts.score.destroy(); } catch (e) {}
    examAnalyticsCharts.score = null;
  }

  const ctx = canvas.getContext('2d');
  examAnalyticsCharts.score = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: distribution.map(d => d.bucket),
      datasets: [{
        label: 'Candidates',
        data: distribution.map(d => d.count),
        backgroundColor: '#4F46E5',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

function renderExamDurationChart(distribution) {
  if (!window.Chart) return;
  if (!distribution || distribution.length === 0 || distribution.every(d => d.count === 0)) {
    renderEmptyAnalyticsChart('chartExamDurationDistribution', 'No duration history recorded for this date range');
    return;
  }

  const canvas = resetAnalyticsCanvas('chartExamDurationDistribution');
  if (!canvas) return;

  if (examAnalyticsCharts.duration) {
    try { examAnalyticsCharts.duration.destroy(); } catch (e) {}
    examAnalyticsCharts.duration = null;
  }

  const ctx = canvas.getContext('2d');
  examAnalyticsCharts.duration = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: distribution.map(d => d.bucket),
      datasets: [{
        label: 'Attempts',
        data: distribution.map(d => d.count),
        backgroundColor: '#7C3AED',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

function renderExamPassFailChart(passFail) {
  if (!window.Chart) return;
  if (!passFail || (passFail.passed === 0 && passFail.failed === 0)) {
    renderEmptyAnalyticsChart('chartExamPassFail', 'No finalized attempts available');
    return;
  }

  const canvas = resetAnalyticsCanvas('chartExamPassFail');
  if (!canvas) return;

  if (examAnalyticsCharts.passFail) {
    try { examAnalyticsCharts.passFail.destroy(); } catch (e) {}
    examAnalyticsCharts.passFail = null;
  }

  const ctx = canvas.getContext('2d');
  examAnalyticsCharts.passFail = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [`Passed (${passFail.passRate}%)`, `Failed (${passFail.failRate}%)`],
      datasets: [{
        data: [passFail.passed, passFail.failed],
        backgroundColor: ['#059669', '#DC2626'],
        borderWidth: 2,
        borderColor: '#FFFFFF'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      cutout: '65%'
    }
  });
}

function renderExamCategoryChart(categories) {
  if (!window.Chart) return;
  if (!categories || categories.length === 0) {
    renderEmptyAnalyticsChart('chartExamCategoryPerformance', 'No section or category data found');
    return;
  }

  const canvas = resetAnalyticsCanvas('chartExamCategoryPerformance');
  if (!canvas) return;

  if (examAnalyticsCharts.category) {
    try { examAnalyticsCharts.category.destroy(); } catch (e) {}
    examAnalyticsCharts.category = null;
  }

  const ctx = canvas.getContext('2d');
  examAnalyticsCharts.category = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: categories.map(c => c.category.toUpperCase()),
      datasets: [{
        label: 'Accuracy %',
        data: categories.map(c => c.averagePercentage),
        backgroundColor: '#2563EB',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, max: 100 }
      }
    }
  });
}

function renderExamStatsGrid(stats) {
  const container = document.getElementById('examStatsGrid');
  if (!container) return;
  container.innerHTML = '';

  const metrics = [
    { label: 'Count (N)', val: stats.count },
    { label: 'Mean', val: stats.mean !== null ? `${stats.mean}%` : '—' },
    { label: 'Median', val: stats.median !== null ? `${stats.median}%` : '—' },
    { label: 'Std Dev (σ)', val: stats.standardDeviation !== null ? stats.standardDeviation : '—' },
    { label: 'Min Score', val: stats.min !== null ? `${stats.min}%` : '—' },
    { label: 'Max Score', val: stats.max !== null ? `${stats.max}%` : '—' },
    { label: '25th Pct (Q1)', val: stats.q1 !== null ? `${stats.q1}%` : '—' },
    { label: '75th Pct (Q3)', val: stats.q3 !== null ? `${stats.q3}%` : '—' },
    { label: '90th Pct (P90)', val: stats.p90 !== null ? `${stats.p90}%` : '—' },
    { label: 'IQR', val: stats.iqr !== null ? `${stats.iqr}%` : '—' },
    { label: 'Avg Duration', val: stats.averageDurationMinutes !== null ? `${stats.averageDurationMinutes}m` : '—' },
    { label: 'Median Duration', val: stats.medianDurationMinutes !== null ? `${stats.medianDurationMinutes}m` : '—' }
  ];

  metrics.forEach((m) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;padding:10px 12px;border:1px solid var(--line);border-radius:6px';
    card.innerHTML = `
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600">${m.label}</div>
      <div style="font-size:16px;font-weight:700;margin-top:2px">${m.val}</div>
    `;
    container.appendChild(card);
  });
}

async function loadExamCandidatesView() {
  if (!currentAnalyticsExamId) return;
  const tbody = document.getElementById('examCandidatesBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--muted)">Loading candidates list...</td></tr>';

  const status = document.getElementById('candidateStatusFilter')?.value || 'all';
  const sort = document.getElementById('candidateSortFilter')?.value || 'score_desc';
  const search = document.getElementById('candidateSearchInput')?.value || '';

  const params = new URLSearchParams({
    page: currentCandidatePage,
    limit: 20
  });
  if (status !== 'all') params.append('status', status);
  if (sort) params.append('sort', sort);
  if (search) params.append('search', search);

  const res = await aapi(`/api/organization/exams/${currentAnalyticsExamId}/analytics/candidates?${params.toString()}`);
  if (!res.success || !res.data) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--danger);padding:20px">Failed to load candidates</td></tr>';
    return;
  }

  const { candidates, pagination } = res.data;
  const infoEl = document.getElementById('candidatePaginationInfo');
  const prevBtn = document.getElementById('candidatePrevBtn');
  const nextBtn = document.getElementById('candidateNextBtn');
  const pageEl = document.getElementById('candidateCurrentPage');

  if (infoEl) infoEl.textContent = `Showing ${candidates.length} of ${pagination.total} candidates`;
  if (pageEl) pageEl.textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
  if (prevBtn) prevBtn.disabled = (pagination.page <= 1);
  if (nextBtn) nextBtn.disabled = (pagination.page >= pagination.totalPages);

  if (candidates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted)">No candidates found matching the filters.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  candidates.forEach((c) => {
    const tr = document.createElement('tr');
    const resultBadge = c.passed
      ? '<span class="status-badge status-live" style="background:#ECFDF5;color:#059669">Passed</span>'
      : (c.latestStatus === 'submitted' ? '<span class="status-badge status-draft" style="background:#FEF2F2;color:#DC2626">Failed</span>' : '<span style="color:var(--muted)">Pending</span>');

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(c.name || 'Anonymous')}</strong>
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(c.email || '')}</div>
      </td>
      <td>${escapeHtml(c.college || '—')}</td>
      <td>${c.attemptCount}</td>
      <td><span class="status-badge status-${(c.latestStatus || 'started').toLowerCase()}">${c.latestStatus}</span></td>
      <td>${c.score !== null ? c.score : '—'} / ${c.totalMarks || '—'}</td>
      <td><strong>${c.percentage !== null ? `${c.percentage}%` : '—'}</strong></td>
      <td>${c.scholarshipPct > 0 ? `<strong style="color:#059669">${c.scholarshipPct}%</strong>` : '—'}</td>
      <td>${resultBadge}</td>
      <td><span style="font-size:12px;color:var(--muted)">${c.lastSubmittedAt ? new Date(c.lastSubmittedAt).toLocaleDateString() : '—'}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// Utility: debounce
function debounce(fn, delay = 300) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Back to Exams button
document.getElementById('backToExamsBtn')?.addEventListener('click', () => {
  destroyAllExamAnalyticsCharts();
  switchTab('exams');
});

// Refresh button
document.getElementById('analyticsRefreshBtn')?.addEventListener('click', () => {
  loadCurrentExamAnalytics();
});

// Period change
document.getElementById('analyticsPeriodSelect')?.addEventListener('change', () => {
  loadCurrentExamAnalytics();
});

// Section navigation pills
document.querySelectorAll('.analytics-nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    showAnalyticsSubSec(btn.dataset.sec);
    loadCurrentExamAnalytics();
  });
});

// Question filters
document.getElementById('qAnalyticsTypeFilter')?.addEventListener('change', loadExamQuestionsView);
document.getElementById('qAnalyticsDifficultyFilter')?.addEventListener('change', loadExamQuestionsView);
document.getElementById('qAnalyticsSortFilter')?.addEventListener('change', loadExamQuestionsView);
document.getElementById('qAnalyticsSearch')?.addEventListener('input', debounce(loadExamQuestionsView, 300));

// Candidate filters & pagination
document.getElementById('candidateStatusFilter')?.addEventListener('change', () => {
  currentCandidatePage = 1;
  loadExamCandidatesView();
});
document.getElementById('candidateSortFilter')?.addEventListener('change', () => {
  currentCandidatePage = 1;
  loadExamCandidatesView();
});
document.getElementById('candidateSearchInput')?.addEventListener('input', debounce(() => {
  currentCandidatePage = 1;
  loadExamCandidatesView();
}, 300));

document.getElementById('candidatePrevBtn')?.addEventListener('click', () => {
  if (currentCandidatePage > 1) {
    currentCandidatePage--;
    loadExamCandidatesView();
  }
});

document.getElementById('candidateNextBtn')?.addEventListener('click', () => {
  currentCandidatePage++;
  loadExamCandidatesView();
});


// Initial boot
gate();

