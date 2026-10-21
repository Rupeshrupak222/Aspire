// Registration page logic.
document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('regBtn');
  btn.disabled = true;
  document.getElementById('regErr').style.display = 'none';
  const payload = {
    name: document.getElementById('name').value,
    phone: document.getElementById('phone').value,
    email: document.getElementById('email').value,
    college: document.getElementById('college').value,
    city: document.getElementById('city').value,
    grad_year: document.getElementById('grad_year').value,
    track: document.getElementById('track').value,
    campaign_code: document.getElementById('campaign_code').value
  };
  try {
    const data = await api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
    setToken(data.token);
    sessionStorage.removeItem(RESULT_KEY);
    window.location.href = '/instructions.html';
  } catch (err) {
    showErr('regErr', err.message);
    btn.disabled = false;
  }
});
