const content = document.getElementById('admin-content');
const logoutBtn = document.getElementById('logout-btn');

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

function formatTime(iso) {
  return new Date(iso).toLocaleString('ko-KR');
}

function renderUsageTable(usage) {
  const section = document.createElement('section');
  section.className = 'admin-user';

  const header = document.createElement('div');
  header.className = 'admin-user-header';
  header.innerHTML = '<strong>사용량 요약</strong><span>비공개 프로젝트의 토큰 사용량도 포함됩니다 (내용은 비공개)</span>';
  section.appendChild(header);

  if (usage.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'admin-empty';
    empty.textContent = '아직 사용 기록이 없습니다.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.className = 'admin-usage-table';
  table.innerHTML = `
    <thead><tr><th>이메일</th><th>프로젝트 수</th><th>누적 토큰 사용량</th></tr></thead>
    <tbody>${usage
      .map((u) => `<tr><td>${u.email}</td><td>${u.conversationCount}</td><td>${u.totalTokens.toLocaleString('ko-KR')}</td></tr>`)
      .join('')}</tbody>
  `;
  section.appendChild(table);
  return section;
}

async function load() {
  const [convRes, usageRes] = await Promise.all([fetch('/api/admin/conversations'), fetch('/api/admin/usage')]);
  if (convRes.status === 401) return (location.href = '/login.html');
  if (convRes.status === 403) return (location.href = '/');
  const users = await convRes.json();
  const usage = usageRes.ok ? await usageRes.json() : [];

  content.innerHTML = '';
  content.appendChild(renderUsageTable(usage));

  if (users.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'admin-empty';
    empty.textContent = '아직 가입한 사용자가 없습니다.';
    content.appendChild(empty);
    return;
  }

  for (const u of users) {
    const totalTurns = u.conversations.reduce((sum, c) => sum + c.turns.length, 0);

    const section = document.createElement('section');
    section.className = 'admin-user';

    const header = document.createElement('div');
    header.className = 'admin-user-header';
    header.innerHTML = `<strong>${u.email}</strong><span>가입일 ${formatTime(u.createdAt)} · 프로젝트 ${u.conversations.length}개 · 메시지 ${totalTurns}개</span>`;
    section.appendChild(header);

    if (u.conversations.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = '아직 생성한 프로젝트가 없습니다.';
      section.appendChild(empty);
    }

    for (const c of u.conversations) {
      const project = document.createElement('div');
      project.className = 'admin-project';

      const projectHeader = document.createElement('div');
      projectHeader.className = 'admin-project-header';
      projectHeader.innerHTML = `<span>${c.title}</span><span class="admin-project-meta">${formatTime(c.createdAt)} · ${c.turns.length}개 메시지</span>`;
      project.appendChild(projectHeader);

      if (c.turns.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'admin-empty';
        empty.textContent = '아직 대화 기록이 없습니다.';
        project.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'admin-turns';
        for (const t of c.turns) {
          const turn = document.createElement('div');
          turn.className = `admin-turn ${t.role}`;
          turn.innerHTML = `<span class="admin-turn-meta">${t.role === 'user' ? '사용자' : 'Specter'} · ${formatTime(t.at)}</span>`;
          const body = document.createElement('div');
          body.className = 'admin-turn-body';
          body.textContent = t.content;
          turn.appendChild(body);
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
