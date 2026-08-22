const intensityOptions = document.getElementById('intensity-options');
const performanceOptions = document.getElementById('performance-options');
const themeOptions = document.getElementById('theme-options');
const passwordForm = document.getElementById('password-form');
const passwordError = document.getElementById('password-error');
const passwordSuccess = document.getElementById('password-success');
const logoutBtn = document.getElementById('logout-btn');

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

function markActive(container, value) {
  for (const btn of container.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.value === value);
  }
}

async function saveSetting(key, value) {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
}

intensityOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  markActive(intensityOptions, btn.dataset.value);
  saveSetting('pushbackIntensity', btn.dataset.value);
});

performanceOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  markActive(performanceOptions, btn.dataset.value);
  saveSetting('performanceMode', btn.dataset.value);
});

themeOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  markActive(themeOptions, btn.dataset.value);
  document.documentElement.setAttribute('data-theme', btn.dataset.value);
  saveSetting('theme', btn.dataset.value);
});

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  passwordError.textContent = '';
  passwordSuccess.textContent = '';
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;

  const res = await fetch('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) {
    passwordError.textContent = data.error || '변경에 실패했습니다.';
    return;
  }
  passwordSuccess.textContent = '비밀번호가 변경되었습니다.';
  passwordForm.reset();
});

async function init() {
  const res = await fetch('/api/settings');
  if (res.status === 401) return (location.href = '/login.html');
  const settings = await res.json();
  document.documentElement.setAttribute('data-theme', settings.theme || 'light');
  markActive(intensityOptions, settings.pushbackIntensity);
  markActive(performanceOptions, settings.performanceMode);
  markActive(themeOptions, settings.theme);
}

init();
