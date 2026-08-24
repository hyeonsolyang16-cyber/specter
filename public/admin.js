const content = document.getElementById('admin-content');
const logoutBtn = document.getElementById('logout-btn');

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

function formatTime(iso) {
  return new Date(iso).toLocaleString('ko-KR');
}

// 이메일/제목처럼 사용자가 직접 입력한 값은 절대 innerHTML로 넣지 않는다.
// (관리자 화면에 그대로 렌더링되면 저장형 XSS로 이어질 수 있다.) 항상 textContent만 사용한다.
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderUsageTrend(trend) {
  const section = el('section', 'admin-user');
  const header = el('div', 'admin-user-header');
  header.appendChild(el('strong', null, '최근 14일 토큰 사용 추이'));
  section.appendChild(header);

  if (trend.length === 0) {
    section.appendChild(el('p', 'admin-empty', '아직 데이터가 없습니다.'));
    return section;
  }

  const max = Math.max(...trend.map((d) => d.tokens), 1);
  const chart = el('div', 'usage-trend-chart');
  for (const d of trend) {
    const col = el('div', 'usage-trend-col');
    const bar = el('div', 'usage-trend-bar');
    bar.style.height = `${Math.max((d.tokens / max) * 100, 2)}%`;
    bar.title = `${new Date(d.day).toLocaleDateString('ko-KR')}: ${d.tokens.toLocaleString('ko-KR')} 토큰`;
    col.appendChild(bar);
    col.appendChild(el('span', 'usage-trend-label', new Date(d.day).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })));
    chart.appendChild(col);
  }
  section.appendChild(chart);
  return section;
}

function renderUsageTable(usage) {
  const section = el('section', 'admin-user');

  const header = el('div', 'admin-user-header');
  header.appendChild(el('strong', null, '사용량 요약'));
  header.appendChild(el('span', null, '전체 유저의 누적 토큰 사용량입니다'));
  section.appendChild(header);

  if (usage.length === 0) {
    section.appendChild(el('p', 'admin-empty', '아직 사용 기록이 없습니다.'));
    return section;
  }

  const table = document.createElement('table');
  table.className = 'admin-usage-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['이메일', '프로젝트 수', '누적 토큰 사용량'].forEach((t) => headRow.appendChild(el('th', null, t)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const u of usage) {
    const row = document.createElement('tr');
    row.appendChild(el('td', null, u.email));
    row.appendChild(el('td', null, String(u.conversationCount)));
    row.appendChild(el('td', null, u.totalTokens.toLocaleString('ko-KR')));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function renderTemplates(templates) {
  const section = el('section', 'admin-user');
  const header = el('div', 'admin-user-header');
  header.appendChild(el('strong', null, '프롬프트 템플릿 관리'));
  header.appendChild(el('span', null, '모든 사용자가 입력창에서 바로 불러올 수 있는 공용 템플릿입니다'));
  section.appendChild(header);

  const form = document.createElement('form');
  form.className = 'settings-form';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = '템플릿 제목';
  titleInput.maxLength = 100;
  titleInput.required = true;
  const contentInput = document.createElement('textarea');
  contentInput.placeholder = '템플릿 내용 (입력창에 그대로 채워집니다)';
  contentInput.rows = 3;
  contentInput.maxLength = 4000;
  contentInput.required = true;
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = '템플릿 추가';
  form.appendChild(titleInput);
  form.appendChild(contentInput);
  form.appendChild(submitBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/admin/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titleInput.value, content: contentInput.value }),
    });
    if (res.ok) load();
  });
  section.appendChild(form);

  if (templates.length === 0) {
    section.appendChild(el('p', 'admin-empty', '아직 등록된 템플릿이 없습니다.'));
    return section;
  }

  const list = el('div', 'admin-turns');
  for (const t of templates) {
    const item = el('div', 'admin-turn model');
    item.appendChild(el('span', 'admin-turn-meta', t.title));
    item.appendChild(el('div', 'admin-turn-body', t.content));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'project-category-edit';
    delBtn.textContent = '✕';
    delBtn.title = '삭제';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`"${t.title}" 템플릿을 삭제할까요?`)) return;
      await fetch(`/api/admin/templates/${t.id}`, { method: 'DELETE' });
      load();
    });
    item.appendChild(delBtn);
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

function renderAlerts(alerts) {
  if (alerts.length === 0) return null;
  const section = el('section', 'admin-user admin-alerts');
  const header = el('div', 'admin-user-header');
  header.appendChild(el('strong', null, `⚠ 시스템 알림 (${alerts.length})`));
  header.appendChild(el('span', null, '모델 장애·API 오류 등 자동 감지된 문제입니다'));
  section.appendChild(header);
  const list = el('div', 'admin-turns');
  for (const a of alerts) {
    const item = el('div', 'admin-turn model');
    item.appendChild(el('span', 'admin-turn-meta', formatTime(a.at)));
    item.appendChild(el('div', 'admin-turn-body', a.message));
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

const AUDIT_ACTION_LABELS = {
  password_changed: '비밀번호 변경',
  conversation_shared: '프로젝트 공유',
  conversation_unshared: '프로젝트 공유 해제',
  conversation_permanently_deleted: '프로젝트 영구 삭제',
  template_created: '템플릿 생성',
  template_deleted: '템플릿 삭제',
};

function renderAuditLog(entries) {
  const section = el('section', 'admin-user');
  const header = el('div', 'admin-user-header');
  header.appendChild(el('strong', null, '감사 로그'));
  header.appendChild(el('span', null, '공유·영구 삭제·템플릿 관리·비밀번호 변경처럼 민감하거나 되돌리기 어려운 조작 기록입니다'));
  section.appendChild(header);

  if (entries.length === 0) {
    section.appendChild(el('p', 'admin-empty', '아직 기록이 없습니다.'));
    return section;
  }

  const list = el('div', 'admin-turns');
  for (const a of entries) {
    const item = el('div', 'admin-turn user');
    const label = AUDIT_ACTION_LABELS[a.action] || a.action;
    item.appendChild(el('span', 'admin-turn-meta', `${a.actor_email || '(알 수 없음)'} · ${label} · ${formatTime(a.at)}`));
    if (a.detail) item.appendChild(el('div', 'admin-turn-body', a.detail));
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

async function load() {
  const [convRes, usageRes, alertsRes, trendRes, templatesRes, auditRes] = await Promise.all([
    fetch('/api/admin/conversations'),
    fetch('/api/admin/usage'),
    fetch('/api/admin/alerts'),
    fetch('/api/admin/usage-trend'),
    fetch('/api/templates'),
    fetch('/api/admin/audit-log'),
  ]);
  if (convRes.status === 401) return (location.href = '/login.html');
  if (convRes.status === 403) return (location.href = '/');
  const users = await convRes.json();
  const usage = usageRes.ok ? await usageRes.json() : [];
  const alerts = alertsRes.ok ? await alertsRes.json() : [];
  const trend = trendRes.ok ? await trendRes.json() : [];
  const templates = templatesRes.ok ? await templatesRes.json() : [];
  const audit = auditRes.ok ? await auditRes.json() : [];

  content.innerHTML = '';
  const alertsSection = renderAlerts(alerts);
  if (alertsSection) content.appendChild(alertsSection);
  content.appendChild(renderTemplates(templates));
  content.appendChild(renderUsageTrend(trend));
  content.appendChild(renderUsageTable(usage));
  content.appendChild(renderAuditLog(audit));

  if (users.length === 0) {
    content.appendChild(el('p', 'admin-empty', '아직 가입한 사용자가 없습니다.'));
    return;
  }

  for (const u of users) {
    const totalTurns = u.conversations.reduce((sum, c) => sum + c.turns.length, 0);

    const section = el('section', 'admin-user');

    const header = el('div', 'admin-user-header');
    header.appendChild(el('strong', null, u.email));
    header.appendChild(
      el('span', null, `가입일 ${formatTime(u.createdAt)} · 프로젝트 ${u.conversations.length}개 · 메시지 ${totalTurns}개`)
    );
    section.appendChild(header);

    if (u.conversations.length === 0) {
      section.appendChild(el('p', 'admin-empty', '아직 생성한 프로젝트가 없습니다.'));
    }

    for (const c of u.conversations) {
      const project = el('div', 'admin-project');

      const projectHeader = el('div', 'admin-project-header');
      projectHeader.appendChild(el('span', null, c.title));
      projectHeader.appendChild(el('span', 'admin-project-meta', `${formatTime(c.createdAt)} · ${c.turns.length}개 메시지`));
      project.appendChild(projectHeader);

      if (c.turns.length === 0) {
        project.appendChild(el('p', 'admin-empty', '아직 대화 기록이 없습니다.'));
      } else {
        const list = el('div', 'admin-turns');
        for (const t of c.turns) {
          const turn = el('div', `admin-turn ${t.role}`);
          turn.appendChild(el('span', 'admin-turn-meta', `${t.role === 'user' ? '사용자' : 'Specter'} · ${formatTime(t.at)}`));
          turn.appendChild(el('div', 'admin-turn-body', t.content));
          list.appendChild(turn);
        }
        project.appendChild(list);
      }

      section.appendChild(project);
    }

    content.appendChild(section);
  }
}

load();
