const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONVOS_FILE = path.join(DATA_DIR, 'conversations.json');

const DEFAULT_SETTINGS = { thinkingLevel: 'medium', pushbackIntensity: 'strong', theme: 'light' };

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  if (!fs.existsSync(CONVOS_FILE)) fs.writeFileSync(CONVOS_FILE, '{}');
}
ensureDataFiles();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- 사용자 ----

function getUsers() {
  return readJson(USERS_FILE);
}

function findUserByEmail(email) {
  return getUsers().find((u) => u.email.toLowerCase() === email.toLowerCase());
}

function findUserById(id) {
  return getUsers().find((u) => u.id === id);
}

function createUser(email, passwordHash) {
  const users = getUsers();
  const user = {
    id: newId(),
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
  };
  users.push(user);
  writeJson(USERS_FILE, users);
  return user;
}

function getSettings(userId) {
  const user = findUserById(userId);
  return { ...DEFAULT_SETTINGS, ...(user?.settings || {}) };
}

function updateSettings(userId, patch) {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  user.settings = { ...DEFAULT_SETTINGS, ...(user.settings || {}), ...patch };
  writeJson(USERS_FILE, users);
  return user.settings;
}

function updatePasswordHash(userId, passwordHash) {
  const users = getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return false;
  user.passwordHash = passwordHash;
  writeJson(USERS_FILE, users);
  return true;
}

// ---- 대화(프로젝트) ----

function getAllConvos() {
  return readJson(CONVOS_FILE);
}

function createConversation(userId, category) {
  const convos = getAllConvos();
  if (!convos[userId]) convos[userId] = [];
  const conversation = {
    id: newId(),
    title: '새 프로젝트',
    category: category || '미분류',
    createdAt: new Date().toISOString(),
    turns: [],
  };
  convos[userId].unshift(conversation);
  writeJson(CONVOS_FILE, convos);
  return conversation;
}

function listConversations(userId) {
  const convos = getAllConvos();
  return (convos[userId] || []).map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category || '미분류',
    createdAt: c.createdAt,
    messageCount: c.turns.length,
  }));
}

function getConversation(userId, conversationId) {
  const convos = getAllConvos();
  return (convos[userId] || []).find((c) => c.id === conversationId) || null;
}

function setConversationCategory(userId, conversationId, category) {
  const convos = getAllConvos();
  const conversation = (convos[userId] || []).find((c) => c.id === conversationId);
  if (!conversation) return null;
  conversation.category = category || '미분류';
  writeJson(CONVOS_FILE, convos);
  return conversation;
}

function appendTurn(userId, conversationId, role, content) {
  const convos = getAllConvos();
  const list = convos[userId] || [];
  const conversation = list.find((c) => c.id === conversationId);
  if (!conversation) return null;
  if (conversation.turns.length === 0 && role === 'user') {
    conversation.title = content.slice(0, 30) + (content.length > 30 ? '…' : '');
  }
  conversation.turns.push({ role, content, at: new Date().toISOString() });
  writeJson(CONVOS_FILE, convos);
  return conversation;
}

function getAllConversationsWithEmails() {
  const users = getUsers();
  const convos = getAllConvos();
  return users.map((u) => ({
    userId: u.id,
    email: u.email,
    createdAt: u.createdAt,
    conversations: convos[u.id] || [],
  }));
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser,
  getSettings,
  updateSettings,
  updatePasswordHash,
  createConversation,
  listConversations,
  getConversation,
  setConversationCategory,
  appendTurn,
  getAllConversationsWithEmails,
};
