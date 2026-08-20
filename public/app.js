const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const resetBtn = document.getElementById('reset-btn');

let history = [];

function addMessage(role, text, opts = {}) {
  const el = document.createElement('div');
  el.className = `msg ${role}${opts.error ? ' error' : ''}`;
  if (role === 'specter') {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'SPECTER';
    el.appendChild(label);
  }
  const body = document.createElement('span');
  body.textContent = text;
  el.appendChild(body);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function addPendingMessage() {
  const el = document.createElement('div');
  el.className = 'msg specter pending';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'SPECTER';
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  el.appendChild(label);
  el.appendChild(dots);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function setComposerDisabled(disabled) {
  sendBtn.disabled = disabled;
  input.disabled = disabled;
}

function startRateLimitCountdown(el, seconds, restoreText) {
  let remaining = seconds;
  setComposerDisabled(true);
  const body = el.querySelector('span:last-child');
  const timer = setInterval(() => {
    if (remaining <= 0) {
      clearInterval(timer);
      body.textContent = '이제 다시 시도할 수 있습니다. 아래에 메시지가 복원되어 있습니다.';
      setComposerDisabled(false);
      input.value = restoreText;
      input.dispatchEvent(new Event('input'));
      input.focus();
      return;
    }
    body.textContent = `요청이 많아 잠시 제한되었습니다. ${remaining}초 후 다시 시도할 수 있습니다.`;
    remaining -= 1;
  }, 1000);
  body.textContent = `요청이 많아 잠시 제한되었습니다. ${remaining}초 후 다시 시도할 수 있습니다.`;
  remaining -= 1;
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

resetBtn.addEventListener('click', () => {
  history = [];
  chat.innerHTML = '';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage('user', text);
  history.push({ role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';
  setComposerDisabled(true);

  const pending = addPendingMessage();

  let res, data;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    data = await res.json();
  } catch (err) {
    pending.remove();
    history.pop();
    addMessage('specter', '서버에 연결할 수 없습니다.', { error: true });
    setComposerDisabled(false);
    input.focus();
    return;
  }

  pending.remove();

  if (!res.ok) {
    history.pop();
    if (data.kind === 'rate_limit') {
      const el = addMessage('specter', '', { error: true });
      startRateLimitCountdown(el, data.retryAfterSeconds || 30, text);
      return; // 컴포저 재활성화는 카운트다운이 끝난 뒤 startRateLimitCountdown이 처리한다.
    }
    addMessage('specter', data.error || '알 수 없는 오류가 발생했습니다.', { error: true });
    setComposerDisabled(false);
    input.focus();
    return;
  }

  addMessage('specter', data.text);
  history.push({ role: 'assistant', content: data.text });
  setComposerDisabled(false);
  input.focus();
});
