const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_SETTINGS = {
  performanceMode: 'standard',
  pushbackIntensity: 'strong',
  theme: 'light',
  memory: '',
  autoMemory: false,
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      settings JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '새 프로젝트',
      category TEXT NOT NULL DEFAULT '미분류',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS turns (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS attachments JSONB;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS tokens INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_refresh_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_token TEXT UNIQUE;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS notified_events (
      event_id TEXT PRIMARY KEY,
      notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 프로젝트별 지식 베이스(항상 참고하는 첨부 자료)
    CREATE TABLE IF NOT EXISTS knowledge_files (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 프로젝트별 커스텀 지침 + 역할(페르소나)
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS instructions TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS persona TEXT;
    -- 대화 브랜칭: 지우는 대신 비활성 처리해서 재생성/편집 이전 답변도 남겨둔다
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS branch_group INTEGER;
    -- 유저 간 대화 공유(읽기 전용)
    CREATE TABLE IF NOT EXISTS conversation_shares (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      shared_with_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, shared_with_user_id)
    );
    -- 관리자가 등록하는 공용 프롬프트 템플릿
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
const ready = init().catch((err) => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- 사용자 ----

async function findUserByEmail(email) {
  await ready;
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function findUserById(id) {
  await ready;
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    settings: row.settings,
    googleCalendarRefreshToken: row.google_calendar_refresh_token,
    apiToken: row.api_token,
  };
}

async function createUser(email, passwordHash) {
  await ready;
  const id = newId();
  const { rows } = await pool.query(
    'INSERT INTO users (id, email, password_hash, settings) VALUES ($1, $2, $3, $4) RETURNING *',
    [id, email, passwordHash, JSON.stringify(DEFAULT_SETTINGS)]
  );
  return rowToUser(rows[0]);
}

// Google 로그인: 이메일이 이미 있으면 그 계정에 연결하고, 없으면 새로 만든다.
async function findOrCreateGoogleUser(email, googleId) {
  await ready;
  const existing = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.rows[0]) {
    if (!existing.rows[0].google_id) {
      await pool.query('UPDATE users SET google_id = $2 WHERE id = $1', [existing.rows[0].id, googleId]);
    }
    return rowToUser(existing.rows[0]);
  }
  const id = newId();
  const { rows } = await pool.query(
    'INSERT INTO users (id, email, password_hash, google_id, settings) VALUES ($1, $2, NULL, $3, $4) RETURNING *',
    [id, email, googleId, JSON.stringify(DEFAULT_SETTINGS)]
  );
  return rowToUser(rows[0]);
}

async function getSettings(userId) {
  const user = await findUserById(userId);
  return { ...DEFAULT_SETTINGS, ...(user?.settings || {}) };
}

// JSONB의 || 병합 연산자로 DB에서 원자적으로 갱신한다. 이전에는 애플리케이션 레벨에서
// 읽고-병합해서-쓰는 방식이라, 같은 유저의 설정 두 개가 거의 동시에 저장되면(예: 메모리
// 내용 저장 + 자동 메모리 토글 저장을 Promise.all로 동시에 보낼 때) 나중에 쓰는 요청이
// 먼저 쓴 요청의 값을 못 보고 덮어써버리는 경합 조건이 있었다.
async function updateSettings(userId, patch) {
  await ready;
  const { rows } = await pool.query(
    "UPDATE users SET settings = settings || $2::jsonb WHERE id = $1 RETURNING settings",
    [userId, JSON.stringify(patch)]
  );
  return rows[0]?.settings;
}

async function updatePasswordHash(userId, passwordHash) {
  await ready;
  const { rowCount } = await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  return rowCount > 0;
}

// ---- 대화(프로젝트) ----

async function createConversation(userId, category) {
  await ready;
  const id = newId();
  const { rows } = await pool.query(
    'INSERT INTO conversations (id, user_id, category) VALUES ($1, $2, $3) RETURNING *',
    [id, userId, category || '미분류']
  );
  return { ...rowToConversation(rows[0]), turns: [] };
}

function rowToConversation(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    instructions: row.instructions,
    persona: row.persona,
  };
}

async function setConversationInstructions(userId, conversationId, instructions) {
  await ready;
  const { rows } = await pool.query(
    'UPDATE conversations SET instructions = $3 WHERE id = $2 AND user_id = $1 RETURNING *',
    [userId, conversationId, instructions || null]
  );
  return rows[0] ? rowToConversation(rows[0]) : null;
}

async function setConversationPersona(userId, conversationId, persona) {
  await ready;
  const { rows } = await pool.query('UPDATE conversations SET persona = $3 WHERE id = $2 AND user_id = $1 RETURNING *', [
    userId,
    conversationId,
    persona || null,
  ]);
  return rows[0] ? rowToConversation(rows[0]) : null;
}

async function listConversations(userId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(t.id)::int AS message_count
     FROM conversations c LEFT JOIN turns t ON t.conversation_id = c.id
     WHERE c.user_id = $1 AND c.deleted_at IS NULL
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...rowToConversation(r), messageCount: r.message_count }));
}

async function listTrash(userId) {
  await ready;
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    [userId]
  );
  return rows.map(rowToConversation);
}

async function restoreConversation(userId, conversationId) {
  await ready;
  const { rows } = await pool.query(
    'UPDATE conversations SET deleted_at = NULL WHERE id = $2 AND user_id = $1 AND deleted_at IS NOT NULL RETURNING *',
    [userId, conversationId]
  );
  return rows[0] ? rowToConversation(rows[0]) : null;
}

async function permanentlyDeleteConversation(userId, conversationId) {
  await ready;
  const { rowCount } = await pool.query(
    'DELETE FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL',
    [conversationId, userId]
  );
  return rowCount > 0;
}

// 제목뿐 아니라 대화 내용까지 검색한다.
async function searchConversations(userId, query) {
  await ready;
  const { rows } = await pool.query(
    `SELECT DISTINCT c.*, (SELECT COUNT(*)::int FROM turns t2 WHERE t2.conversation_id = c.id) AS message_count
     FROM conversations c
     LEFT JOIN turns t ON t.conversation_id = c.id
     WHERE c.user_id = $1 AND c.deleted_at IS NULL AND (c.title ILIKE $2 OR t.content ILIKE $2)
     ORDER BY c.created_at DESC`,
    [userId, `%${query}%`]
  );
  return rows.map((r) => ({ ...rowToConversation(r), messageCount: r.message_count }));
}

async function getConversation(userId, conversationId) {
  await ready;
  const convRes = await pool.query(
    'SELECT * FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [conversationId, userId]
  );
  if (!convRes.rows[0]) return null;
  const turnsRes = await pool.query(
    'SELECT id, role, content, attachments, at, branch_group AS "branchGroup" FROM turns WHERE conversation_id = $1 AND is_active = true ORDER BY at ASC',
    [conversationId]
  );
  return { ...rowToConversation(convRes.rows[0]), turns: turnsRes.rows };
}

// 공유받은 사람은 소유자가 아니어도 읽기 전용으로 볼 수 있다.
async function getSharedConversation(viewerUserId, conversationId) {
  await ready;
  const shareRes = await pool.query(
    'SELECT 1 FROM conversation_shares WHERE conversation_id = $1 AND shared_with_user_id = $2',
    [conversationId, viewerUserId]
  );
  if (!shareRes.rows[0]) return null;
  const convRes = await pool.query('SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL', [conversationId]);
  if (!convRes.rows[0]) return null;
  const turnsRes = await pool.query(
    'SELECT id, role, content, attachments, at FROM turns WHERE conversation_id = $1 AND is_active = true ORDER BY at ASC',
    [conversationId]
  );
  return { ...rowToConversation(convRes.rows[0]), turns: turnsRes.rows };
}

// 편집/재생성 시 특정 시점 이후의 turn을 모두 지운다. keepCount개만 남긴다.
async function rewindConversation(userId, conversationId, keepCount) {
  await ready;
  const owns = await pool.query(
    'SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [conversationId, userId]
  );
  if (!owns.rows[0]) return null;
  await pool.query(
    `DELETE FROM turns WHERE conversation_id = $1 AND id NOT IN (
       SELECT id FROM turns WHERE conversation_id = $1 ORDER BY at ASC LIMIT $2
     )`,
    [conversationId, keepCount]
  );
  return getConversation(userId, conversationId);
}

async function setConversationCategory(userId, conversationId, category) {
  await ready;
  const { rows } = await pool.query(
    'UPDATE conversations SET category = $3 WHERE id = $2 AND user_id = $1 RETURNING *',
    [userId, conversationId, category || '미분류']
  );
  return rows[0] ? rowToConversation(rows[0]) : null;
}

async function renameConversation(userId, conversationId, title) {
  await ready;
  const { rows } = await pool.query('UPDATE conversations SET title = $3 WHERE id = $2 AND user_id = $1 RETURNING *', [
    userId,
    conversationId,
    title,
  ]);
  return rows[0] ? rowToConversation(rows[0]) : null;
}

// 바로 지우지 않고 휴지통으로 옮긴다 — 실수로 지웠을 때 복구할 수 있게.
async function deleteConversation(userId, conversationId) {
  await ready;
  const { rowCount } = await pool.query(
    'UPDATE conversations SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [conversationId, userId]
  );
  return rowCount > 0;
}

async function appendTurn(userId, conversationId, role, content, attachments, tokens) {
  await ready;
  if (role === 'user') {
    const countRes = await pool.query('SELECT COUNT(*)::int AS n FROM turns WHERE conversation_id = $1', [
      conversationId,
    ]);
    if (countRes.rows[0].n === 0) {
      const title = content ? content.slice(0, 30) + (content.length > 30 ? '…' : '') : '[이미지]';
      // 소유자 확인 없이 conversationId만으로 갱신되지 않도록 user_id도 함께 검사한다(방어적).
      await pool.query('UPDATE conversations SET title = $2 WHERE id = $1 AND user_id = $3', [
        conversationId,
        title,
        userId,
      ]);
    }
  }
  await pool.query('INSERT INTO turns (conversation_id, role, content, attachments, tokens) VALUES ($1, $2, $3, $4, $5)', [
    conversationId,
    role,
    content,
    attachments ? JSON.stringify(attachments) : null,
    typeof tokens === 'number' ? tokens : null,
  ]);
}

// ---- 대화 브랜칭(재생성 시 이전 답변을 지우지 않고 보관) ----

// 마지막 턴이 이미 모델 답변이면(=재생성 요청) 지우지 않고 비활성 처리해 보관한다.
// 반환된 branchGroup으로 새 답변을 같은 그룹에 묶어 저장한다.
async function archiveLastModelTurn(userId, conversationId) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
    conversationId,
    userId,
  ]);
  if (!owns.rows[0]) return null;
  const activeTurns = await pool.query(
    'SELECT id, role FROM turns WHERE conversation_id = $1 AND is_active = true ORDER BY at ASC',
    [conversationId]
  );
  const rows = activeTurns.rows;
  const last = rows[rows.length - 1];
  if (!last || last.role !== 'model') return null;
  const anchor = rows[rows.length - 2];
  const branchGroup = anchor ? anchor.id : last.id;
  await pool.query('UPDATE turns SET is_active = false, branch_group = $2 WHERE id = $1', [last.id, branchGroup]);
  return { branchGroup };
}

async function addBranchTurn(conversationId, role, content, attachments, tokens, branchGroup) {
  await ready;
  const { rows } = await pool.query(
    `INSERT INTO turns (conversation_id, role, content, attachments, tokens, branch_group, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [
      conversationId,
      role,
      content,
      attachments ? JSON.stringify(attachments) : null,
      typeof tokens === 'number' ? tokens : null,
      branchGroup,
    ]
  );
  return rows[0].id;
}

async function getBranches(userId, conversationId, branchGroup) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
  if (!owns.rows[0]) return null;
  const { rows } = await pool.query(
    "SELECT id, content, is_active AS \"isActive\", at FROM turns WHERE conversation_id = $1 AND branch_group = $2 AND role = 'model' ORDER BY at ASC",
    [conversationId, branchGroup]
  );
  return rows;
}

async function activateBranch(userId, conversationId, branchGroup, turnId) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
  if (!owns.rows[0]) return false;
  const { rowCount } = await pool.query(
    "UPDATE turns SET is_active = (id = $3) WHERE conversation_id = $1 AND branch_group = $2 AND role = 'model'",
    [conversationId, branchGroup, turnId]
  );
  return rowCount > 0;
}

// ---- 프로젝트별 지식 베이스 ----

async function addKnowledgeFile(userId, conversationId, name, mimeType, data) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
  if (!owns.rows[0]) return null;
  const { rows } = await pool.query(
    'INSERT INTO knowledge_files (conversation_id, name, mime_type, data) VALUES ($1, $2, $3, $4) RETURNING id, name, mime_type AS "mimeType", created_at AS "createdAt"',
    [conversationId, name, mimeType, data]
  );
  return rows[0];
}

async function listKnowledgeFiles(conversationId) {
  await ready;
  const { rows } = await pool.query(
    'SELECT id, name, mime_type AS "mimeType", data, created_at AS "createdAt" FROM knowledge_files WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId]
  );
  return rows;
}

async function deleteKnowledgeFile(userId, conversationId, fileId) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
  if (!owns.rows[0]) return false;
  const { rowCount } = await pool.query('DELETE FROM knowledge_files WHERE id = $1 AND conversation_id = $2', [
    fileId,
    conversationId,
  ]);
  return rowCount > 0;
}

// ---- 유저 간 대화 공유(읽기 전용) ----

async function shareConversation(ownerUserId, conversationId, targetEmail) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, ownerUserId]);
  if (!owns.rows[0]) return { error: '프로젝트를 찾을 수 없습니다.' };
  const target = await findUserByEmail(targetEmail);
  if (!target) return { error: '해당 이메일로 가입된 계정이 없습니다.' };
  if (target.id === ownerUserId) return { error: '본인에게는 공유할 수 없습니다.' };
  await pool.query(
    'INSERT INTO conversation_shares (conversation_id, shared_with_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [conversationId, target.id]
  );
  return { ok: true };
}

async function listSharedWithMe(userId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT c.*, u.email AS owner_email
     FROM conversation_shares s
     JOIN conversations c ON c.id = s.conversation_id
     JOIN users u ON u.id = c.user_id
     WHERE s.shared_with_user_id = $1 AND c.deleted_at IS NULL
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...rowToConversation(r), ownerEmail: r.owner_email }));
}

async function getConversationShares(ownerUserId, conversationId) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, ownerUserId]);
  if (!owns.rows[0]) return null;
  const { rows } = await pool.query(
    `SELECT u.id AS "userId", u.email
     FROM conversation_shares s
     JOIN users u ON u.id = s.shared_with_user_id
     WHERE s.conversation_id = $1
     ORDER BY s.created_at ASC`,
    [conversationId]
  );
  return rows;
}

async function unshareConversation(ownerUserId, conversationId, targetUserId) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, ownerUserId]);
  if (!owns.rows[0]) return false;
  await pool.query('DELETE FROM conversation_shares WHERE conversation_id = $1 AND shared_with_user_id = $2', [
    conversationId,
    targetUserId,
  ]);
  return true;
}

// ---- 관리자 프롬프트 템플릿 ----

async function listPromptTemplates() {
  await ready;
  const { rows } = await pool.query('SELECT id, title, content FROM prompt_templates ORDER BY created_at ASC');
  return rows;
}

async function createPromptTemplate(userId, title, content) {
  await ready;
  const { rows } = await pool.query(
    'INSERT INTO prompt_templates (title, content, created_by) VALUES ($1, $2, $3) RETURNING id, title, content',
    [title, content, userId]
  );
  return rows[0];
}

async function deletePromptTemplate(id) {
  await ready;
  const { rowCount } = await pool.query('DELETE FROM prompt_templates WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---- 유저 본인 사용량 ----

async function getMyUsage(userId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT c.id)::int AS conversation_count, COALESCE(SUM(t.tokens), 0)::bigint AS total_tokens
     FROM conversations c LEFT JOIN turns t ON t.conversation_id = c.id AND t.role = 'model'
     WHERE c.user_id = $1 AND c.deleted_at IS NULL`,
    [userId]
  );
  return { conversationCount: rows[0].conversation_count, totalTokens: Number(rows[0].total_tokens) };
}

// 관리자용 사용량 요약: 유저별 대화 수와 누적 토큰 사용량.
async function getUsageSummary() {
  await ready;
  const { rows } = await pool.query(`
    SELECT u.email, u.created_at,
      COUNT(DISTINCT c.id)::int AS conversation_count,
      COALESCE(SUM(t.tokens), 0)::bigint AS total_tokens
    FROM users u
    LEFT JOIN conversations c ON c.user_id = u.id
    LEFT JOIN turns t ON t.conversation_id = c.id AND t.role = 'model'
    GROUP BY u.id
    ORDER BY total_tokens DESC
  `);
  return rows.map((r) => ({
    email: r.email,
    createdAt: r.created_at,
    conversationCount: r.conversation_count,
    totalTokens: Number(r.total_tokens),
  }));
}

// 최근 N일간 일별 토큰 사용량 추이(관리자 대시보드 그래프용).
async function getUsageTrend(days = 14) {
  await ready;
  const { rows } = await pool.query(
    `SELECT date_trunc('day', at) AS day, COALESCE(SUM(tokens), 0)::bigint AS tokens
     FROM turns
     WHERE role = 'model' AND at > now() - ($1 || ' days')::interval
     GROUP BY day
     ORDER BY day ASC`,
    [days]
  );
  return rows.map((r) => ({ day: r.day, tokens: Number(r.tokens) }));
}

async function getAllConversationsWithEmails() {
  await ready;
  const usersRes = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  const result = [];
  for (const u of usersRes.rows) {
    const convRes = await pool.query('SELECT * FROM conversations WHERE user_id = $1 ORDER BY created_at DESC', [
      u.id,
    ]);
    const conversations = [];
    for (const c of convRes.rows) {
      const turnsRes = await pool.query(
        'SELECT role, content, attachments, at FROM turns WHERE conversation_id = $1 ORDER BY at ASC',
        [c.id]
      );
      conversations.push({ ...rowToConversation(c), turns: turnsRes.rows });
    }
    result.push({ userId: u.id, email: u.email, createdAt: u.created_at, conversations });
  }
  return result;
}

// ---- 시스템 알림(모델 장애, 심각한 오류 등을 관리자 화면에서 볼 수 있게) ----

async function logAlert(level, message) {
  await ready;
  await pool.query('INSERT INTO alerts (level, message) VALUES ($1, $2)', [level, message]);
}

async function getRecentAlerts(limit = 20) {
  await ready;
  const { rows } = await pool.query('SELECT level, message, at FROM alerts ORDER BY at DESC LIMIT $1', [limit]);
  return rows;
}

// ---- 비밀번호 재설정 ----

async function createPasswordReset(userId) {
  await ready;
  const token = newId() + newId();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1시간
  await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
  await pool.query('INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

async function consumePasswordReset(token) {
  await ready;
  const { rows } = await pool.query('SELECT user_id, expires_at FROM password_resets WHERE token = $1', [token]);
  const row = rows[0];
  if (!row) return null;
  await pool.query('DELETE FROM password_resets WHERE token = $1', [token]);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}

// ---- 구글 캘린더 연동 / 개인 접속 토큰 (음성 명령용) ----

async function saveGoogleCalendarToken(userId, refreshToken) {
  await ready;
  await pool.query('UPDATE users SET google_calendar_refresh_token = $2 WHERE id = $1', [userId, refreshToken]);
}

async function disconnectGoogleCalendar(userId) {
  await ready;
  await pool.query('UPDATE users SET google_calendar_refresh_token = NULL WHERE id = $1', [userId]);
}

// 시리 단축어 등 브라우저 세션 없이 호출하는 곳에서 쓰는 개인 토큰. 없으면 새로 만든다.
async function getOrCreateApiToken(userId) {
  await ready;
  const existing = await pool.query('SELECT api_token FROM users WHERE id = $1', [userId]);
  if (existing.rows[0]?.api_token) return existing.rows[0].api_token;
  const token = 'spk_' + crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET api_token = $2 WHERE id = $1', [userId, token]);
  return token;
}

async function regenerateApiToken(userId) {
  await ready;
  const token = 'spk_' + crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET api_token = $2 WHERE id = $1', [userId, token]);
  return token;
}

async function findUserByApiToken(token) {
  await ready;
  const { rows } = await pool.query('SELECT * FROM users WHERE api_token = $1', [token]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// ---- 일정 알림용 Web Push 구독 ----

async function savePushSubscription(userId, subscription) {
  await ready;
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $3, auth = $4`,
    [subscription.endpoint, userId, subscription.keys.p256dh, subscription.keys.auth]
  );
}

async function deletePushSubscription(endpoint) {
  await ready;
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function hasPushSubscription(userId) {
  await ready;
  const { rows } = await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [userId]);
  return rows.length > 0;
}

// 캘린더도 연결하고 알림 구독도 한 유저 + 그 구독 목록을 함께 반환한다(알림 스케줄러용).
async function getUsersWithCalendarAndPush() {
  await ready;
  const { rows } = await pool.query(`
    SELECT u.id, u.google_calendar_refresh_token,
      COALESCE(json_agg(json_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
        FILTER (WHERE p.endpoint IS NOT NULL), '[]') AS subscriptions
    FROM users u
    JOIN push_subscriptions p ON p.user_id = u.id
    WHERE u.google_calendar_refresh_token IS NOT NULL
    GROUP BY u.id
  `);
  return rows.map((r) => ({
    userId: r.id,
    googleCalendarRefreshToken: r.google_calendar_refresh_token,
    subscriptions: r.subscriptions,
  }));
}

async function wasEventNotified(eventId) {
  await ready;
  const { rows } = await pool.query('SELECT 1 FROM notified_events WHERE event_id = $1', [eventId]);
  return rows.length > 0;
}

async function markEventNotified(eventId) {
  await ready;
  await pool.query('INSERT INTO notified_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
  // 오래된 기록은 정리한다(무한정 쌓이지 않게).
  await pool.query("DELETE FROM notified_events WHERE notified_at < now() - interval '2 days'");
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser,
  findOrCreateGoogleUser,
  getSettings,
  updateSettings,
  updatePasswordHash,
  createConversation,
  listConversations,
  searchConversations,
  listTrash,
  restoreConversation,
  permanentlyDeleteConversation,
  getConversation,
  setConversationCategory,
  renameConversation,
  deleteConversation,
  rewindConversation,
  appendTurn,
  getAllConversationsWithEmails,
  getUsageSummary,
  getUsageTrend,
  logAlert,
  getRecentAlerts,
  createPasswordReset,
  consumePasswordReset,
  saveGoogleCalendarToken,
  disconnectGoogleCalendar,
  getOrCreateApiToken,
  regenerateApiToken,
  findUserByApiToken,
  savePushSubscription,
  deletePushSubscription,
  hasPushSubscription,
  getUsersWithCalendarAndPush,
  wasEventNotified,
  markEventNotified,
  getSharedConversation,
  setConversationInstructions,
  setConversationPersona,
  archiveLastModelTurn,
  addBranchTurn,
  getBranches,
  activateBranch,
  addKnowledgeFile,
  listKnowledgeFiles,
  deleteKnowledgeFile,
  shareConversation,
  listSharedWithMe,
  getConversationShares,
  unshareConversation,
  listPromptTemplates,
  createPromptTemplate,
  deletePromptTemplate,
  getMyUsage,
};
