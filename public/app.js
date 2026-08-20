const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const newProjectBtn = document.getElementById('new-project-btn');
const projectList = document.getElementById('project-list');
const userEmailEl = document.getElementById('user-email');
const logoutBtn = document.getElementById('logout-btn');
const installBtn = document.getElementById('install-btn');

let currentConversationId = null;
setComposerDisabled(true); // init()이 끝나 currentConversationId가 정해지기 전까지는 전송을 막는다.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
});

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !isStandalone) installBtn.hidden = false;

installBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    return;
  }
  if (isIOS) {
    alert('공유 버튼(□↑) 클릭 → "홈 화면에 추가"를 선택하면 앱처럼 설치됩니다.');
  }
});

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
  body.className = 'msg-body';
  body.textContent = text;
  el.appendChild(body);
  if (role === 'specter' && !opts.error) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = '복사';
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(body.textContent);
      copyBtn.textContent = '✓';
      setTimeout(() => (copyBtn.textContent = '⧉'), 1200);
    });
    el.appendChild(copyBtn);
  }
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
  const body = document.createElement('span');
  body.className = 'msg-body';
  el.appendChild(label);
  el.appendChild(dots);
  el.appendChild(body);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

// 스트리밍 첫 글자가 도착하면 점 3개를 실제 텍스트로 바꾼다.
function appendStreamChunk(pendingEl, chunk) {
  const dots = pendingEl.querySelector('.dots');
  if (dots) dots.remove();
  pendingEl.classList.remove('pending');
  const body = pendingEl.querySelector('.msg-body');
  body.textContent += chunk;
  chat.scrollTop = chat.scrollHeight;
}

function setComposerDisabled(disabled) {
  sendBtn.disabled = disabled;
  input.disabled = disabled;
}

function startRateLimitCountdown(el, seconds, restoreText) {
  let remaining = seconds;
  setComposerDisabled(true);
  const body = el.querySelector('.msg-body');
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
      const row = document.createElement('div');
      row.className = 'project-row';

      const item = document.createElement('button');
      item.className = `project-item${c.id === currentConversationId ? ' active' : ''}`;
      item.textContent = c.title;
      item.title = '더블클릭하면 이름을 바꿀 수 있습니다';
      item.addEventListener('click', () => openConversation(c.id));
      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startTitleEdit(row, c);
      });

      const editBtn = document.createElement('button');
      editBtn.className = 'project-category-edit';
      editBtn.title = '카테고리 변경';
      editBtn.textContent = '⚑';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startCategoryEdit(row, c);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'project-category-edit';
      deleteBtn.title = '프로젝트 삭제';
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`"${c.title}" 프로젝트를 삭제할까요? 되돌릴 수 없습니다.`)) return;
        await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
        if (c.id === currentConversationId) {
          currentConversationId = null;
          const remaining = await renderProjectList();
          if (remaining.length === 0) await createNewProject();
          else await openConversation(remaining[0].id);
        } else {
          renderProjectList();
        }
      });

      row.appendChild(item);
      row.appendChild(editBtn);
      row.appendChild(deleteBtn);
      projectList.appendChild(row);
    }
  }
  return conversations;
}

function startCategoryEdit(row, conversation) {
  row.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'project-category-input';
  input.value = conversation.category === '미분류' ? '' : conversation.category;
  input.placeholder = '카테고리 (비워두면 미분류)';
  row.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    await fetch(`/api/conversations/${conversation.id}/category`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: input.value.trim() }),
    });
    renderProjectList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') renderProjectList();
  });
  input.addEventListener('blur', save);
}

function startTitleEdit(row, conversation) {
  row.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'project-category-input';
  input.value = conversation.title;
  row.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    const title = input.value.trim();
    if (title) {
      await fetch(`/api/conversations/${conversation.id}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    }
    renderProjectList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') renderProjectList();
  });
  input.addEventListener('blur', save);
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
  const res = await fetch('/api/conversations', { method: 'POST' });
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

const SEND_ICON = '<path d="M4 12h15m0 0-6-6m6 6-6 6"/>';
const STOP_ICON = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
let activeAbortController = null;

function setGenerating(isGenerating) {
  input.disabled = isGenerating;
  sendBtn.type = isGenerating ? 'button' : 'submit';
  sendBtn.disabled = false;
  sendBtn.querySelector('svg').innerHTML = isGenerating ? STOP_ICON : SEND_ICON;
  sendBtn.setAttribute('aria-label', isGenerating ? '정지' : '전송');
}
sendBtn.addEventListener('click', () => {
  if (sendBtn.type === 'button') activeAbortController?.abort();
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
  setGenerating(true);

  const pending = addPendingMessage();
  activeAbortController = new AbortController();

  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, message: text }),
      signal: activeAbortController.signal,
    });
  } catch (err) {
    pending.remove();
    addMessage('specter', '서버에 연결할 수 없습니다.', { error: true });
    setGenerating(false);
    input.focus();
    return;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    pending.remove();
    if (res.status === 401) return (location.href = '/login.html');
    if (data.kind === 'rate_limit') {
      const el = addMessage('specter', '', { error: true });
      startRateLimitCountdown(el, data.retryAfterSeconds || 30, text);
      setGenerating(false);
      return;
    }
    addMessage('specter', data.error || '알 수 없는 오류가 발생했습니다.', { error: true });
    setGenerating(false);
    input.focus();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      appendStreamChunk(pending, decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    // AbortError: 정지 버튼으로 중단됨 — 지금까지 받은 텍스트는 그대로 남긴다.
  }

  pending.classList.remove('pending');
  if (!pending.querySelector('.msg-body').textContent) pending.remove();
  else if (!pending.querySelector('.copy-btn')) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = '복사';
    copyBtn.textContent = '⧉';
    const body = pending.querySelector('.msg-body');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(body.textContent);
      copyBtn.textContent = '✓';
      setTimeout(() => (copyBtn.textContent = '⧉'), 1200);
    });
    pending.appendChild(copyBtn);
  }

  activeAbortController = null;
  setGenerating(false);
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
