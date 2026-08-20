const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const newProjectBtn = document.getElementById('new-project-btn');
const projectList = document.getElementById('project-list');
const userEmailEl = document.getElementById('user-email');
const logoutBtn = document.getElementById('logout-btn');

let currentConversationId = null;
setComposerDisabled(true); // init()이 끝나 currentConversationId가 정해지기 전까지는 전송을 막는다.

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

async function renderProjectList() {
  const res = await fetch('/api/conversations');
  if (res.status === 401) return (location.href = '/login.html');
  const conversations = await res.json();

  const byCategory = new Map();
  for (const c of conversations) {
    const key = c.category || '미분류';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(c);
  }

  projectList.innerHTML = '';
  for (const [category, items] of byCategory) {
    const heading = document.createElement('div');
    heading.className = 'project-category';
    heading.textContent = category;
    projectList.appendChild(heading);

    for (const c of items) {
      const item = document.createElement('button');
      item.className = `project-item${c.id === currentConversationId ? ' active' : ''}`;
      item.textContent = c.title;
      item.addEventListener('click', () => openConversation(c.id));
      projectList.appendChild(item);
    }
  }
  return conversations;
}

async function openConversation(id) {
  currentConversationId = id;
  chat.innerHTML = '';
  const res = await fetch(`/api/conversations/${id}`);
  if (res.status === 401) return (location.href = '/login.html');
  const conversation = await res.json();
  for (const t of conversation.turns) {
    addMessage(t.role === 'user' ? 'user' : 'specter', t.content);
  }
  setComposerDisabled(false);
  renderProjectList();
  input.focus();
}

async function createNewProject() {
  const category = prompt('카테고리를 입력하세요 (비워두면 미분류)', '') || undefined;
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  if (res.status === 401) return (location.href = '/login.html');
  const conversation = await res.json();
  await openConversation(conversation.id);
}

newProjectBtn.addEventListener('click', createNewProject);

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !currentConversationId) return;

  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  setComposerDisabled(true);

  const pending = addPendingMessage();

  let res, data;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, message: text }),
    });
    data = await res.json();
  } catch (err) {
    pending.remove();
    addMessage('specter', '서버에 연결할 수 없습니다.', { error: true });
    setComposerDisabled(false);
    input.focus();
    return;
  }

  pending.remove();

  if (!res.ok) {
    if (res.status === 401) return (location.href = '/login.html');
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
  setComposerDisabled(false);
  input.focus();
  renderProjectList(); // 첫 메시지 이후 제목이 바뀌므로 목록 갱신
});

async function init() {
  const meRes = await fetch('/api/me');
  if (meRes.status === 401) return (location.href = '/login.html');
  const me = await meRes.json();
  userEmailEl.textContent = me.email;
  document.documentElement.setAttribute('data-theme', me.settings?.theme || 'light');

  const conversations = await renderProjectList();
  if (conversations.length === 0) {
    await createNewProject();
  } else {
    await openConversation(conversations[0].id);
  }
}

init();
