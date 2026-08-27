const passwordForm = document.getElementById('password-form');
const passwordError = document.getElementById('password-error');
const passwordSuccess = document.getElementById('password-success');
const logoutBtn = document.getElementById('logout-btn');
const settingsNav = document.getElementById('settings-nav');
const calendarStatus = document.getElementById('calendar-status');
const calendarConnectBtn = document.getElementById('calendar-connect-btn');
const calendarDisconnectBtn = document.getElementById('calendar-disconnect-btn');
const apiTokenInput = document.getElementById('api-token-input');
const apiTokenCopyBtn = document.getElementById('api-token-copy-btn');
const apiTokenRegenBtn = document.getElementById('api-token-regen-btn');
const apiTokenSuccess = document.getElementById('api-token-success');
const pushToggle = document.getElementById('push-toggle');
const pushStatus = document.getElementById('push-status');

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function loadPushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pushToggle.disabled = true;
    pushStatus.textContent = '이 브라우저는 알림을 지원하지 않습니다.';
    return;
  }
  const res = await fetch('/api/push/status');
  if (!res.ok) return;
  const { subscribed } = await res.json();
  pushToggle.checked = subscribed;
}

pushToggle.addEventListener('change', async () => {
  if (pushToggle.checked) {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        pushToggle.checked = false;
        pushStatus.textContent = '알림 권한이 거부되었습니다.';
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const keyRes = await fetch('/api/push/vapid-public-key');
      const { key } = await keyRes.json();
      if (!key) {
        pushToggle.checked = false;
        pushStatus.textContent = '알림 기능이 아직 서버에 설정되지 않았습니다.';
        return;
      }
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription }),
      });
      pushStatus.textContent = '알림이 설정되었습니다.';
    } catch (err) {
      pushToggle.checked = false;
      pushStatus.textContent = '알림 설정에 실패했습니다: ' + err.message;
    }
  } else {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      pushStatus.textContent = '알림이 해제되었습니다.';
    } catch (err) {
      pushStatus.textContent = '';
    }
  }
  setTimeout(() => (pushStatus.textContent = ''), 3000);
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

settingsNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-item');
  if (!btn) return;
  for (const navBtn of settingsNav.querySelectorAll('.settings-nav-item')) {
    navBtn.classList.toggle('active', navBtn === btn);
  }
  for (const panel of document.querySelectorAll('.settings-panel')) {
    panel.hidden = panel.dataset.panel !== btn.dataset.tab;
  }
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

async function loadCalendarStatus() {
  const res = await fetch('/api/calendar/status');
  if (!res.ok) return;
  const { connected } = await res.json();
  calendarStatus.textContent = connected ? '연결됨 ✓' : '아직 연결되지 않았습니다.';
  calendarConnectBtn.hidden = connected;
  calendarDisconnectBtn.hidden = !connected;
}

calendarDisconnectBtn.addEventListener('click', async () => {
  if (!confirm('구글 캘린더 연결을 해제할까요? 음성 명령으로 일정 추가가 안 됩니다.')) return;
  await fetch('/api/calendar/disconnect', { method: 'POST' });
  loadCalendarStatus();
});

async function loadApiToken() {
  const res = await fetch('/api/account/api-token');
  if (!res.ok) return;
  const { token } = await res.json();
  apiTokenInput.value = token;
}

apiTokenCopyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(apiTokenInput.value);
  apiTokenSuccess.textContent = '복사되었습니다.';
  setTimeout(() => (apiTokenSuccess.textContent = ''), 2000);
});

apiTokenRegenBtn.addEventListener('click', async () => {
  if (!confirm('토큰을 재발급하면 기존 토큰으로 만든 단축어는 더 이상 동작하지 않습니다. 계속할까요?')) return;
  const res = await fetch('/api/account/api-token/regenerate', { method: 'POST' });
  const { token } = await res.json();
  apiTokenInput.value = token;
  apiTokenSuccess.textContent = '재발급되었습니다. 단축어에도 새 토큰을 반영하세요.';
  setTimeout(() => (apiTokenSuccess.textContent = ''), 3000);
});

function checkCalendarQueryParam() {
  const params = new URLSearchParams(location.search);
  const calendarParam = params.get('calendar');
  if (!calendarParam) return;
  const messages = {
    connected: '구글 계정이 연결되었습니다 (캘린더·메일 발송·할 일).',
    no_refresh_token: '이미 한 번 연결한 적이 있어 다시 동의가 필요합니다. 구글 계정 설정에서 스펙터 접근 권한을 해제한 뒤 다시 시도해주세요.',
    error: '구글 계정 연결에 실패했습니다.',
    not_configured: '구글 로그인이 아직 설정되지 않아 이 연동을 쓸 수 없습니다.',
  };
  if (messages[calendarParam]) {
    calendarStatus.textContent = messages[calendarParam];
  }
  history.replaceState(null, '', location.pathname);
}

async function init() {
  const res = await fetch('/api/settings');
  if (res.status === 401) return (location.href = '/login.html');
  const settings = await res.json();
  document.documentElement.setAttribute('data-theme', settings.theme || 'light');
  checkCalendarQueryParam();
  await loadCalendarStatus();
  await loadApiToken();
  await loadPushStatus();
}

init();
