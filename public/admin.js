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

async function load() {
  const [convRes, usageRes, alertsRes] = await Promise.all([
    fetch('/api/admin/conversations'),
    fetch('/api/admin/usage'),
    fetch('/api/admin/alerts'),
  ]);
  if (convRes.status === 401) return (location.href = '/login.html');
  if (convRes.status === 403) return (location.href = '/');
  const users = await convRes.json();
  const usage = usageRes.ok ? await usageRes.json() : [];
  const alerts = alertsRes.ok ? await alertsRes.json() : [];

  content.innerHTML = '';
  const alertsSection = renderAlerts(alerts);
  if (alertsSection) content.appendChild(alertsSection);
  content.appendChild(renderUsageTable(usage));

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
