// Result page: score, scholarship, certificate download, claim code.
async function init() {
  let result = null;
  try {
    result = JSON.parse(sessionStorage.getItem(RESULT_KEY) || 'null');
  } catch { result = null; }
  if (!result || result.status !== 'submitted') {
    const token = getToken();
    if (!token) { window.location.href = '/index.html'; return; }
    try {
      const att = await api(`/api/attempt/${token}`);
      if (att.status === 'submitted') result = att;
    } catch { /* fall through */ }
  }
  if (!result || result.status !== 'submitted') {
    window.location.href = '/index.html';
    return;
  }
  document.getElementById('rName').textContent = result.student_name || '';
  document.getElementById('rScore').textContent = `${result.score} / ${result.total_marks}`;
  document.getElementById('rPct').textContent = `${Number(result.percentage).toFixed(1)}%`;
  const sch = document.getElementById('rSch');
  if (result.scholarship_pct > 0) {
    sch.textContent = `${result.scholarship_pct}% Scholarship Earned`;
  } else {
    sch.textContent = 'Certificate of Participation';
  }
  document.getElementById('rClaim').textContent = result.claim_code || '—';
  document.getElementById('rCertId').textContent = result.certificate_id || '—';
  const dl = document.getElementById('certBtn');
  dl.href = `/api/certificate/${result.certificate_id}`;
  if (result.was_late) {
    document.getElementById('lateNote').style.display = 'block';
  }
  if (result.detail && result.detail.length) {
    const rows = result.detail.map((d, i) =>
      `<tr><td>${i + 1}</td><td>${esc(d.category)}</td><td>${esc(d.type)}</td><td>${d.earned} / ${d.marks}</td></tr>`).join('');
    document.getElementById('detailBody').innerHTML = rows;
    document.getElementById('detailWrap').style.display = 'block';
  }
}
init();
