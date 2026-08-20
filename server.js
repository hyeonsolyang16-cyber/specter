require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { GoogleGenAI, ApiError } = require('@google/genai');
const { buildSystemPrompt } = require('./system-prompt');
const store = require('./store');

const PORT = process.env.PORT || 3210;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!req.session.isAdmin) return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  next();
}

// 로그인 안 된 사용자가 채팅/관리자 페이지로 바로 들어오면 로그인 화면으로 보낸다.
app.get('/', (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login.html');
  next();
});
app.get('/admin.html', (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login.html');
  if (!req.session.isAdmin) return res.redirect('/');
  next();
});
app.get('/settings.html', (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login.html');
  next();
});

app.use(express.static('public'));

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: '이메일과 8자 이상의 비밀번호를 입력하세요.' });
  }
  if (await store.findUserByEmail(email)) {
    return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await store.createUser(email, passwordHash);
  req.session.userId = user.id;
  req.session.isAdmin = email.toLowerCase() === ADMIN_EMAIL;
  res.json({ email: user.email, isAdmin: req.session.isAdmin });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await store.findUserByEmail(email || '');
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  req.session.userId = user.id;
  req.session.isAdmin = user.email.toLowerCase() === ADMIN_EMAIL;
  res.json({ email: user.email, isAdmin: req.session.isAdmin });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await store.findUserById(req.session.userId);
  res.json({ email: user?.email, isAdmin: !!req.session.isAdmin, settings: await store.getSettings(req.session.userId) });
});

const VALID_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const VALID_INTENSITIES = ['mild', 'strong'];
const VALID_THEMES = ['light', 'dark'];

app.get('/api/settings', requireAuth, async (req, res) => {
  res.json(await store.getSettings(req.session.userId));
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { thinkingLevel, pushbackIntensity, theme } = req.body || {};
  const patch = {};
  if (thinkingLevel !== undefined) {
    if (!VALID_THINKING_LEVELS.includes(thinkingLevel)) {
      return res.status(400).json({ error: '유효하지 않은 thinkingLevel 입니다.' });
    }
    patch.thinkingLevel = thinkingLevel;
  }
  if (pushbackIntensity !== undefined) {
    if (!VALID_INTENSITIES.includes(pushbackIntensity)) {
      return res.status(400).json({ error: '유효하지 않은 pushbackIntensity 입니다.' });
    }
    patch.pushbackIntensity = pushbackIntensity;
  }
  if (theme !== undefined) {
    if (!VALID_THEMES.includes(theme)) {
      return res.status(400).json({ error: '유효하지 않은 theme 입니다.' });
    }
    patch.theme = theme;
  }
  res.json(await store.updateSettings(req.session.userId, patch));
});

app.post('/api/account/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다.' });
  }
  const user = await store.findUserById(req.session.userId);
  if (!user || !(await bcrypt.compare(currentPassword || '', user.passwordHash))) {
    return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  }
  const newHash = await bcrypt.hash(newPassword, 10);
  await store.updatePasswordHash(user.id, newHash);
  res.json({ ok: true });
});

app.get('/api/admin/conversations', requireAdmin, async (req, res) => {
  res.json(await store.getAllConversationsWithEmails());
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { category } = req.body || {};
  const conversation = await store.createConversation(req.session.userId, category);
  res.json(conversation);
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  res.json(await store.listConversations(req.session.userId));
});

app.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const conversation = await store.getConversation(req.session.userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(conversation);
});

app.patch('/api/conversations/:id/category', requireAuth, async (req, res) => {
  const { category } = req.body || {};
  const conversation = await store.setConversationCategory(req.session.userId, req.params.id, category);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(conversation);
});

app.patch('/api/conversations/:id/title', requireAuth, async (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title이 필요합니다.' });
  const conversation = await store.renameConversation(req.session.userId, req.params.id, title.trim().slice(0, 60));
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(conversation);
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  const deleted = await store.deleteConversation(req.session.userId, req.params.id);
  if (!deleted) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json({ ok: true });
});

// 저장된 turns({role: 'user'|'model', content})를 Gemini가 요구하는
// {role, parts: [{text}]} 형태로 감싼다.
function toGeminiContents(turns) {
  return turns.map((t) => ({ role: t.role, parts: [{ text: t.content }] }));
}

// Gemini는 잘못된 키를 401이 아니라 400(INVALID_ARGUMENT)으로 반환하고,
// 세부 사유는 message에 담긴 raw JSON 안의 details[].reason에 들어있다.
function isInvalidApiKey(err) {
  try {
    const parsed = JSON.parse(err.message);
    return parsed?.error?.details?.some((d) => d.reason === 'API_KEY_INVALID');
  } catch {
    return false;
  }
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const { conversationId, message } = req.body || {};
  if (!conversationId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'conversationId와 message가 필요합니다.' });
  }
  const conversation = await store.getConversation(req.session.userId, conversationId);
  if (!conversation) {
    return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  }

  try {
    const settings = await store.getSettings(req.session.userId);
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: toGeminiContents([...conversation.turns, { role: 'user', content: message }]),
      config: {
        systemInstruction: buildSystemPrompt(settings.pushbackIntensity),
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: settings.thinkingLevel },
      },
    });

    await store.appendTurn(req.session.userId, conversationId, 'user', message);
    await store.appendTurn(req.session.userId, conversationId, 'model', response.text);

    res.json({ text: response.text });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      // 무료 티어 할당량(분당/일일)은 시간이 지나면 자동으로 초기화된다.
      return res.status(429).json({
        kind: 'rate_limit',
        retryAfterSeconds: 30,
        error: '무료 사용량 한도에 도달했습니다. 잠시 후 자동으로 초기화됩니다.',
      });
    }
    if (err instanceof ApiError && err.status === 400 && isInvalidApiKey(err)) {
      return res.status(401).json({ kind: 'auth', error: 'API 키가 유효하지 않습니다. .env 파일을 확인하세요.' });
    }
    console.error(err);
    res.status(502).json({ kind: 'unknown', error: 'Gemini API 호출에 실패했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`Specter가 http://localhost:${PORT} 에서 실행 중입니다. (model=${MODEL})`);
});
