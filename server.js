require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { GoogleGenAI, ApiError } = require('@google/genai');
const { buildSystemPrompt } = require('./system-prompt');
const store = require('./store');

// Express 4는 async 라우트 핸들러 안에서 처리 안 된 에러(unhandled rejection)를 자동으로
// 잡아주지 않는다. 실제로 방금(stale 세션이 지워진 유저를 참조 → FK 위반) 서버 전체가
// 죽는 걸 확인했다 — 요청 하나의 오류가 전체 유저에게 영향을 주면 안 되므로,
// 여기서 잡아서 로그만 남기고 프로세스는 계속 살려둔다.
process.on('unhandledRejection', (err) => {
  console.error('처리되지 않은 Promise 거부:', err);
  store.logAlert('error', `unhandledRejection: ${(err?.message || String(err)).slice(0, 300)}`).catch(() => {});
});
process.on('uncaughtException', (err) => {
  console.error('처리되지 않은 예외:', err);
  store.logAlert('error', `uncaughtException: ${(err?.message || String(err)).slice(0, 300)}`).catch(() => {});
});

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

// 콤마로 여러 키를 등록하면, 하나가 할당량 초과/무효 상태여도 다음 키로 자동 전환한다.
// 키가 1개뿐이면 지금까지와 동일하게 동작한다.
const GEMINI_KEYS = process.env.GEMINI_API_KEY.split(',').map((k) => k.trim()).filter(Boolean);
const aiClients = GEMINI_KEYS.map((key) => new GoogleGenAI({ apiKey: key }));

function isRetryableGeminiError(err) {
  return err instanceof ApiError && (err.status === 429 || (err.status === 400 && isInvalidApiKey(err)));
}

async function generateWithFallback(params) {
  let lastErr;
  for (const client of aiClients) {
    try {
      return await client.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiError(err)) throw err;
    }
  }
  throw lastErr;
}

async function generateStreamWithFallback(params) {
  let lastErr;
  for (const client of aiClients) {
    try {
      return await client.models.generateContentStream(params);
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiError(err)) throw err;
    }
  }
  throw lastErr;
}

// 설정된 모델들이 실제로 살아있는지 시작 시 한 번 점검한다. 할당량 초과(429)는 모델 자체의
// 문제가 아니므로 건너뛰고, 그 외 오류(폐기된 모델 등)만 관리자 알림으로 남긴다.
async function checkModelHealth() {
  const uniqueModels = [...new Set(Object.values(PERFORMANCE_MODES).map((m) => m.model))];
  for (const model of uniqueModels) {
    try {
      await generateWithFallback({
        model,
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        config: { maxOutputTokens: 5 },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) continue;
      const msg = `모델 점검 실패: ${model} — ${(err.message || String(err)).slice(0, 200)}`;
      console.error(msg);
      store.logAlert('error', msg).catch(() => {});
    }
  }
}
checkModelHealth();

// 세션을 DB에 저장해 재배포(=서버 재시작)해도 로그인이 풀리지 않도록 한다.
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Render는 TLS를 프록시 단에서 끝내고 내부로는 평문 HTTP로 전달하므로, trust proxy를
// 켜야 X-Forwarded-Proto를 보고 요청이 HTTPS인지 정확히 판단해 secure 쿠키가 정상 동작한다.
const IS_PRODUCTION = !!process.env.RENDER;
const app = express();

// 실제로 스테일 세션(지워진 유저 참조) 하나가 async 핸들러 안에서 처리 안 된 예외를 던져
// 서버 전체를 죽이거나(위 unhandledRejection 이전) 요청을 영원히 멈추게 하는 걸 확인했다.
// 라우트마다 try/catch를 붙이는 대신, app.get/post/patch/delete 자체를 감싸서
// 어떤 라우트든 예외가 나면 자동으로 next(err)로 넘어가게 만든다.
for (const method of ['get', 'post', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    const wrapped = handlers.map((h) => {
      if (typeof h !== 'function') return h;
      return (req, res, next) => {
        try {
          const result = h(req, res, next);
          if (result && typeof result.catch === 'function') result.catch(next);
        } catch (err) {
          next(err);
        }
      };
    });
    return original(path, ...wrapped);
  };
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '48mb' }));
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

// 일정 알림용 Web Push. VAPID 키는 외부 계정 없이 자체 생성한 키 쌍이라 별도 가입이 필요 없다.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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

// 캘린더 연동은 로그인과 별개의 동의(오프라인 접근 + calendar 범위)가 필요하지만,
// 콜백 주소는 그대로 재사용한다 — state로 어느 흐름인지 구분해서 구글 클라우드 콘솔에
// 리디렉션 URI를 추가로 등록할 필요가 없게 했다.
app.get('/auth/google-calendar/connect', requireAuth, (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.redirect('/settings.html?calendar=not_configured');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state: 'calendar_connect',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
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

    if (state === 'calendar_connect') {
      if (!req.session.userId) return res.redirect('/login.html');
      if (!tokenData.refresh_token) {
        // 이미 한 번 동의한 적이 있으면 구글이 refresh_token을 다시 안 줄 수 있다 —
        // 그 경우 사용자가 구글 계정 권한 목록에서 스펙터 접근을 해제한 뒤 다시 시도해야 한다.
        return res.redirect('/settings.html?calendar=no_refresh_token');
      }
      await store.saveGoogleCalendarToken(req.session.userId, tokenData.refresh_token);
      return res.redirect('/settings.html?calendar=connected');
    }

    const user = await store.findOrCreateGoogleUser(payload.email.toLowerCase(), payload.sub);
    req.session.userId = user.id;
    req.session.isAdmin = isAdminEmail(user.email);
    res.redirect('/');
  } catch (err) {
    console.error('Google 로그인 실패:', err);
    if (state === 'calendar_connect') return res.redirect('/settings.html?calendar=error');
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

const VALID_PERFORMANCE_MODES = [...Object.keys(PERFORMANCE_MODES), 'auto'];
const VALID_INTENSITIES = ['mild', 'strong'];
const VALID_THEMES = ['light', 'dark'];
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// '자동' 모드일 때 메시지 길이/첨부/대화 길이로 모델 등급을 동적으로 고른다.
function resolveMode(performanceMode, { textLength = 0, hasAttachments = false, turnCount = 0 } = {}) {
  if (performanceMode !== 'auto') {
    return { ...(PERFORMANCE_MODES[performanceMode] || PERFORMANCE_MODES.standard), tierName: performanceMode };
  }
  const complexity = textLength + (hasAttachments ? 2000 : 0) + turnCount * 60;
  let tierName = 'lite';
  if (complexity > 3000) tierName = 'max';
  else if (complexity > 1200) tierName = 'high';
  else if (complexity > 300) tierName = 'standard';
  return { ...PERFORMANCE_MODES[tierName], tierName };
}

// 대화가 너무 길어지면 오래된 턴은 생략 표시로 압축해 토큰 낭비를 줄인다(요약 없이 자르기만 — 추가 비용 없음).
const MAX_HISTORY_TURNS = 30;
function compactHistory(turns) {
  if (turns.length <= MAX_HISTORY_TURNS) return turns;
  let startIdx = turns.length - MAX_HISTORY_TURNS;
  if (turns[startIdx].role !== 'user' && startIdx > 0) startIdx -= 1;
  const dropped = startIdx;
  const recent = turns.slice(startIdx).map((t) => ({ ...t }));
  if (dropped > 0 && recent[0]) {
    recent[0] = { ...recent[0], content: `[이전 대화 ${dropped}턴은 길이 제한으로 생략됨]\n\n${recent[0].content || ''}` };
  }
  return recent;
}

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
      return '첨부파일은 8MB 이하만 가능합니다.';
    }
  }
  return null;
}

app.get('/api/settings', requireAuth, async (req, res) => {
  res.json(await store.getSettings(req.session.userId));
});

const MAX_MEMORY_LENGTH = 2000;

app.post('/api/settings', requireAuth, async (req, res) => {
  const { performanceMode, pushbackIntensity, theme, memory, autoMemory } = req.body || {};
  const patch = {};
  if (memory !== undefined) {
    if (typeof memory !== 'string' || memory.length > MAX_MEMORY_LENGTH) {
      return res.status(400).json({ error: `메모리는 ${MAX_MEMORY_LENGTH}자 이하로 입력하세요.` });
    }
    patch.memory = memory;
  }
  if (autoMemory !== undefined) {
    patch.autoMemory = !!autoMemory;
  }
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

// 비밀번호 찾기: Resend로 재설정 링크를 보낸다. RESEND_API_KEY가 없으면 기능 자체가 비활성 상태다.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Specter <onboarding@resend.dev>';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });
  if (!res.ok) throw new Error(`이메일 발송 실패(${res.status}): ${await res.text()}`);
}

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  // 가입 여부를 노출하지 않기 위해 실제로 계정이 있든 없든 항상 같은 응답을 준다.
  const genericResponse = { ok: true, message: '해당 이메일로 가입된 계정이 있다면 재설정 링크를 보냈습니다.' };
  if (!EMAIL_RE.test(email)) return res.json(genericResponse);
  if (!RESEND_API_KEY) {
    console.error('비밀번호 재설정 요청이 왔지만 RESEND_API_KEY가 설정되지 않았습니다.');
    return res.status(503).json({ error: '이메일 발송 기능이 아직 설정되지 않았습니다. 관리자에게 문의하세요.' });
  }
  const user = await store.findUserByEmail(email);
  if (!user) return res.json(genericResponse);
  const token = await store.createPasswordReset(user.id);
  const link = `${APP_BASE_URL}/reset-password.html?token=${token}`;
  try {
    await sendEmail(
      user.email,
      'Specter 비밀번호 재설정',
      `<p>아래 링크를 클릭해 비밀번호를 재설정하세요. 1시간 동안 유효합니다.</p><p><a href="${link}">${link}</a></p><p>본인이 요청하지 않았다면 이 메일을 무시하세요.</p>`
    );
  } catch (err) {
    console.error(err);
    store.logAlert('error', `비밀번호 재설정 이메일 발송 실패: ${err.message}`).catch(() => {});
    return res.status(502).json({ error: '이메일 발송에 실패했습니다.' });
  }
  res.json(genericResponse);
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: '토큰과 8자 이상의 새 비밀번호가 필요합니다.' });
  }
  const userId = await store.consumePasswordReset(token);
  if (!userId) return res.status(400).json({ error: '유효하지 않거나 만료된 링크입니다. 다시 요청해주세요.' });
  const newHash = await bcrypt.hash(newPassword, 10);
  await store.updatePasswordHash(userId, newHash);
  res.json({ ok: true });
});

// ---- 구글 캘린더 연동 + 음성 명령 (시리 단축어 등에서 개인 토큰으로 호출) ----

app.get('/api/calendar/status', requireAuth, async (req, res) => {
  const user = await store.findUserById(req.session.userId);
  res.json({ connected: !!user.googleCalendarRefreshToken });
});

app.post('/api/calendar/disconnect', requireAuth, async (req, res) => {
  await store.disconnectGoogleCalendar(req.session.userId);
  res.json({ ok: true });
});

app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

app.get('/api/push/status', requireAuth, async (req, res) => {
  res.json({ subscribed: await store.hasPushSubscription(req.session.userId) });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: '유효하지 않은 구독 정보입니다.' });
  }
  await store.savePushSubscription(req.session.userId, subscription);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) await store.deletePushSubscription(endpoint);
  res.json({ ok: true });
});

app.get('/api/account/api-token', requireAuth, async (req, res) => {
  res.json({ token: await store.getOrCreateApiToken(req.session.userId) });
});

app.post('/api/account/api-token/regenerate', requireAuth, async (req, res) => {
  res.json({ token: await store.regenerateApiToken(req.session.userId) });
});

async function getGoogleAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('구글 액세스 토큰 갱신 실패: ' + JSON.stringify(data));
  return data.access_token;
}

async function createCalendarEvent(accessToken, event) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`캘린더 일정 추가 실패(${res.status}): ${await res.text()}`);
  return res.json();
}

async function listCalendarEvents(accessToken, timeMin, timeMax) {
  const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '20' });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`캘린더 조회 실패(${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.items || []).map((e) => ({
    title: e.summary || '(제목 없음)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

// 일반 채팅에서도 Gemini가 필요하다고 판단하면 직접 캘린더를 조작할 수 있게 하는 도구 정의.
const CALENDAR_FUNCTION_DECLARATIONS = [
  {
    name: 'create_calendar_event',
    description: '사용자의 구글 캘린더에 새 일정을 추가한다. 사용자가 일정/미팅/약속 추가를 요청할 때 사용한다.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '일정 제목' },
        startDateTime: { type: 'string', description: 'ISO 8601, 예: 2026-08-25T14:00:00+09:00' },
        endDateTime: { type: 'string', description: 'ISO 8601. 시간 언급이 없으면 시작 시각+1시간' },
      },
      required: ['title', 'startDateTime', 'endDateTime'],
    },
  },
  {
    name: 'list_calendar_events',
    description: '사용자의 구글 캘린더에서 특정 기간의 일정을 조회한다. "오늘/내일/이번 주 일정" 같은 질문에 사용한다.',
    parameters: {
      type: 'object',
      properties: {
        startDateTime: { type: 'string', description: '조회 시작, ISO 8601' },
        endDateTime: { type: 'string', description: '조회 끝, ISO 8601' },
      },
      required: ['startDateTime', 'endDateTime'],
    },
  },
];

// 캘린더가 연결된 유저에게만 도구를 제공한다. 실행(execute)은 실제 구글 API를 호출한다.
function buildCalendarToolConfig(user) {
  if (!user?.googleCalendarRefreshToken) return null;
  return {
    tools: [{ functionDeclarations: CALENDAR_FUNCTION_DECLARATIONS }],
    execute: async (name, args) => {
      const accessToken = await getGoogleAccessToken(user.googleCalendarRefreshToken);
      if (name === 'create_calendar_event') {
        if (!args?.title || !args?.startDateTime || !args?.endDateTime) {
          return { error: '제목과 시작/종료 시각이 모두 필요합니다.' };
        }
        await createCalendarEvent(accessToken, {
          summary: args.title,
          start: { dateTime: args.startDateTime },
          end: { dateTime: args.endDateTime },
        });
        return { ok: true };
      }
      if (name === 'list_calendar_events') {
        const events = await listCalendarEvents(accessToken, args?.startDateTime, args?.endDateTime);
        return { events };
      }
      return { error: '알 수 없는 함수 호출입니다.' };
    },
  };
}

const VOICE_EVENT_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'boolean', description: '캘린더 일정 추가 요청으로 이해했는지 여부' },
    title: { type: 'string' },
    startDateTime: { type: 'string', description: 'ISO 8601, 예: 2026-08-25T14:00:00+09:00' },
    endDateTime: { type: 'string', description: 'ISO 8601. 시간 언급이 없으면 시작 시각+1시간' },
    reply: { type: 'string', description: '사용자에게 음성으로 들려줄 한국어 확인/안내 문장 1개' },
  },
  required: ['understood', 'reply'],
};

// 테스트 중 이 조합에서 두 가지 실패를 실제로 관찰했다:
// (1) thinkingConfig 없이 큰 토큰 예산 → 모델이 title 안에서 축하 문구를 무한 반복하다 MAX_TOKENS로 끊김
// (2) thinkingLevel 'minimal' → 내부 혼잣말이 title 필드 안으로 새어 들어감
// thinkingLevel 'low' + temperature 0 + 문장 길이 제한 지시가 가장 안정적이었고,
// 그래도 실패할 수 있으니 아래 파싱 후 검증에서 이상한 결과는 버린다.
async function parseVoiceCommand(text, nowIso) {
  const prompt = `현재 시각은 ${nowIso} (한국 표준시, UTC+9)입니다. 사용자가 음성으로 다음과 같이 말했습니다:\n"${text}"\n\n이 말이 캘린더 일정 추가 요청이면 제목과 시작/종료 시각(ISO 8601, +09:00 포함)을 뽑아내세요. 시간 언급이 없으면 1시간짜리 일정으로 가정하세요. 일정 추가 요청이 아니거나 시각을 특정할 수 없으면 understood를 false로 하고 이유를 reply에 담으세요. title과 reply는 각각 한 문장 이내로 간결하게 작성하세요.`;
  const result = await generateWithFallback({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: VOICE_EVENT_SCHEMA,
      maxOutputTokens: 800,
      temperature: 0,
      thinkingConfig: { thinkingLevel: 'low' },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return { understood: false, reply: '요청을 이해하지 못했습니다. 다시 말씀해주세요.' };
  }

  // 모델이 혼잣말이나 반복 문구를 흘려보낼 수 있어, 비정상적으로 긴 필드는 신뢰하지 않는다.
  if (typeof parsed.title === 'string' && parsed.title.length > 100) parsed.title = parsed.title.slice(0, 100);
  if (typeof parsed.reply === 'string' && parsed.reply.length > 200) parsed.reply = parsed.reply.slice(0, 200);
  if (parsed.startDateTime && Number.isNaN(new Date(parsed.startDateTime).getTime())) {
    return { understood: false, reply: '일정 시각을 정확히 파악하지 못했습니다. 날짜와 시간을 다시 말씀해주세요.' };
  }
  if (parsed.endDateTime && Number.isNaN(new Date(parsed.endDateTime).getTime())) {
    parsed.endDateTime = null;
  }
  return parsed;
}

// 시리 단축어 등 브라우저 세션이 없는 곳에서 개인 토큰(Authorization: Bearer)으로 호출한다.
app.post('/api/voice-command', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
  const user = await store.findUserByApiToken(token);
  if (!user) return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });

  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text가 필요합니다.' });

  if (!user.googleCalendarRefreshToken) {
    return res.status(400).json({ ok: false, reply: '먼저 스펙터 설정에서 구글 캘린더를 연결해주세요.' });
  }

  try {
    const parsed = await parseVoiceCommand(text, new Date().toISOString());
    if (!parsed.understood || !parsed.startDateTime) {
      return res.json({ ok: false, reply: parsed.reply || '무슨 일정인지 이해하지 못했습니다.' });
    }
    const accessToken = await getGoogleAccessToken(user.googleCalendarRefreshToken);
    await createCalendarEvent(accessToken, {
      summary: parsed.title || '새 일정',
      start: { dateTime: parsed.startDateTime },
      end: { dateTime: parsed.endDateTime || parsed.startDateTime },
    });
    res.json({ ok: true, reply: parsed.reply || '일정을 추가했습니다.' });
  } catch (err) {
    console.error('음성 명령 처리 실패:', err);
    store.logAlert('error', `음성 명령 처리 실패: ${(err.message || String(err)).slice(0, 300)}`).catch(() => {});
    res.status(502).json({ ok: false, reply: '일정 추가에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/api/admin/conversations', requireAdmin, async (req, res) => {
  res.json(await store.getAllConversationsWithEmails());
});

app.get('/api/admin/usage', requireAdmin, async (req, res) => {
  res.json(await store.getUsageSummary());
});

app.get('/api/admin/usage-trend', requireAdmin, async (req, res) => {
  res.json(await store.getUsageTrend(14));
});

app.get('/api/admin/alerts', requireAdmin, async (req, res) => {
  res.json(await store.getRecentAlerts(30));
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { category } = req.body || {};
  const conversation = await store.createConversation(req.session.userId, category);
  res.json(conversation);
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  res.json(await store.listConversations(req.session.userId));
});

app.get('/api/conversations/search', requireAuth, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json(await store.listConversations(req.session.userId));
  res.json(await store.searchConversations(req.session.userId, q));
});

app.get('/api/trash', requireAuth, async (req, res) => {
  res.json(await store.listTrash(req.session.userId));
});

app.post('/api/trash/:id/restore', requireAuth, async (req, res) => {
  const conversation = await store.restoreConversation(req.session.userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: '휴지통에서 찾을 수 없습니다.' });
  res.json(conversation);
});

app.delete('/api/trash/:id', requireAuth, async (req, res) => {
  const deleted = await store.permanentlyDeleteConversation(req.session.userId, req.params.id);
  if (!deleted) return res.status(404).json({ error: '휴지통에서 찾을 수 없습니다.' });
  res.json({ ok: true });
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
// toolConfig가 있으면 모델이 함수 호출을 요청할 때 직접 실행하고 결과를 이어붙여 재요청한다
// (최대 3라운드 — 도구를 계속 부르며 무한 루프에 빠지는 걸 방지).
async function streamAndRespond(req, res, contents, systemPrompt, mode, onComplete, toolConfig) {
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });
  res.on('error', () => {
    aborted = true;
  });

  let workingContents = contents;

  try {
    for (let round = 0; round < 3; round++) {
      const stream = await generateStreamWithFallback({
        model: mode.model,
        contents: workingContents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: mode.thinkingLevel },
          ...(toolConfig ? { tools: toolConfig.tools } : {}),
        },
      });

      // 첫 청크를 헤더 커밋 전에 받아본다 — 레이트리밋/키 오류 같은 실패는
      // 보통 여기서 던져지므로, 그 경우엔 기존 JSON 에러 응답을 그대로 쓸 수 있다.
      const iterator = stream[Symbol.asyncIterator]();
      let result = await iterator.next();

      const functionCalls = !result.done && result.value?.functionCalls;
      if (toolConfig && functionCalls?.length) {
        const call = functionCalls[0];
        let toolResult;
        try {
          toolResult = await toolConfig.execute(call.name, call.args);
        } catch (err) {
          toolResult = { error: err.message || String(err) };
        }
        workingContents = [
          ...workingContents,
          { role: 'model', parts: [{ functionCall: call }] },
          { role: 'user', parts: [{ functionResponse: { name: call.name, response: toolResult } }] },
        ];
        continue; // 도구 실행 결과를 들고 다음 라운드에서 실제 답변을 받는다
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (mode.tierName) res.setHeader('X-Specter-Tier', mode.tierName);
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
      return;
    }

    // 라운드를 다 썼는데도 텍스트 응답이 없으면(도구 호출만 반복) 안전하게 끝낸다.
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
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
      store.logAlert('error', `API 키가 유효하지 않습니다: ${err.message?.slice(0, 200)}`).catch(() => {});
      return res.status(401).json({ kind: 'auth', error: 'API 키가 유효하지 않습니다. .env 파일을 확인하세요.' });
    }
    console.error(err);
    store.logAlert('error', `Gemini 호출 실패: ${(err.message || String(err)).slice(0, 300)}`).catch(() => {});
    res.status(502).json({ kind: 'unknown', error: 'Gemini API 호출에 실패했습니다.' });
  }
}

// 자동 메모리: 대화 한 턴에서 앞으로 기억할 만한 사실이 있는지 가장 가벼운 모델로 판단해 저장한다.
// 응답 전송을 막지 않도록 항상 fire-and-forget으로 호출한다.
const MEMORY_EXTRACT_MODEL = 'gemini-3.5-flash-lite';
async function extractMemoryInBackground(userId, userMessage, modelReply, currentMemory) {
  try {
    if (!userMessage || userMessage.length < 40) return; // 너무 짧으면 기억할 내용이 없다고 보고 건너뛴다
    const prompt = `다음은 사용자와 AI의 대화 한 턴입니다. 사용자에 대해 앞으로의 모든 대화에서 항상 참고하면 유용할 "사실이나 선호"가 새로 있으면 한 줄로 요약하고, 없거나 기존 메모리와 중복되면 정확히 "NONE"이라고만 답하세요.\n\n기존 메모리:\n${currentMemory || '(없음)'}\n\n사용자: ${userMessage}\nAI: ${modelReply.slice(0, 500)}`;
    const result = await generateWithFallback({
      model: MEMORY_EXTRACT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 80, thinkingConfig: { thinkingLevel: 'minimal' } },
    });
    const fact = (result.text || '').trim();
    if (!fact || fact.toUpperCase().startsWith('NONE')) return;

    const settings = await store.getSettings(userId);
    let updated = settings.memory ? `${settings.memory}\n- ${fact}` : `- ${fact}`;
    if (updated.length > MAX_MEMORY_LENGTH) {
      const lines = updated.split('\n');
      while (lines.join('\n').length > MAX_MEMORY_LENGTH && lines.length > 1) lines.shift();
      updated = lines.join('\n');
    }
    await store.updateSettings(userId, { memory: updated });
  } catch (err) {
    console.error('자동 메모리 추출 실패:', err.message);
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
  const mode = resolveMode(settings.performanceMode, {
    textLength: message.length,
    hasAttachments: !!attachments?.length,
    turnCount: conversation.turns.length,
  });
  const user = await store.findUserById(req.session.userId);
  const toolConfig = buildCalendarToolConfig(user);
  const timeContext = `\n\n현재 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 표준시)`;
  const systemPrompt =
    buildSystemPrompt(settings.pushbackIntensity, settings.memory) +
    (toolConfig ? timeContext + '\n캘린더 도구를 쓸 수 있습니다. 일정 추가/조회 요청이면 반드시 도구를 사용하세요.' : '');
  const contents = toGeminiContents(compactHistory([...conversation.turns, { role: 'user', content: message, attachments }]));

  await streamAndRespond(
    req,
    res,
    contents,
    systemPrompt,
    mode,
    async (fullText, totalTokens) => {
      await store.appendTurn(req.session.userId, conversationId, 'user', message, attachments);
      await store.appendTurn(req.session.userId, conversationId, 'model', fullText, undefined, totalTokens);
      if (settings.autoMemory) extractMemoryInBackground(req.session.userId, message, fullText, settings.memory);
    },
    toolConfig
  );
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
  const mode = resolveMode(settings.performanceMode, {
    textLength: lastTurn.content?.length || 0,
    hasAttachments: !!lastTurn.attachments?.length,
    turnCount: conversation.turns.length,
  });
  const user = await store.findUserById(req.session.userId);
  const toolConfig = buildCalendarToolConfig(user);
  const timeContext = `\n\n현재 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 표준시)`;
  const systemPrompt =
    buildSystemPrompt(settings.pushbackIntensity, settings.memory) +
    (toolConfig ? timeContext + '\n캘린더 도구를 쓸 수 있습니다. 일정 추가/조회 요청이면 반드시 도구를 사용하세요.' : '');
  const contents = toGeminiContents(compactHistory(conversation.turns));

  await streamAndRespond(
    req,
    res,
    contents,
    systemPrompt,
    mode,
    async (fullText, totalTokens) => {
      await store.appendTurn(req.session.userId, conversationId, 'model', fullText, undefined, totalTokens);
    },
    toolConfig
  );
});

// 5분마다 캘린더를 연결하고 알림도 구독한 유저들의 15~20분 뒤 일정을 확인해 푸시를 보낸다.
// 재시작해도 중복 알림이 안 가도록 알림 여부는 DB(notified_events)에 남긴다.
async function checkUpcomingEventsAndNotify() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const users = await store.getUsersWithCalendarAndPush();
    const now = Date.now();
    const windowStart = new Date(now + 15 * 60 * 1000).toISOString();
    const windowEnd = new Date(now + 20 * 60 * 1000).toISOString();
    for (const u of users) {
      try {
        const accessToken = await getGoogleAccessToken(u.googleCalendarRefreshToken);
        const events = await listCalendarEvents(accessToken, windowStart, windowEnd);
        for (const event of events) {
          const eventId = `${u.userId}:${event.start}:${event.title}`;
          if (await store.wasEventNotified(eventId)) continue;
          const payload = JSON.stringify({
            title: 'Specter 일정 알림',
            body: `곧 시작: ${event.title} (${new Date(event.start).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })})`,
          });
          for (const sub of u.subscriptions) {
            try {
              await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
            } catch (err) {
              if (err.statusCode === 404 || err.statusCode === 410) await store.deletePushSubscription(sub.endpoint);
            }
          }
          await store.markEventNotified(eventId);
        }
      } catch (err) {
        console.error(`유저 ${u.userId} 일정 알림 확인 실패:`, err.message);
      }
    }
  } catch (err) {
    console.error('일정 알림 스케줄러 실패:', err);
  }
}
setInterval(checkUpcomingEventsAndNotify, 5 * 60 * 1000);

// 라우트 안에서 next(err)로 넘어온(또는 위 자동 래핑이 잡아낸) 오류를 여기서 한 곳에서 처리한다.
// 요청이 영원히 멈추는 대신 항상 깨끗한 JSON 응답을 받게 한다.
app.use((err, req, res, next) => {
  console.error('처리되지 않은 라우트 오류:', err);
  store.logAlert('error', `라우트 오류(${req.method} ${req.path}): ${(err?.message || String(err)).slice(0, 300)}`).catch(() => {});
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '서버에서 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
});

app.listen(PORT, () => {
  console.log(`Specter가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
