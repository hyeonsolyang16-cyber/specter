const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const newProjectBtn = document.getElementById('new-project-btn');
const projectList = document.getElementById('project-list');
const userEmailEl = document.getElementById('user-email');
const logoutBtn = document.getElementById('logout-btn');
const installBtn = document.getElementById('install-btn');
const menuBtn = document.getElementById('menu-btn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const appShell = document.querySelector('.app-shell');
const searchInput = document.getElementById('search-input');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachmentPreview = document.getElementById('attachment-preview');
const adminLink = document.getElementById('admin-link');
const micBtn = document.getElementById('mic-btn');
const modeSelect = document.getElementById('mode-select');
const plusBtn = document.getElementById('plus-btn');
const composerExtra = document.getElementById('composer-extra');
const topbarSearchBtn = document.getElementById('topbar-search-btn');

// 모바일: 첨부/마이크를 "+" 버튼 하나로 묶어서 좁은 화면에서 입력줄이 덜 빡빡하게 한다.
plusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  composerExtra.classList.toggle('open');
});
composerExtra.addEventListener('click', () => composerExtra.classList.remove('open'));
document.addEventListener('click', (e) => {
  if (!composerExtra.contains(e.target) && e.target !== plusBtn) composerExtra.classList.remove('open');
});

// 모바일 상단바 검색 아이콘: 사이드바를 열면서 바로 검색창에 포커스한다(한 번의 탭으로).
topbarSearchBtn.addEventListener('click', () => {
  appShell.classList.add('sidebar-open');
  searchInput.focus();
});

// 모바일 길게 누르기: 메시지 액션 버튼을 잠깐 완전히 보이게 한다(터치 기기에서 흔한 패턴).
let longPressTimer = null;
function clearLongPress() {
  document.querySelectorAll('.msg.long-press-active').forEach((m) => m.classList.remove('long-press-active'));
}
chat.addEventListener(
  'touchstart',
  (e) => {
    clearTimeout(longPressTimer);
    const msg = e.target.closest('.msg');
    if (!msg) {
      clearLongPress();
      return;
    }
    longPressTimer = setTimeout(() => {
      clearLongPress();
      msg.classList.add('long-press-active');
      setTimeout(clearLongPress, 4000);
    }, 450);
  },
  { passive: true }
);
chat.addEventListener('touchend', () => clearTimeout(longPressTimer));
chat.addEventListener('touchmove', () => clearTimeout(longPressTimer));

modeSelect.addEventListener('change', () => {
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ performanceMode: modeSelect.value }),
  });
});

// 키보드 단축키: 입력 중이 아닐 때만 동작해서 일반 타이핑을 방해하지 않는다.
// Ctrl/Cmd+K는 입력 중이어도 항상 동작한다(브라우저 주소창 단축키와 같은 관례).
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  const tag = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
  if (isTyping || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  } else if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    createNewProject();
  }
});

let currentConversationId = null;
let searchQuery = '';
let allConversationsCache = [];
const collapsedCategories = new Set();
let pendingAttachments = []; // { mimeType, data(base64), previewUrl }

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function closeSidebar() {
  appShell.classList.remove('sidebar-open');
}
menuBtn.addEventListener('click', () => appShell.classList.toggle('sidebar-open'));
sidebarOverlay.addEventListener('click', closeSidebar);

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  renderProjectListFromCache();
});

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      alert(`첨부파일은 최대 ${MAX_ATTACHMENTS}개까지 가능합니다.`);
      break;
    }
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';
    if (!isImage && !isPdf) {
      alert(`${file.name}은(는) 지원하지 않는 형식입니다. 이미지 또는 PDF만 첨부할 수 있습니다.`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      alert(`${file.name} 파일이 너무 큽니다. 8MB 이하만 첨부할 수 있습니다.`);
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
    if (!match) continue;
    pendingAttachments.push({
      mimeType: match[1],
      data: match[2],
      name: file.name,
      previewUrl: isImage ? dataUrl : null,
    });
  }
  fileInput.value = '';
  renderAttachmentPreview();
});

function renderAttachmentPreview() {
  attachmentPreview.innerHTML = '';
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    if (a.previewUrl) {
      const img = document.createElement('img');
      img.src = a.previewUrl;
      chip.appendChild(img);
    } else {
      const fileLabel = document.createElement('span');
      fileLabel.textContent = `📄 ${a.name}`;
      chip.appendChild(fileLabel);
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      pendingAttachments.splice(i, 1);
      renderAttachmentPreview();
    });
    chip.appendChild(removeBtn);
    attachmentPreview.appendChild(chip);
  });
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachmentPreview();
}

// 음성 입력 — 크롬/엣지 계열만 지원. 안 되는 브라우저는 마이크 버튼 자체를 숨긴다.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionCtor) {
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'ko-KR';
  recognition.interimResults = true;
  recognition.continuous = false;

  let baseText = '';
  let isRecording = false;

  recognition.addEventListener('start', () => {
    isRecording = true;
    micBtn.classList.add('recording');
    baseText = input.value ? input.value.trim() + ' ' : '';
  });
  recognition.addEventListener('result', (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    input.value = baseText + transcript;
    input.dispatchEvent(new Event('input'));
  });
  recognition.addEventListener('end', () => {
    isRecording = false;
    micBtn.classList.remove('recording');
  });
  recognition.addEventListener('error', () => {
    isRecording = false;
    micBtn.classList.remove('recording');
  });

  micBtn.hidden = false;
  micBtn.addEventListener('click', () => {
    if (isRecording) recognition.stop();
    else {
      recognition.start();
      input.focus();
    }
  });
}

// 음성 출력(TTS) — Web Speech Synthesis API. 대부분의 최신 브라우저가 지원한다.
function speakText(text, btn) {
  if (!('speechSynthesis' in window)) return;
  const wasThisSpeaking = btn.dataset.speaking === 'true';
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    btn.textContent = '🔊';
    btn.dataset.speaking = 'false';
  }
  if (wasThisSpeaking) return; // 같은 버튼을 다시 누르면 정지만 하고 끝낸다.
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ko-KR';
  btn.textContent = '⏸';
  btn.dataset.speaking = 'true';
  utter.onend = () => {
    btn.textContent = '🔊';
    btn.dataset.speaking = 'false';
  };
  utter.onerror = () => {
    btn.textContent = '🔊';
    btn.dataset.speaking = 'false';
  };
  speechSynthesis.speak(utter);
}

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

  if (Array.isArray(opts.attachments)) {
    for (const a of opts.attachments) {
      if (a.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = `data:${a.mimeType};base64,${a.data}`;
        img.alt = '첨부 이미지';
        el.appendChild(img);
      } else {
        const fileChip = document.createElement('span');
        fileChip.className = 'msg-file-chip';
        fileChip.textContent = `📄 ${a.name || '문서'}`;
        el.appendChild(fileChip);
      }
    }
  }

  if (role === 'user' && !opts.error) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.title = '수정';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => editMessage(el, text));
    el.appendChild(editBtn);
  }
  if (role === 'specter' && !opts.error) {
    decorateSpecterMessage(el, body);
  }
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function decorateSpecterMessage(el, body) {
  if (!el.querySelector('.regen-btn')) {
    const regenBtn = document.createElement('button');
    regenBtn.className = 'regen-btn';
    regenBtn.title = '다시 생성';
    regenBtn.textContent = '↻';
    regenBtn.addEventListener('click', () => regenerateFrom(el));
    el.appendChild(regenBtn);
  }
  if (!el.querySelector('.copy-btn')) {
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
  if ('speechSynthesis' in window && !el.querySelector('.speak-btn')) {
    const speakBtn = document.createElement('button');
    speakBtn.className = 'speak-btn';
    speakBtn.title = '읽어주기';
    speakBtn.textContent = '🔊';
    speakBtn.dataset.speaking = 'false';
    speakBtn.addEventListener('click', () => speakText(body.textContent, speakBtn));
    el.appendChild(speakBtn);
  }
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
  allConversationsCache = await res.json();
  renderProjectListFromCache();
  return allConversationsCache;
}

function renderProjectListFromCache() {
  const conversations = searchQuery
    ? allConversationsCache.filter((c) => c.title.toLowerCase().includes(searchQuery))
    : allConversationsCache;

  const byCategory = new Map();
  for (const c of conversations) {
    const key = c.category || '미분류';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(c);
  }

  projectList.innerHTML = '';
  if (conversations.length === 0 && searchQuery) {
    const empty = document.createElement('div');
    empty.className = 'project-category';
    empty.textContent = '검색 결과 없음';
    projectList.appendChild(empty);
    return;
  }

  for (const [category, items] of byCategory) {
    const isCollapsed = collapsedCategories.has(category);

    const heading = document.createElement('button');
    heading.className = `project-category project-category-toggle${isCollapsed ? ' collapsed' : ''}`;
    heading.innerHTML = `<svg class="category-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
    heading.appendChild(document.createTextNode(`${category} (${items.length})`));
    heading.addEventListener('click', () => {
      if (collapsedCategories.has(category)) collapsedCategories.delete(category);
      else collapsedCategories.add(category);
      renderProjectListFromCache();
    });
    projectList.appendChild(heading);

    if (isCollapsed) continue;

    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'project-row';

      const item = document.createElement('button');
      item.className = `project-item${c.id === currentConversationId ? ' active' : ''}`;
      item.textContent = c.title;
      item.title = '더블클릭하면 이름을 바꿀 수 있습니다';
      item.addEventListener('click', () => {
        openConversation(c.id);
        closeSidebar();
      });
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

const EXAMPLE_PROMPTS = [
  '이 계획을 그대로 진행해도 괜찮을지 검토해줘',
  '이 결정에서 내가 놓치고 있는 리스크가 뭘까?',
  '이 주장을 뒷받침할 근거가 충분한지 확인해줘',
];

function renderEmptyState() {
  chat.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <img src="logo.png" alt="Specter">
    <h2>무엇을 검토해드릴까요?</h2>
  `;
  const prompts = document.createElement('div');
  prompts.className = 'empty-prompts';
  for (const p of EXAMPLE_PROMPTS) {
    const btn = document.createElement('button');
    btn.className = 'empty-prompt-btn';
    btn.textContent = p;
    btn.addEventListener('click', () => {
      input.value = p;
      form.requestSubmit();
    });
    prompts.appendChild(btn);
  }
  wrap.appendChild(prompts);
  chat.appendChild(wrap);
}

// 특정 메시지부터 뒤를 모두 지우고 서버에도 반영한다. 반환값은 지운 turn 개수(=keepCount).
async function rewindTo(msgEl) {
  const allMsgs = Array.from(chat.querySelectorAll('.msg:not(.error)'));
  const idx = allMsgs.indexOf(msgEl);
  if (idx === -1) return -1;
  await fetch(`/api/conversations/${currentConversationId}/rewind`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keepCount: idx }),
  });
  for (let i = allMsgs.length - 1; i >= idx; i--) allMsgs[i].remove();
  return idx;
}

async function editMessage(msgEl, text) {
  if (!currentConversationId || sendBtn.type === 'button') return;
  const idx = await rewindTo(msgEl);
  if (idx === -1) return;
  if (!chat.querySelector('.msg')) renderEmptyState();
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

async function regenerateFrom(msgEl) {
  if (!currentConversationId || sendBtn.type === 'button') return;
  const idx = await rewindTo(msgEl);
  if (idx === -1) return;

  setGenerating(true);
  const pending = addPendingMessage();
  activeAbortController = new AbortController();

  let res;
  try {
    res = await fetch('/api/chat/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId }),
      signal: activeAbortController.signal,
    });
  } catch (err) {
    pending.remove();
    addMessage('specter', '서버에 연결할 수 없습니다.', { error: true });
    setGenerating(false);
    return;
  }
  await handleChatResponse(res, pending, '');
}

async function handleChatResponse(res, pending, restoreText) {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    pending.remove();
    if (res.status === 401) return void (location.href = '/login.html');
    if (data.kind === 'rate_limit') {
      const el = addMessage('specter', '', { error: true });
      startRateLimitCountdown(el, data.retryAfterSeconds || 30, restoreText);
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
  const body = pending.querySelector('.msg-body');
  if (!body.textContent) pending.remove();
  else decorateSpecterMessage(pending, body);

  activeAbortController = null;
  setGenerating(false);
  input.focus();
  renderProjectList(); // 첫 메시지 이후 제목이 바뀌므로 목록 갱신
}

async function openConversation(id) {
  currentConversationId = id;
  chat.innerHTML = '';
  const res = await fetch(`/api/conversations/${id}`);
  if (res.status === 401) return (location.href = '/login.html');
  const conversation = await res.json();
  if (conversation.turns.length === 0) {
    renderEmptyState();
  } else {
    for (const t of conversation.turns) {
      addMessage(t.role === 'user' ? 'user' : 'specter', t.content, { attachments: t.attachments || [] });
    }
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && pendingAttachments.length === 0) || !currentConversationId) return;

  const attachmentsForSend = pendingAttachments.map((a) => ({ mimeType: a.mimeType, data: a.data, name: a.name }));
  const emptyState = chat.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  addMessage('user', text, { attachments: attachmentsForSend });
  input.value = '';
  input.style.height = 'auto';
  clearAttachments();
  setGenerating(true);

  const pending = addPendingMessage();
  activeAbortController = new AbortController();

  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConversationId, message: text, attachments: attachmentsForSend }),
      signal: activeAbortController.signal,
    });
  } catch (err) {
    pending.remove();
    addMessage('specter', '서버에 연결할 수 없습니다.', { error: true });
    setGenerating(false);
    input.focus();
    return;
  }

  await handleChatResponse(res, pending, text);
});

async function init() {
  const meRes = await fetch('/api/me');
  if (meRes.status === 401) return (location.href = '/login.html');
  const me = await meRes.json();
  userEmailEl.textContent = me.email;
  adminLink.hidden = !me.isAdmin;
  modeSelect.value = me.settings?.performanceMode || 'standard';
  document.documentElement.setAttribute('data-theme', me.settings?.theme || 'light');

  const conversations = await renderProjectList();
  if (conversations.length === 0) {
    await createNewProject();
  } else {
    await openConversation(conversations[0].id);
  }
}

init();
