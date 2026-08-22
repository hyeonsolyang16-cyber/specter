require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { GoogleGenAI, ApiError } = require('@google/genai');
const { buildSystemPrompt } = require('./system-prompt');
const store = require('./store');

const PORT = process.env.PORT || 3210;
// 콤마로 여러 관리자 이메일을 등록할 수 있다. 예: "a@x.com,b@y.com"
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
function isAdminEmail(email) {
  return ADMIN_EMAILS.has((email || '').toLowerCase());
}

// 성능 모드 하나로 모델 + 사고 강도를 함께 정한다. 전부 Gemini 무료 티어 모델이다.
const PERFORMANCE_MODES = {
  lite: { model: 'gemini-3.5-flash-lite', thinkingLevel: 'minimal' },
  standard: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', thinkingLevel: 'medium' },
  high: { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', thinkingLevel: 'high' },
  max: { model: 'gemini-3.7-flash', thinkingLevel: 'high' },
};

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 세션을 DB에 저장해 재배포(=서버 재시작)해도 로그인이 풀리지 않도록 한다.
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Render는 TLS를 프록시 단에서 끝내고 내부로는 평문 HTTP로 전달하므로, trust proxy를
// 켜야 X-Forwarded-Proto를 보고 요청이 HTTPS인지 정확히 판단해 secure 쿠키가 정상 동작한다.
const IS_PRODUCTION = !!process.env.RENDER;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(
  session({
    store: new pgSession({ pool: sessionPool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: IS_PRODUCTION,
      sameSite: 'lax',
      httpOnly: true,
    },
  })
);

// 로그인 필요 응답은 브라우저/뒤로가기 캐시에 남지 않게 한다.
// (로그아웃 후 뒤로가기로 이전 화면이 그대로 보이는 걸 막기 위함)
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function requireAuth(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!req.session.isAdmin) return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  next();
}

// 로그인 시도를 제한해 무차별 대입 공격을 막는다.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

// 로그인 안 된 사용자가 채팅/관리자 페이지로 바로 들어오면 로그인 화면으로 보낸다.
app.get('/', noStore, (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login.html');
  next();
});
app.get('/admin.html', noStore, (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login.html');
  if (!req.session.isAdmin) return res.redirect('/');
  next();
});
app.get('/settings.html', noStore, (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login.html');
  next();
});

app.use(express.static('public'));

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

app.post('/api/signup', authLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const { password } = req.body || {};
  if (!EMAIL_RE.test(email) || email.length > 254 || !password || password.length < 8) {
    return res.status(400).json({ error: '올바른 이메일과 8자 이상의 비밀번호를 입력하세요.' });
  }
  if (await store.findUserByEmail(email)) {
    return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await store.createUser(email, passwordHash);
  req.session.userId = user.id;
  req.session.isAdmin = isAdminEmail(email);
  res.json({ email: user.email, isAdmin: req.session.isAdmin });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await store.findUserByEmail(email || '');
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  if (!(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  req.session.userId = user.id;
  req.session.isAdmin = isAdminEmail(user.email);
  res.json({ email: user.email, isAdmin: req.session.isAdmin });
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.redirect('/login.html?error=google_not_configured');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login.html?error=google');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) throw new Error('token exchange failed: ' + JSON.stringify(tokenData));

    // id_token은 우리 client_secret으로 인증된 서버-서버 호출로 구글에서 직접 받은 값이라
    // (사용자 입력이 아니라) 별도 서명 검증 없이 payload만 디코딩해도 안전하다.
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64url').toString('utf8'));
    // 방어적 검증: 우리 client_id로 발급된 토큰이 맞는지, 이메일이 확인된 계정인지 확인한다.
    if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('토큰의 발급 대상이 일치하지 않습니다.');
    if (!payload.email || !payload.email_verified) throw new Error('구글 이메일이 확인되지 않았습니다.');

    const user = await store.findOrCreateGoogleUser(payload.email.toLowerCase(), payload.sub);
    req.session.userId = user.id;
    req.session.isAdmin = isAdminEmail(user.email);
    res.redirect('/');
  } catch (err) {
    console.error('Google 로그인 실패:', err);
    res.redirect('/login.html?error=google');
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await store.findUserById(req.session.userId);
  res.json({ email: user?.email, isAdmin: !!req.session.isAdmin, settings: await store.getSettings(req.session.userId) });
});

const VALID_PERFORMANCE_MODES = Object.keys(PERFORMANCE_MODES);
const VALID_INTENSITIES = ['mild', 'strong'];
const VALID_THEMES = ['light', 'dark'];
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

// base64 문자열 길이로 원본 바이트 크기를 역산해 개수/용량 제한을 검증한다.
function validateAttachments(attachments) {
  if (attachments === undefined) return null;
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    return `첨부파일은 최대 ${MAX_ATTACHMENTS}개까지 가능합니다.`;
  }
  for (const a of attachments) {
    const isImage = a && typeof a.mimeType === 'string' && a.mimeType.startsWith('image/');
    const isPdf = a && a.mimeType === 'application/pdf';
    if (!a || typeof a.data !== 'string' || !(isImage || isPdf)) {
      return '첨부파일 형식이 올바르지 않습니다. 이미지 또는 PDF만 가능합니다.';
    }
    if (a.data.length * 0.75 > MAX_ATTACHMENT_BYTES) {
      return '첨부파일은 4MB 이하만 가능합니다.';
    }
  }
  return null;
}

app.get('/api/settings', requireAuth, async (req, res) => {
  res.json(await store.getSettings(req.session.userId));
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { performanceMode, pushbackIntensity, theme } = req.body || {};
  const patch = {};
  if (performanceMode !== undefined) {
    if (!VALID_PERFORMANCE_MODES.includes(performanceMode)) {
      return res.status(400).json({ error: '유효하지 않은 performanceMode 입니다.' });
    }
    patch.performanceMode = performanceMode;
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

app.get('/api/admin/usage', requireAdmin, async (req, res) => {
  res.json(await store.getUsageSummary());
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

app.patch('/api/conversations/:id/rewind', requireAuth, async (req, res) => {
  const { keepCount } = req.body || {};
  if (typeof keepCount !== 'number' || keepCount < 0) {
    return res.status(400).json({ error: 'keepCount가 필요합니다.' });
  }
  const conversation = await store.rewindConversation(req.session.userId, req.params.id, keepCount);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(conversation);
});

// 저장된 turns({role, content, attachments?: [{mimeType, data}]})를 Gemini가 요구하는
// {role, parts: [{text}, {inlineData}...]} 형태로 감싼다.
function toGeminiContents(turns) {
  return turns.map((t) => {
    const parts = [];
    if (t.content) parts.push({ text: t.content });
    if (Array.isArray(t.attachments)) {
      for (const a of t.attachments) {
        parts.push({ inlineData: { data: a.data, mimeType: a.mimeType } });
      }
    }
    return { role: t.role, parts };
  });
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

// 스트리밍 생성 + 전송을 공통 처리한다. onComplete은 실제로 텍스트가 생성된
// 경우에만(정지되어도 부분 텍스트가 있으면) 호출되어 DB에 저장한다.
async function streamAndRespond(req, res, contents, settings, onComplete) {
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });
  res.on('error', () => {
    aborted = true;
  });

  const mode = PERFORMANCE_MODES[settings.performanceMode] || PERFORMANCE_MODES.standard;

  try {
    const stream = await ai.models.generateContentStream({
      model: mode.model,
      contents,
      config: {
        systemInstruction: buildSystemPrompt(settings.pushbackIntensity),
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: mode.thinkingLevel },
      },
    });

    // 첫 청크를 헤더 커밋 전에 받아본다 — 레이트리밋/키 오류 같은 실패는
    // 보통 여기서 던져지므로, 그 경우엔 기존 JSON 에러 응답을 그대로 쓸 수 있다.
    const iterator = stream[Symbol.asyncIterator]();
    let result = await iterator.next();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    let fullText = '';
    let totalTokens = null;
    while (!result.done) {
      if (aborted) break;
      if (result.value?.text) {
        fullText += result.value.text;
        res.write(result.value.text);
      }
      // 사용량은 보통 마지막 청크에만 누적치로 들어오므로, 매번 갱신해 마지막 값을 남긴다.
      if (typeof result.value?.usageMetadata?.totalTokenCount === 'number') {
        totalTokens = result.value.usageMetadata.totalTokenCount;
      }
      result = await iterator.next();
    }

    if (fullText) await onComplete(fullText, totalTokens);
    res.end();
  } catch (err) {
    if (res.headersSent) {
      // 스트리밍이 이미 시작된 뒤라 일반 텍스트만 보낼 수 있다 — 여기서 끊는다.
      res.end();
      return;
    }
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
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const { conversationId, attachments } = req.body || {};
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const attachmentError = validateAttachments(attachments);
  if (!conversationId || (!message && !attachments?.length)) {
    return res.status(400).json({ error: 'conversationId와 message 또는 attachments가 필요합니다.' });
  }
  if (attachmentError) {
    return res.status(400).json({ error: attachmentError });
  }
  const conversation = await store.getConversation(req.session.userId, conversationId);
  if (!conversation) {
    return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  }

  const settings = await store.getSettings(req.session.userId);
  const contents = toGeminiContents([...conversation.turns, { role: 'user', content: message, attachments }]);

  await streamAndRespond(req, res, contents, settings, async (fullText, totalTokens) => {
    await store.appendTurn(req.session.userId, conversationId, 'user', message, attachments);
    await store.appendTurn(req.session.userId, conversationId, 'model', fullText, undefined, totalTokens);
  });
});

// 마지막 응답을 지우고 그 직전 사용자 메시지로 새 응답만 다시 받는다.
app.post('/api/chat/regenerate', requireAuth, async (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId가 필요합니다.' });
  const conversation = await store.getConversation(req.session.userId, conversationId);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  const lastTurn = conversation.turns[conversation.turns.length - 1];
  if (!lastTurn || lastTurn.role !== 'user') {
    return res.status(400).json({ error: '재생성할 응답이 없습니다.' });
  }

  const settings = await store.getSettings(req.session.userId);
  const contents = toGeminiContents(conversation.turns);

  await streamAndRespond(req, res, contents, settings, async (fullText, totalTokens) => {
    await store.appendTurn(req.session.userId, conversationId, 'model', fullText, undefined, totalTokens);
  });
});

app.listen(PORT, () => {
  console.log(`Specter가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
