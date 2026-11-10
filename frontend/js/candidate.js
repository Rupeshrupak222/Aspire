/**
 * ASPIRE CANDIDATE PORTAL — SCRIPT
 * Manages candidate dashboard navigation, profile data, attempt tracking, and certificate downloads.
 */

(() => {
  'use strict';

  // Navigation Pane Switcher
  const navItems = document.querySelectorAll('.sidebar-nav .sidebar-item');
  const panes = document.querySelectorAll('.candidate-pane');

  function switchPane(targetId) {
    panes.forEach(p => p.classList.remove('active'));
    navItems.forEach(i => i.classList.remove('active'));

    const pane = document.getElementById(targetId);
    if (pane) pane.classList.add('active');

    const navItem = document.querySelector(`.sidebar-item[data-pane="${targetId}"]`);
    if (navItem) navItem.classList.add('active');
  }

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetPane = item.dataset.pane;
      switchPane(targetPane);
      window.location.hash = item.getAttribute('href');
    });
  });

  // Handle URL hash on load
  if (window.location.hash) {
    const paneName = 'pane-' + window.location.hash.replace('#', '');
    if (document.getElementById(paneName)) {
      switchPane(paneName);
    }
  }

  // Logout handler
  document.getElementById('candLogoutBtn')?.addEventListener('click', () => {
    sessionStorage.removeItem('aspire_token');
    sessionStorage.removeItem('aspire_result');
    window.location.href = '/index.html';
  });

  // Load Data
  async function loadCandidateData() {
    const token = getToken();
    const resultRaw = sessionStorage.getItem(RESULT_KEY);

    let result = null;
    try {
      if (resultRaw) result = JSON.parse(resultRaw);
    } catch (e) {}

    if (token) {
      try {
        const attempt = await api(`/api/attempt/${token}`);
        if (attempt && attempt.student) {
          const s = attempt.student;
          document.getElementById('greetingHeading').textContent = `Good Day, ${s.name || 'Candidate'}!`;
          document.getElementById('candNavName').textContent = s.name || 'Candidate';
          document.getElementById('candAvatar').textContent = (s.name || 'C').charAt(0).toUpperCase();

          document.getElementById('profName').value = s.name || '—';
          document.getElementById('profPhone').value = s.phone || '—';
          document.getElementById('profEmail').value = s.email || '—';
          document.getElementById('profCollege').value = s.college || '—';
          document.getElementById('profTrack').value = s.track || 'Technical Evaluation';
          document.getElementById('profYear').value = s.grad_year || '2026';
          document.getElementById('certCandName').textContent = s.name || 'Candidate';
        }
      } catch (err) {
        console.warn('Could not fetch active attempt info:', err.message);
      }
    }

    // Populate Results / Scholarship if submitted
    if (result) {
      document.getElementById('kpiScholarshipTier').textContent = `${result.scholarship_pct || 0}% Awarded`;
      document.getElementById('schAwardPct').textContent = `${result.scholarship_pct || 0}%`;
      document.getElementById('schClaimCode').textContent = result.claim_code || '—';
      document.getElementById('certDisplayId').textContent = result.certificate_id || '—';

      if (result.certificate_id) {
        const certLink = `/api/certificate/${result.certificate_id}`;
        const dlBtn = document.getElementById('certDownloadLink');
        if (dlBtn) dlBtn.href = certLink;
      }

      const recentBox = document.getElementById('recentResultBox');
      if (recentBox) {
        recentBox.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
            <div>
              <div style="font-weight:700;font-size:1.1rem;color:var(--color-midnight)">Score: ${result.score} / ${result.total} (${result.percentage}%)</div>
              <div style="font-size:0.85rem;color:var(--color-text-secondary);margin-top:2px">Certificate: ${result.certificate_id || 'Issued'} · Claim: <strong>${result.claim_code || '—'}</strong></div>
            </div>
            <div>
              <span class="badge" style="margin:0;font-size:0.9rem;padding:6px 16px">${result.scholarship_pct}% Scholarship</span>
            </div>
          </div>
        `;
      }

      const resultsPane = document.getElementById('resultsPaneContent');
      if (resultsPane) {
        resultsPane.innerHTML = `
          <div style="text-align:center;padding:24px 0">
            <div class="score-big">${result.score} / ${result.total}</div>
            <div style="font-size:1.2rem;font-weight:600;color:var(--color-text-secondary)">${result.percentage}% Evaluation Score</div>
            <div><span class="badge">${result.scholarship_pct}% Scholarship Awarded</span></div>
            <p style="margin-top:16px;color:var(--color-text-secondary)">Claim Code: <strong>${result.claim_code}</strong> · Certificate ID: <strong>${result.certificate_id}</strong></p>
            <a class="btn" href="/result.html" style="margin-top:12px">View Full Performance Breakdown ↗</a>
          </div>
        `;
      }
    }
  }

  loadCandidateData();
})();

