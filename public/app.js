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
const trashToggleBtn = document.getElementById('trash-toggle-btn');
const exportBtn = document.getElementById('export-btn');
const exportMenu = document.getElementById('export-menu');
const moreMenuBtn = document.getElementById('more-menu-btn');
const moreMenu = document.getElementById('more-menu');
const googleConnectBanner = document.getElementById('google-connect-banner');
const googleConnectDismiss = document.getElementById('google-connect-dismiss');
const usageDisplay = document.getElementById('usage-display');
const sharedToggleBtn = document.getElementById('shared-toggle-btn');
const chatHeaderTitle = document.getElementById('chat-header-title');
const chatHeaderReadonly = document.getElementById('chat-header-readonly');
const projectSettingsBtn = document.getElementById('project-settings-btn');
const projectModal = document.getElementById('project-modal');
const projectModalClose = document.getElementById('project-modal-close');
const personaSelect = document.getElementById('persona-select');
const instructionsInput = document.getElementById('instructions-input');
const instructionsSaveBtn = document.getElementById('instructions-save-btn');
const instructionsSuccess = document.getElementById('instructions-success');
const knowledgeList = document.getElementById('knowledge-list');
const knowledgeFileInput = document.getElementById('knowledge-file-input');
const knowledgeUploadBtn = document.getElementById('knowledge-upload-btn');
const shareEmailInput = document.getElementById('share-email-input');
const shareBtn = document.getElementById('share-btn');
const shareList = document.getElementById('share-list');
const templateBtn = document.getElementById('template-btn');
const templateMenu = document.getElementById('template-menu');
const intensityToggle = document.getElementById('intensity-toggle');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const memoryQuickBtn = document.getElementById('memory-quick-btn');
const memoryModal = document.getElementById('memory-modal');
const memoryModalClose = document.getElementById('memory-modal-close');
const memoryInput = document.getElementById('memory-input');
const autoMemoryToggle = document.getElementById('auto-memory-toggle');
const memorySaveBtn = document.getElementById('memory-save-btn');
const memorySuccess = document.getElementById('memory-success');

let isReadOnlyConversation = false;
let personaOptionsCache = null;

async function saveSetting(key, value) {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
}

function markActiveBtn(container, value) {
  for (const btn of container.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.value === value);
  }
}

intensityToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  markActiveBtn(intensityToggle, btn.dataset.value);
  saveSetting('pushbackIntensity', btn.dataset.value);
});

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? '라이트 모드' : '다크 모드';
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveSetting('theme', next);
});

const MAX_MEMORY_LENGTH = 2000;
memoryQuickBtn.addEventListener('click', async () => {
  const res = await fetch('/api/settings');
  const settings = res.ok ? await res.json() : {};
  memoryInput.value = settings.memory || '';
  autoMemoryToggle.checked = !!settings.autoMemory;
  memorySuccess.textContent = '';
  memoryModal.hidden = false;
});
memoryModalClose.addEventListener('click', () => (memoryModal.hidden = true));
memoryModal.addEventListener('click', (e) => {
  if (e.target === memoryModal) memoryModal.hidden = true;
});
memorySaveBtn.addEventListener('click', async () => {
  if (memoryInput.value.length > MAX_MEMORY_LENGTH) {
    alert(`메모리는 ${MAX_MEMORY_LENGTH}자 이하로 입력하세요.`);
    return;
  }
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memory: memoryInput.value, autoMemory: autoMemoryToggle.checked }),
  });
  memorySuccess.textContent = '저장되었습니다.';
  setTimeout(() => (memorySuccess.textContent = ''), 2000);
});

function safeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, '_');
}

const EXPORT_ROLE_LABEL = { user: '사용자', model: 'Specter' };

async function exportAsMarkdown(conversation) {
  const lines = [`# ${conversation.title}`, ''];
  for (const t of conversation.turns) {
    lines.push(`## ${EXPORT_ROLE_LABEL[t.role] || t.role}`);
    lines.push('');
    lines.push(t.content || '');
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(conversation.title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportAsDocx(conversation) {
  const res = await fetch(`/api/conversations/${conversation.id}/export/docx`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename(conversation.title)}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 별도 서버 PDF 라이브러리 없이, 브라우저 자체 인쇄 기능(다른 이름으로 저장 → PDF)을 이용한다.
// pdfkit 같은 라이브러리의 기본 폰트는 한글을 지원하지 않아 직접 폰트를 심어야 하는데,
// 브라우저 인쇄는 이미 화면에 쓰는 폰트를 그대로 써서 한글 문제가 아예 없다.
function exportAsPdf(conversation) {
  const win = window.open('', '_blank');
  if (!win) {
    alert('팝업이 차단되었습니다. 브라우저의 팝업 차단을 해제한 뒤 다시 시도해주세요.');
    return;
  }
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = conversation.turns
    .map(
      (t) =>
        `<div class="turn"><div class="role">${EXPORT_ROLE_LABEL[t.role] || t.role}</div><div class="content">${esc(
          t.content || ''
        )}</div></div>`
    )
    .join('\n');
  win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
    <title>${esc(conversation.title)}</title>
    <style>
      body { font-family: -apple-system, "Malgun Gothic", sans-serif; padding: 32px; color: #222; white-space: pre-wrap; }
      h1 { font-size: 20px; margin-bottom: 24px; }
      .turn { margin-bottom: 18px; }
      .role { font-weight: 700; font-size: 12px; color: #588157; margin-bottom: 4px; }
      .content { font-size: 13.5px; line-height: 1.6; }
    </style>
    </head><body><h1>${esc(conversation.title)}</h1>${body}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

exportBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!currentConversationId) return;
  if (!exportMenu.hidden) {
    exportMenu.hidden = true;
    return;
  }
  const res = await fetch(`/api/conversations/${currentConversationId}`);
  if (!res.ok) return;
  const conversation = await res.json();

  exportMenu.innerHTML = '';
  const options = [
    ['마크다운(.md)', () => exportAsMarkdown(conversation)],
    ['Word(.docx)', () => exportAsDocx(conversation)],
    ['PDF (인쇄 대화상자)', () => exportAsPdf(conversation)],
  ];
  for (const [label, handler] of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-menu-item';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      handler();
      exportMenu.hidden = true;
    });
    exportMenu.appendChild(btn);
  }
  const rect = exportBtn.getBoundingClientRect();
  exportMenu.style.left = `${Math.max(8, rect.left)}px`;
  exportMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  exportMenu.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== exportBtn) {
    exportMenu.hidden = true;
  }
});

// 사이드바 하단에 텍스트 링크가 너무 많이 늘어서(설정/관리자/내보내기/공유받음/휴지통/로그아웃)
// 자주 안 쓰는 것들은 "더보기" 메뉴 뒤로 몰아둔다.
moreMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!moreMenu.hidden) {
    moreMenu.hidden = true;
    return;
  }
  const rect = moreMenuBtn.getBoundingClientRect();
  moreMenu.style.left = `${Math.max(8, rect.left)}px`;
  moreMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  moreMenu.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreMenuBtn) {
    moreMenu.hidden = true;
  }
});
moreMenu.addEventListener('click', (e) => {
  if (e.target.closest('.template-menu-item')) moreMenu.hidden = true;
});

let showingTrash = false;
let showingShared = false;

async function refreshSidebarList() {
  if (showingTrash) return renderTrash();
  if (showingShared) return renderSharedList();
  return renderProjectList();
}

trashToggleBtn.addEventListener('click', async () => {
  showingTrash = !showingTrash;
  showingShared = false;
  sharedToggleBtn.textContent = '공유받음';
  trashToggleBtn.textContent = showingTrash ? '목록으로' : '휴지통';
  newProjectBtn.hidden = showingTrash;
  searchInput.hidden = showingTrash;
  await refreshSidebarList();
});

sharedToggleBtn.addEventListener('click', async () => {
  showingShared = !showingShared;
  showingTrash = false;
  trashToggleBtn.textContent = '휴지통';
  sharedToggleBtn.textContent = showingShared ? '목록으로' : '공유받음';
  newProjectBtn.hidden = showingShared;
  searchInput.hidden = showingShared;
  await refreshSidebarList();
});

async function renderSharedList() {
  const res = await fetch('/api/shared-with-me');
  if (res.status === 401) return (location.href = '/login.html');
  const items = await res.json();
  projectList.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'project-category';
    empty.textContent = '아직 공유받은 프로젝트가 없습니다.';
    projectList.appendChild(empty);
    return;
  }
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'project-row';
    const item = document.createElement('button');
    item.className = `project-item${c.id === currentConversationId ? ' active' : ''}`;
    item.textContent = `${c.title} (${c.ownerEmail})`;
    item.addEventListener('click', () => {
      openConversation(c.id);
      closeSidebar();
    });
    row.appendChild(item);
    projectList.appendChild(row);
  }
}

async function renderTrash() {
  const res = await fetch('/api/trash');
  if (res.status === 401) return (location.href = '/login.html');
  const items = await res.json();
  projectList.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'project-category';
    empty.textContent = '휴지통이 비어있습니다.';
    projectList.appendChild(empty);
    return;
  }
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'project-row';
    const label = document.createElement('span');
    label.className = 'project-item';
    label.textContent = c.title;
    row.appendChild(label);

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'project-category-edit';
    restoreBtn.title = '복원';
    restoreBtn.textContent = '↺';
    restoreBtn.addEventListener('click', async () => {
      await fetch(`/api/trash/${c.id}/restore`, { method: 'POST' });
      renderTrash();
    });
    row.appendChild(restoreBtn);

    const purgeBtn = document.createElement('button');
    purgeBtn.className = 'project-category-edit';
    purgeBtn.title = '영구 삭제';
    purgeBtn.textContent = '✕';
    purgeBtn.addEventListener('click', async () => {
      if (!confirm(`"${c.title}"을(를) 영구 삭제할까요? 되돌릴 수 없습니다.`)) return;
      await fetch(`/api/trash/${c.id}`, { method: 'DELETE' });
      renderTrash();
    });
    row.appendChild(purgeBtn);

    projectList.appendChild(row);
  }
}
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
  if (e.key === 'Escape') {
    if (!projectModal.hidden) return void (projectModal.hidden = true);
    if (!memoryModal.hidden) return void (memoryModal.hidden = true);
    if (!templateMenu.hidden) return void (templateMenu.hidden = true);
    if (!exportMenu.hidden) return void (exportMenu.hidden = true);
    if (!moreMenu.hidden) return void (moreMenu.hidden = true);
    return;
  }
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

let searchDebounceTimer = null;
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(performSearch, 300);
});

// 제목뿐 아니라 대화 내용까지 서버에서 검색한다.
async function performSearch() {
  if (!searchQuery) {
    await renderProjectList();
    return;
  }
  const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(searchQuery)}`);
  if (res.status === 401) return (location.href = '/login.html');
  allConversationsCache = await res.json();
  renderProjectListFromCache();
}

attachBtn.addEventListener('click', () => fileInput.click());

const OFFICE_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
];

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      alert(`첨부파일은 최대 ${MAX_ATTACHMENTS}개까지 가능합니다.`);
      break;
    }
    const mimeType = resolveFileMimeType(file);
    const isImage = mimeType.startsWith('image/');
    const isPdf = mimeType === 'application/pdf';
    const isOffice = OFFICE_MIME_TYPES.includes(mimeType);
    if (!isImage && !isPdf && !isOffice) {
      alert(`${file.name}은(는) 지원하지 않는 형식입니다. 이미지, PDF, Excel, Word, CSV만 첨부할 수 있습니다.`);
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
      mimeType,
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

  // 홈 화면 "음성으로 물어보기" 바로가기(/?voice=1)로 들어오면 마이크를 바로 켠다.
  // 브라우저에 따라 자동 시작이 제스처 요구로 막힐 수 있어 실패해도 조용히 넘어간다.
  if (new URLSearchParams(location.search).get('voice') === '1') {
    try {
      recognition.start();
    } catch {}
    history.replaceState(null, '', location.pathname);
  }
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

// GFM 스타일 파이프 표(| a | b |\n| --- | --- |\n| c | d |)만 <table>로 바꾸고, 나머지는
// 원래대로 평문(줄바꿈만 유지)으로 둔다. 볼드 등 다른 마크다운은 시스템 프롬프트에서 계속 금지한다.
// 셀 내용은 모두 textContent로만 넣어 innerHTML을 쓰지 않으므로 XSS 위험이 없다.
function isTableSeparatorRow(line) {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}
function splitTableRow(line) {
  let cells = line.trim();
  if (cells.startsWith('|')) cells = cells.slice(1);
  if (cells.endsWith('|')) cells = cells.slice(0, -1);
  return cells.split('|').map((c) => c.trim());
}
function buildTableElement(tableLines) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-table-wrap';
  const table = document.createElement('table');
  table.className = 'msg-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const c of splitTableRow(tableLines[0])) {
    const th = document.createElement('th');
    th.textContent = c;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (let i = 2; i < tableLines.length; i++) {
    const row = document.createElement('tr');
    for (const c of splitTableRow(tableLines[i])) {
      const td = document.createElement('td');
      td.textContent = c;
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}
// allowTables는 Specter 응답에만 켠다 — 시스템 프롬프트도 표 문법을 Specter에게만 허용하고,
// 사용자가 입력한 텍스트(터미널 출력, URL 등 파이프가 우연히 들어간 경우)까지 표로 잘못
// 재구성되면 사용자가 실제로 입력한 내용과 화면이 달라져 혼란을 줄 수 있다.
function renderMessageBody(body, text, allowTables = true) {
  body.dataset.rawText = text;
  body.innerHTML = '';
  if (!allowTables) {
    body.textContent = text;
    return;
  }
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        tableLines.push(lines[j]);
        j++;
      }
      body.appendChild(buildTableElement(tableLines));
      i = j;
    } else {
      let j = i;
      const plain = [];
      while (j < lines.length && !(lines[j].includes('|') && j + 1 < lines.length && isTableSeparatorRow(lines[j + 1]))) {
        plain.push(lines[j]);
        j++;
      }
      if (plain.some((l) => l !== '')) {
        const span = document.createElement('span');
        span.textContent = plain.join('\n');
        body.appendChild(span);
      }
      i = j;
    }
  }
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// PDF는 새 탭에서 바로 열어 보여주고, 브라우저가 못 읽는 형식(Excel/Word 등)은 원본 파일을 내려받게 한다.
function openOrDownloadAttachment(a) {
  const blob = base64ToBlob(a.data, a.mimeType);
  const url = URL.createObjectURL(blob);
  if (a.mimeType === 'application/pdf') {
    const win = window.open(url, '_blank');
    if (!win) alert('팝업이 차단되었습니다. 브라우저의 팝업 차단을 해제한 뒤 다시 시도해주세요.');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } else {
    const link = document.createElement('a');
    link.href = url;
    link.download = a.name || '첨부파일';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
}

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
  renderMessageBody(body, text, role === 'specter');
  el.appendChild(body);

  if (Array.isArray(opts.attachments)) {
    for (const a of opts.attachments) {
      if (a.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = `data:${a.mimeType};base64,${a.data}`;
        img.alt = '첨부 이미지';
        el.appendChild(img);
      } else if (a.data) {
        const isPdf = a.mimeType === 'application/pdf';
        const fileChip = document.createElement('button');
        fileChip.type = 'button';
        fileChip.className = 'msg-file-chip';
        fileChip.textContent = `📄 ${a.name || '문서'}${isPdf ? '' : ' ⬇'}`;
        fileChip.title = isPdf ? '새 탭에서 열기' : '다운로드';
        fileChip.addEventListener('click', () => openOrDownloadAttachment(a));
        el.appendChild(fileChip);
      } else {
        // 지식 베이스 등 원본 바이트가 없는 경우(예: 이미 텍스트로 추출된 첨부)는 이름만 보여준다.
        // 클릭해도 아무 반응이 없으므로 클릭 가능한 것처럼 보이는 hover/cursor 스타일은 주지 않는다.
        const fileChip = document.createElement('span');
        fileChip.className = 'msg-file-chip msg-file-chip-static';
        fileChip.textContent = `📄 ${a.name || '문서'}`;
        el.appendChild(fileChip);
      }
    }
  }

  if (role === 'user' && !opts.error && !opts.readOnly) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.title = '수정';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => editMessage(el, text));
    el.appendChild(editBtn);
  }
  if (role === 'specter' && !opts.error) {
    decorateSpecterMessage(el, body, opts.readOnly);
  }
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

const TIER_LABELS = { lite: 'Lite', standard: 'Standard', high: 'High', max: 'Max' };
function addTierBadge(el, tier) {
  if (el.querySelector('.tier-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'tier-badge';
  badge.textContent = TIER_LABELS[tier] || tier;
  badge.title = '이 답변에 사용된 성능 모드';
  const label = el.querySelector('.label');
  if (label) label.appendChild(badge);
  else el.insertBefore(badge, el.firstChild);
}

function decorateSpecterMessage(el, body, readOnly) {
  if (!readOnly && !el.querySelector('.regen-btn')) {
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
      await navigator.clipboard.writeText(body.dataset.rawText ?? body.textContent);
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
    speakBtn.addEventListener('click', () => speakText(body.dataset.rawText ?? body.textContent, speakBtn));
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
  // 검색어가 있으면 allConversationsCache는 이미 서버에서 제목+내용 기준으로 필터링된 결과다.
  const conversations = allConversationsCache;

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

// 홈 화면 위젯은 PWA로는 만들 수 없어서(iOS/Android 둘 다 네이티브 전용 기능), 그 대신
// 앱을 열면 바로 오늘 일정+할 일이 보이게 한다. 구글 연동을 안 했거나 오늘 항목이
// 없으면 카드 자체를 안 보여준다.
async function renderTodayCard(container) {
  const res = await fetch('/api/today');
  if (!res.ok) return;
  const data = await res.json();
  if (!data.connected || (data.events.length === 0 && data.tasks.length === 0)) return;

  const card = document.createElement('div');
  card.className = 'today-card';
  card.appendChild(el2('div', 'today-card-title', '오늘'));

  for (const e of data.events) {
    const row = el2('div', 'today-row');
    const time = e.start?.includes('T')
      ? new Date(e.start).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })
      : '종일';
    row.appendChild(el2('span', 'today-row-time', time));
    row.appendChild(el2('span', 'today-row-label', e.title));
    card.appendChild(row);
  }
  for (const t of data.tasks) {
    const row = el2('div', 'today-row today-row-task');
    row.appendChild(el2('span', 'today-row-time', '할 일'));
    row.appendChild(el2('span', 'today-row-label', t.title));
    card.appendChild(row);
  }
  container.prepend(card);
}

function el2(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 앱 아이콘에 오늘 남은 일정+할 일 개수를 배지로 표시한다(Badging API — Android는 대부분
// 지원, iOS는 홈 화면에 설치된 경우에만 동작). 지원 안 하는 브라우저에서는 조용히 무시된다.
async function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  try {
    const res = await fetch('/api/today');
    if (!res.ok) return;
    const data = await res.json();
    const count = (data.events?.length || 0) + (data.tasks?.length || 0);
    if (count > 0) navigator.setAppBadge(count);
    else navigator.clearAppBadge();
  } catch {}
}

function renderEmptyState() {
  chat.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <img src="logo.png" alt="Specter">
    <h2>무엇을 검토해드릴까요?</h2>
  `;
  renderTodayCard(wrap);
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

  if (!localStorage.getItem('specter_seen_tips')) {
    const tips = document.createElement('div');
    tips.className = 'onboarding-tips';
    tips.innerHTML = `
      <b>알아두면 좋은 기능</b>
      <ul>
        <li>입력창 아래에서 <b>성능 모드</b>(Lite~Max, 자동)와 <b>판단 강도</b>를 바꿀 수 있습니다</li>
        <li>사이드바 하단 <b>메모리</b>에 적어두면 모든 대화에서 항상 참고합니다</li>
        <li>프로젝트 우측 상단 ⚙ 버튼에서 <b>역할·지침·참고자료·공유</b>를 프로젝트별로 설정할 수 있습니다</li>
        <li><b>설정 → 연동</b>에서 구글 계정을 연결하면 채팅으로 일정·메일 발송·할 일까지 처리할 수 있습니다</li>
        <li>입력창 옆 마이크 아이콘으로 음성 입력이 가능합니다</li>
      </ul>
    `;
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'empty-prompt-btn';
    dismissBtn.textContent = '확인했어요';
    dismissBtn.addEventListener('click', () => {
      localStorage.setItem('specter_seen_tips', '1');
      tips.remove();
    });
    tips.appendChild(dismissBtn);
    wrap.appendChild(tips);
  }

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

// 대화의 마지막 응답을 재생성할 때는 기존 답변을 지우지 않고 브랜치(대안)로 보관한다(서버가 자동 판단).
// 마지막이 아닌 중간 메시지를 재생성할 때는 예전처럼 그 이후를 모두 지우고 새로 받는다.
async function regenerateFrom(msgEl) {
  if (!currentConversationId || sendBtn.type === 'button') return;
  const allMsgs = Array.from(chat.querySelectorAll('.msg:not(.error)'));
  const isLast = allMsgs[allMsgs.length - 1] === msgEl;

  if (!isLast) {
    const idx = await rewindTo(msgEl);
    if (idx === -1) return;
  }

  setGenerating(true);
  const pending = addPendingMessage();
  activeAbortController = new AbortController();
  const draftText = input.value; // 실패해도(예: 일일 한도 초과) 입력 중이던 초안은 그대로 둔다

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
  // 429 등으로 요청이 거부된 경우(res.ok===false)는 서버가 이전 답변을 그대로 보존하므로
  // 화면에서도 지우지 않는다 — 성공해서 진짜로 브랜치 처리된 경우에만 이전 답변을 치운다.
  if (isLast && res.ok) msgEl.remove();
  await handleChatResponse(res, pending, draftText);
  if (isLast && res.ok) attachLatestBranchNav(pending);
}

// 재생성 직후 마지막 턴에 브랜치가 생겼는지 서버에서 다시 확인해 네비게이터를 붙인다.
async function attachLatestBranchNav(msgEl) {
  const res = await fetch(`/api/conversations/${currentConversationId}`);
  if (!res.ok) return;
  const conversation = await res.json();
  const lastTurn = conversation.turns[conversation.turns.length - 1];
  if (lastTurn?.branchGroup) buildBranchNav(msgEl, lastTurn.branchGroup);
}

async function buildBranchNav(msgEl, branchGroup) {
  const res = await fetch(`/api/conversations/${currentConversationId}/branches/${branchGroup}`);
  if (!res.ok) return;
  const branches = await res.json();
  if (branches.length <= 1) return;
  renderBranchNav(msgEl, branchGroup, branches);
}

function renderBranchNav(msgEl, branchGroup, branches) {
  let nav = msgEl.querySelector('.branch-nav');
  if (!nav) {
    nav = document.createElement('span');
    nav.className = 'branch-nav';
    msgEl.appendChild(nav);
  }
  const idx = branches.findIndex((b) => b.isActive);
  nav.innerHTML = '';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.textContent = '‹';
  prevBtn.disabled = idx <= 0;
  prevBtn.addEventListener('click', () => switchBranch(msgEl, branchGroup, branches, idx - 1));
  const label = document.createElement('span');
  label.textContent = `${idx + 1}/${branches.length}`;
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.textContent = '›';
  nextBtn.disabled = idx >= branches.length - 1;
  nextBtn.addEventListener('click', () => switchBranch(msgEl, branchGroup, branches, idx + 1));
  nav.appendChild(prevBtn);
  nav.appendChild(label);
  nav.appendChild(nextBtn);
}

async function switchBranch(msgEl, branchGroup, branches, newIdx) {
  const target = branches[newIdx];
  if (!target || isReadOnlyConversation) return;
  await fetch(`/api/conversations/${currentConversationId}/branches/${branchGroup}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: target.id }),
  });
  const body = msgEl.querySelector('.msg-body');
  renderMessageBody(body, target.content);
  const updated = branches.map((b, i) => ({ ...b, isActive: i === newIdx }));
  renderBranchNav(msgEl, branchGroup, updated);
}

async function handleChatResponse(res, pending, restoreText) {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    pending.remove();
    if (res.status === 401) return void (location.href = '/login.html');
    if (data.kind === 'rate_limit') {
      const el = addMessage('specter', '', { error: true });
      if (data.daily) {
        // 일일 할당량은 초 단위로 카운트다운해봐야 다시 시도해도 또 실패한다 — 대신 그대로 안내만 하고
        // 입력창에 메시지를 복원해 나중에 다시 보낼 수 있게 한다.
        el.querySelector('.msg-body').textContent = data.error;
        setComposerDisabled(false);
        input.value = restoreText;
        input.dispatchEvent(new Event('input'));
        setGenerating(false);
        return;
      }
      startRateLimitCountdown(el, data.retryAfterSeconds || 30, restoreText);
      setGenerating(false);
      return;
    }
    addMessage('specter', data.error || '알 수 없는 오류가 발생했습니다.', { error: true });
    setGenerating(false);
    input.focus();
    return;
  }

  const tier = res.headers.get('X-Specter-Tier');
  if (tier) addTierBadge(pending, tier);

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
  else {
    renderMessageBody(body, body.textContent); // 스트리밍 중엔 평문으로만 쌓다가, 끝나면 표를 한 번에 파싱해 렌더링
    decorateSpecterMessage(pending, body);
  }

  activeAbortController = null;
  setGenerating(false);
  input.focus();
  refreshSidebarList(); // 첫 메시지 이후 제목이 바뀌므로 목록 갱신
  loadUsage();
}

async function openConversation(id) {
  currentConversationId = id;
  chat.innerHTML = '';
  const res = await fetch(`/api/conversations/${id}`);
  if (res.status === 401) return (location.href = '/login.html');
  if (!res.ok) return;
  const conversation = await res.json();
  isReadOnlyConversation = !!conversation.readOnly;
  chatHeaderTitle.textContent = conversation.title;
  chatHeaderReadonly.hidden = !isReadOnlyConversation;
  projectSettingsBtn.hidden = isReadOnlyConversation;
  if (conversation.turns.length === 0) {
    renderEmptyState();
  } else {
    for (const t of conversation.turns) {
      const msgEl = addMessage(t.role === 'user' ? 'user' : 'specter', t.content, {
        attachments: t.attachments || [],
        readOnly: isReadOnlyConversation,
      });
      if (t.role !== 'user' && t.branchGroup) buildBranchNav(msgEl, t.branchGroup);
    }
  }
  setComposerDisabled(isReadOnlyConversation);
  refreshSidebarList();
  if (!isReadOnlyConversation) input.focus();
}

// ---- 프로젝트 설정 모달(역할/지침/참고자료/공유) ----

async function loadPersonaOptions() {
  if (personaOptionsCache) return personaOptionsCache;
  const res = await fetch('/api/personas');
  personaOptionsCache = res.ok ? await res.json() : [];
  return personaOptionsCache;
}

async function openProjectModal() {
  if (!currentConversationId || isReadOnlyConversation) return;
  const [personas, convRes] = await Promise.all([
    loadPersonaOptions(),
    fetch(`/api/conversations/${currentConversationId}`),
  ]);
  const conversation = convRes.ok ? await convRes.json() : null;
  personaSelect.innerHTML = '';
  for (const p of personas) {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.label;
    personaSelect.appendChild(opt);
  }
  personaSelect.value = conversation?.persona || 'general';
  instructionsInput.value = conversation?.instructions || '';
  instructionsSuccess.textContent = '';
  await renderKnowledgeList();
  await renderShareList();
  projectModal.hidden = false;
}

function closeProjectModal() {
  projectModal.hidden = true;
}

projectSettingsBtn.addEventListener('click', openProjectModal);
projectModalClose.addEventListener('click', closeProjectModal);
projectModal.addEventListener('click', (e) => {
  if (e.target === projectModal) closeProjectModal();
});

personaSelect.addEventListener('change', async () => {
  if (!currentConversationId) return;
  await fetch(`/api/conversations/${currentConversationId}/persona`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: personaSelect.value }),
  });
});

instructionsSaveBtn.addEventListener('click', async () => {
  if (!currentConversationId) return;
  await fetch(`/api/conversations/${currentConversationId}/instructions`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: instructionsInput.value }),
  });
  instructionsSuccess.textContent = '저장되었습니다.';
  setTimeout(() => (instructionsSuccess.textContent = ''), 2000);
});

async function renderKnowledgeList() {
  const res = await fetch(`/api/conversations/${currentConversationId}/knowledge`);
  const files = res.ok ? await res.json() : [];
  knowledgeList.innerHTML = '';
  if (files.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-desc';
    empty.textContent = '아직 등록된 참고 자료가 없습니다.';
    knowledgeList.appendChild(empty);
    return;
  }
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'knowledge-file-row';
    const label = document.createElement('span');
    label.textContent = `📎 ${f.name}`;
    row.appendChild(label);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '✕';
    delBtn.title = '삭제';
    delBtn.addEventListener('click', async () => {
      await fetch(`/api/conversations/${currentConversationId}/knowledge/${f.id}`, { method: 'DELETE' });
      renderKnowledgeList();
    });
    row.appendChild(delBtn);
    knowledgeList.appendChild(row);
  }
}

const KNOWLEDGE_MAX_BYTES = 15 * 1024 * 1024;
const KNOWLEDGE_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
knowledgeUploadBtn.addEventListener('click', () => knowledgeFileInput.click());
knowledgeFileInput.addEventListener('change', async () => {
  const file = knowledgeFileInput.files?.[0];
  knowledgeFileInput.value = '';
  if (!file) return;
  const mimeType = resolveFileMimeType(file);
  if (!KNOWLEDGE_MIME_TYPES.includes(mimeType)) {
    alert('PDF, 텍스트, Excel(.xlsx), Word(.docx), CSV 파일만 등록할 수 있습니다.');
    return;
  }
  if (file.size > KNOWLEDGE_MAX_BYTES) {
    alert('파일은 15MB 이하만 가능합니다.');
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
  if (!match) return;
  const res = await fetch(`/api/conversations/${currentConversationId}/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mimeType, data: match[2] }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '업로드에 실패했습니다.');
    return;
  }
  renderKnowledgeList();
});

async function renderShareList() {
  const res = await fetch(`/api/conversations/${currentConversationId}/shares`);
  const shares = res.ok ? await res.json() : [];
  shareList.innerHTML = '';
  for (const s of shares) {
    const row = document.createElement('div');
    row.className = 'share-list-row';
    const label = document.createElement('span');
    label.textContent = s.email;
    row.appendChild(label);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.title = '공유 해제';
    removeBtn.addEventListener('click', async () => {
      await fetch(`/api/conversations/${currentConversationId}/share/${s.userId}`, { method: 'DELETE' });
      renderShareList();
    });
    row.appendChild(removeBtn);
    shareList.appendChild(row);
  }
}

shareBtn.addEventListener('click', async () => {
  const email = shareEmailInput.value.trim();
  if (!email) return;
  const res = await fetch(`/api/conversations/${currentConversationId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || '공유에 실패했습니다.');
    return;
  }
  shareEmailInput.value = '';
  renderShareList();
});

// ---- 파일 확장자로 브라우저가 mimeType을 비워 보내는 경우(csv 등) 보정 ----
function resolveFileMimeType(file) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return 'text/csv';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return '';
}

// ---- 프롬프트 템플릿 ----
let templatesCache = null;
templateBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!templateMenu.hidden) {
    templateMenu.hidden = true;
    return;
  }
  if (!templatesCache) {
    const res = await fetch('/api/templates');
    templatesCache = res.ok ? await res.json() : [];
  }
  templateMenu.innerHTML = '';
  if (templatesCache.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'template-menu-empty';
    empty.textContent = '관리자가 등록한 템플릿이 아직 없습니다.';
    templateMenu.appendChild(empty);
  } else {
    for (const t of templatesCache) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'template-menu-item';
      btn.textContent = t.title;
      btn.addEventListener('click', () => {
        input.value = t.content;
        input.dispatchEvent(new Event('input'));
        input.focus();
        templateMenu.hidden = true;
      });
      templateMenu.appendChild(btn);
    }
  }
  const rect = templateBtn.getBoundingClientRect();
  templateMenu.style.left = `${Math.max(8, rect.left)}px`;
  templateMenu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  templateMenu.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!templateMenu.hidden && !templateMenu.contains(e.target) && e.target !== templateBtn) {
    templateMenu.hidden = true;
  }
});

// ---- 본인 사용량 표시 ----
async function loadUsage() {
  const res = await fetch('/api/usage/me');
  if (!res.ok) return;
  const usage = await res.json();
  const ko = (n) => n.toLocaleString('ko-KR');
  let text = `누적 토큰 사용량: ${ko(usage.totalTokens)} · 최근 24시간 조직 전체: ${ko(usage.recentOrgTokens)}`;
  if (usage.dailyCap !== null && usage.dailyCap !== undefined) {
    text += ` (개인 한도 ${ko(usage.recentUserTokens)}/${ko(usage.dailyCap)})`;
  }
  usageDisplay.textContent = text;
  usageDisplay.title = 'Gemini 무료 할당량은 조직 전체가 하나의 계정으로 공유합니다.';
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

// 이메일/비밀번호로 가입한 사람은 로그인 단계에서 구글 동의를 같이 받을 방법이 없어서,
// 설정에 따로 들어가야만 연동을 찾을 수 있었다 — 대신 앱 상단에 바로 눈에 띄게 배너로
// 안내한다. "나중에"를 누르면 3일간 다시 안 보이게 하고, 아예 안 눌러도 매번 뜬다
// (귀찮게 하려는 게 아니라, 연동 안 한 상태를 계속 방치하지 않게 하려는 의도).
const GOOGLE_BANNER_SNOOZE_KEY = 'specter_google_banner_snoozed_until';
async function checkGoogleConnectBanner() {
  const snoozedUntil = Number(localStorage.getItem(GOOGLE_BANNER_SNOOZE_KEY) || 0);
  if (Date.now() < snoozedUntil) return;
  const res = await fetch('/api/calendar/status');
  if (!res.ok) return;
  const { connected } = await res.json();
  googleConnectBanner.hidden = connected;
}
googleConnectDismiss.addEventListener('click', () => {
  localStorage.setItem(GOOGLE_BANNER_SNOOZE_KEY, String(Date.now() + 3 * 24 * 60 * 60 * 1000));
  googleConnectBanner.hidden = true;
});

async function init() {
  const meRes = await fetch('/api/me');
  if (meRes.status === 401) return (location.href = '/login.html');
  const me = await meRes.json();
  userEmailEl.textContent = me.email;
  adminLink.hidden = !me.isAdmin;
  modeSelect.value = me.settings?.performanceMode || 'standard';
  applyTheme(me.settings?.theme || 'light');
  markActiveBtn(intensityToggle, me.settings?.pushbackIntensity || 'strong');
  checkGoogleConnectBanner();

  const conversations = await renderProjectList();
  if (conversations.length === 0) {
    await createNewProject();
  } else {
    await openConversation(conversations[0].id);
  }
  loadUsage();
  updateAppBadge();
}

init();
