const content = document.getElementById('admin-content');
const logoutBtn = document.getElementById('logout-btn');

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

function formatTime(iso) {
  return new Date(iso).toLocaleString('ko-KR');
}

async function load() {
  const res = await fetch('/api/admin/conversations');
  if (res.status === 401) return (location.href = '/login.html');
  if (res.status === 403) return (location.href = '/');
  const users = await res.json();

  content.innerHTML = '';
  if (users.length === 0) {
    content.textContent = '아직 가입한 사용자가 없습니다.';
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
