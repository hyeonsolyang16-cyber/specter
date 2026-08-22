const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_SETTINGS = { performanceMode: 'standard', pushbackIntensity: 'strong', theme: 'light' };

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

async function updateSettings(userId, patch) {
  await ready;
  const current = await getSettings(userId);
  const merged = { ...current, ...patch };
  const { rows } = await pool.query('UPDATE users SET settings = $2 WHERE id = $1 RETURNING settings', [
    userId,
    JSON.stringify(merged),
  ]);
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
    isPrivate: row.is_private,
  };
}

async function setConversationPrivacy(userId, conversationId, isPrivate) {
  await ready;
  const { rows } = await pool.query(
    'UPDATE conversations SET is_private = $3 WHERE id = $2 AND user_id = $1 RETURNING *',
    [userId, conversationId, !!isPrivate]
  );
  return rows[0] ? rowToConversation(rows[0]) : null;
}

async function listConversations(userId) {
  await ready;
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(t.id)::int AS message_count
     FROM conversations c LEFT JOIN turns t ON t.conversation_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...rowToConversation(r), messageCount: r.message_count }));
}

async function getConversation(userId, conversationId) {
  await ready;
  const convRes = await pool.query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
  if (!convRes.rows[0]) return null;
  const turnsRes = await pool.query(
    'SELECT role, content, attachments, at FROM turns WHERE conversation_id = $1 ORDER BY at ASC',
    [conversationId]
  );
  return { ...rowToConversation(convRes.rows[0]), turns: turnsRes.rows };
}

// 편집/재생성 시 특정 시점 이후의 turn을 모두 지운다. keepCount개만 남긴다.
async function rewindConversation(userId, conversationId, keepCount) {
  await ready;
  const owns = await pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
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

async function deleteConversation(userId, conversationId) {
  await ready;
  const { rowCount } = await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
  return rowCount > 0;
}

async function appendTurn(userId, conversationId, role, content, attachments) {
  await ready;
  if (role === 'user') {
    const countRes = await pool.query('SELECT COUNT(*)::int AS n FROM turns WHERE conversation_id = $1', [
      conversationId,
    ]);
    if (countRes.rows[0].n === 0) {
      const title = content ? content.slice(0, 30) + (content.length > 30 ? '…' : '') : '[이미지]';
      await pool.query('UPDATE conversations SET title = $2 WHERE id = $1', [conversationId, title]);
    }
  }
  await pool.query('INSERT INTO turns (conversation_id, role, content, attachments) VALUES ($1, $2, $3, $4)', [
    conversationId,
    role,
    content,
    attachments ? JSON.stringify(attachments) : null,
  ]);
}

async function getAllConversationsWithEmails() {
  await ready;
  const usersRes = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  const result = [];
  for (const u of usersRes.rows) {
    const convRes = await pool.query(
      'SELECT * FROM conversations WHERE user_id = $1 AND is_private = false ORDER BY created_at DESC',
      [u.id]
    );
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
  getConversation,
  setConversationCategory,
  setConversationPrivacy,
  renameConversation,
  deleteConversation,
  rewindConversation,
  appendTurn,
  getAllConversationsWithEmails,
};
