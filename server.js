require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { GoogleGenAI, ApiError } = require('@google/genai');
const { buildSystemPrompt, PERSONA_PROMPTS, PERSONA_LABELS } = require('./system-prompt');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
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

// 개인용 앱(테스트 모드, 사용자 100명 미만)은 구글 인증 심사 없이 민감/제한 범위를
// 그대로 쓸 수 있어서, 캘린더뿐 아니라 Gmail/Drive/할 일까지 한 번의 동의로 같이 받는다 —
// 이 refresh_token 하나가 아래 모든 범위를 다 포함한다(DB 컬럼명은 예전 이름 그대로 둠).
// gmail.readonly와 drive(전체)는 "제한(restricted)" 등급이라 유료 보안감사(CASA)
// 없이는 테스트 사용자 화이트리스트를 벗어날 수 없다 — 대신 "민감(sensitive)" 등급까지만
// 요청해서, 무료로 며칠 안에 끝나는 가벼운 심사만으로 전체 공개(테스트 사용자 등록 불필요)를
// 받을 수 있게 한다. 그 대가로 메일함 전체 검색/읽기와 Drive 전체 검색은 뺐다 — 발송·캘린더·
// 할 일은 그대로 유지된다. Drive를 다시 넣으려면 drive.file(비민감, 파일 피커로 사용자가
// 직접 고른 파일만) 스코프 + 피커 UI를 새로 만들거나, 유료 CASA를 받아야 한다.
const GOOGLE_ASSISTANT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

// 예전엔 로그인(openid email profile)과 개인비서 연동(캘린더 등)이 완전히 분리돼 있어서,
// "구글로 로그인"한 사람도 설정 화면까지 따로 찾아가 한 번 더 동의해야 연동이 됐다 —
// 실제로 그렇게 하는 사람이 거의 없어 사실상 아무도 개인비서 기능을 못 쓰는 것과 같았다.
// 이제 로그인 단계에서 같이 동의를 받는다: 첫 로그인이면 구글이 동의 화면을 보여주고
// (그래야 법적으로 유효한 동의라) refresh_token도 이때 같이 내려준다. 이미 동의한
// 적이 있는 재로그인이면 동의 화면 없이 조용히 넘어간다(매번 다시 물어보면 성가시다).
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.redirect('/login.html?error=google_not_configured');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: `${GOOGLE_ASSISTANT_SCOPES} profile`,
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// 설정에서 직접 (재)연결할 때 쓰는 경로 — 로그인 없이 이미 세션이 있는 상태에서
// 호출되므로 항상 동의 화면을 강제한다(prompt=consent), 매번 새 refresh_token을 받기 위함.
// 콜백 주소는 로그인 플로우와 그대로 공유한다 — state로 어느 흐름인지 구분해서 구글
// 클라우드 콘솔에 리디렉션 URI를 추가로 등록할 필요가 없게 했다.
app.get('/auth/google-calendar/connect', requireAuth, (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.redirect('/settings.html?calendar=not_configured');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_ASSISTANT_SCOPES,
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
    // 첫 로그인(또는 재동의)이라 구글이 refresh_token을 같이 내려줬다면, 로그인과 동시에
    // 캘린더·Gmail·Drive·할 일 연동까지 끝난 것 — 설정에 따로 안 들어가도 된다.
    if (tokenData.refresh_token) {
      await store.saveGoogleCalendarToken(user.id, tokenData.refresh_token);
    }
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

const OFFICE_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
];

// base64 문자열 길이로 원본 바이트 크기를 역산해 개수/용량 제한을 검증한다.
function validateAttachments(attachments) {
  if (attachments === undefined) return null;
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    return `첨부파일은 최대 ${MAX_ATTACHMENTS}개까지 가능합니다.`;
  }
  for (const a of attachments) {
    const isImage = a && typeof a.mimeType === 'string' && a.mimeType.startsWith('image/');
    const isPdf = a && a.mimeType === 'application/pdf';
    const isOffice = a && OFFICE_MIME_TYPES.includes(a.mimeType);
    if (!a || typeof a.data !== 'string' || !(isImage || isPdf || isOffice)) {
      return '첨부파일 형식이 올바르지 않습니다. 이미지, PDF, Excel(.xlsx), Word(.docx), CSV만 가능합니다.';
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
  store.logAudit(user.id, 'password_changed', user.email).catch((err) => console.error('감사 로그 기록 실패:', err.message));
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

// 홈 화면 위젯은 PWA로 만들 수 없어서, 그 대신 앱을 열자마자 오늘 일정+할 일이 바로
// 보이게 하는 용도(+ 아이콘 배지 숫자 계산)로 쓰는 엔드포인트.
app.get('/api/today', requireAuth, async (req, res) => {
  const user = await store.findUserById(req.session.userId);
  if (!user?.googleCalendarRefreshToken) return res.json({ connected: false, events: [], tasks: [] });
  try {
    const accessToken = await getGoogleAccessToken(user.googleCalendarRefreshToken);
    const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const dayStart = new Date(kst);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(kst);
    dayEnd.setHours(23, 59, 59, 999);
    const [events, tasks] = await Promise.all([
      listCalendarEvents(accessToken, dayStart.toISOString(), dayEnd.toISOString()),
      listTasks(accessToken).catch(() => []),
    ]);
    res.json({ connected: true, events, tasks });
  } catch (err) {
    console.error('오늘 일정/할 일 조회 실패:', err.message);
    res.json({ connected: true, events: [], tasks: [], error: '조회에 실패했습니다.' });
  }
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

// ---- Gmail ----
// 메일 검색/읽기(gmail.readonly)는 "제한(restricted)" 등급이라 뺐다 — 발송(gmail.send)은
// "민감(sensitive)" 등급이라 유지한다. 자세한 이유는 GOOGLE_ASSISTANT_SCOPES 주석 참고.

async function sendGmailMessage(accessToken, { to, subject, body }) {
  // to는 헤더 줄에 그대로 들어가므로, 개행이 섞여 들어오면(모델이 프롬프트 인젝션에 낚여
  // 이상한 값을 넣는 경우 등) 헤더 인젝션(예: 임의 Bcc 추가)으로 이어질 수 있다 — 제거한다.
  // subject는 base64 인코딩되므로(MIME encoded-word) 개행이 섞여도 안전하다.
  const safeTo = String(to).replace(/[\r\n]/g, '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeTo)) throw new Error('받는 사람 이메일 주소가 올바르지 않습니다.');
  const raw = [
    `To: ${safeTo}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');
  const encoded = Buffer.from(raw, 'utf-8').toString('base64url');
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) throw new Error(`메일 발송 실패(${res.status}): ${await res.text()}`);
  return res.json();
}

// ---- Google Tasks ----

async function listTasks(accessToken) {
  const res = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=false&maxResults=50', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`할 일 조회 실패(${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.items || []).map((t) => ({ id: t.id, title: t.title, notes: t.notes || '', due: t.due || null, status: t.status }));
}

async function createTask(accessToken, { title, notes, due }) {
  const res = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, notes, due }),
  });
  if (!res.ok) throw new Error(`할 일 추가 실패(${res.status}): ${await res.text()}`);
  return res.json();
}

async function completeTask(accessToken, taskId) {
  const res = await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' }),
  });
  if (!res.ok) throw new Error(`할 일 완료 처리 실패(${res.status}): ${await res.text()}`);
  return res.json();
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
  {
    name: 'send_email',
    description: '사용자를 대신해 이메일을 발송한다. 사용자가 명시적으로 메일 발송/답장을 요청했을 때만 사용한다.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '받는 사람 이메일 주소' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'list_tasks',
    description: '사용자의 Google Tasks(할 일 목록)에서 아직 완료하지 않은 할 일을 조회한다. "오늘 할 일 뭐 있어?" 같은 요청에 사용한다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_task',
    description: '새 할 일을 Google Tasks에 추가한다.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string', description: '메모(선택)' },
        due: { type: 'string', description: 'ISO 8601 날짜(선택), 예: 2026-08-28T00:00:00.000Z' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    description: 'list_tasks로 찾은 할 일 ID를 완료 처리한다.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'list_tasks 결과의 id' } },
      required: ['taskId'],
    },
  },
];

// 구글 검색은 모든 유저에게 항상 제공하고(모델이 알아서 검색해 텍스트로 답한다 — 우리가
// 실행할 필요 없음), 캘린더 도구는 연결한 유저에게만 추가한다.
// 참고: 검색 도구와 커스텀 함수 도구를 한 요청에 같이 넣는 조합은 오늘 API 할당량 문제로
// 라이브 검증을 못 했다 — 혹시 API가 이 조합을 거부하면 기존 에러 처리 경로(관리자 알림)로 잡힌다.
// 이 계정/티어에서는 googleSearch 그라운딩 전용 할당량이 일반 생성 할당량과 별도이고
// 계속 소진 상태다(실측: 도구 없이는 성공, googleSearch를 붙이면 매번 429). 검색이 꼭
// 필요하지 않은 메시지까지 매번 이 할당량에 걸려 통째로 실패하지 않도록, 429가 나면
// 검색 도구만 빼고 한 번 더 시도한다.
function hasSearchTool(toolConfig) {
  return !!toolConfig?.tools?.some((t) => t.googleSearch);
}
function stripSearchTool(toolConfig) {
  if (!toolConfig) return toolConfig;
  const tools = toolConfig.tools.filter((t) => !t.googleSearch);
  return tools.length ? { ...toolConfig, tools } : null;
}

function buildToolConfig(user) {
  const tools = [{ googleSearch: {} }];
  if (!user?.googleCalendarRefreshToken) return { tools, execute: null };
  tools.push({ functionDeclarations: CALENDAR_FUNCTION_DECLARATIONS });
  return {
    tools,
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
      if (name === 'send_email') {
        if (!args?.to || !args?.subject || !args?.body) return { error: 'to, subject, body가 모두 필요합니다.' };
        await sendGmailMessage(accessToken, args);
        return { ok: true };
      }
      if (name === 'list_tasks') {
        const tasks = await listTasks(accessToken);
        return { tasks };
      }
      if (name === 'create_task') {
        if (!args?.title) return { error: 'title이 필요합니다.' };
        await createTask(accessToken, args);
        return { ok: true };
      }
      if (name === 'complete_task') {
        if (!args?.taskId) return { error: 'taskId가 필요합니다.' };
        await completeTask(accessToken, args.taskId);
        return { ok: true };
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

app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  res.json(await store.getRecentAuditLog(50));
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
  store.logAudit(req.session.userId, 'conversation_permanently_deleted', req.params.id).catch((err) => console.error('감사 로그 기록 실패:', err.message));
  res.json({ ok: true });
});

app.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const owned = await store.getConversation(req.session.userId, req.params.id);
  if (owned) return res.json(owned);
  // 소유자가 아니면 나에게 공유된 프로젝트인지 확인한다(읽기 전용).
  const shared = await store.getSharedConversation(req.session.userId, req.params.id);
  if (!shared) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json({ ...shared, readOnly: true });
});

async function getExportableConversation(userId, conversationId) {
  const owned = await store.getConversation(userId, conversationId);
  if (owned) return owned;
  return store.getSharedConversation(userId, conversationId);
}

const EXPORT_ROLE_LABEL = { user: '사용자', model: 'Specter' };

// Word(.docx)는 클라이언트 프로그램이 열 때 문자에 맞는 폰트로 자동 대체하므로 한글이 별도
// 폰트 임베딩 없이도 정상적으로 보인다. PDF는 pdfkit의 기본 14개 폰트가 라틴 문자 전용이라
// 한글 임베딩용 폰트 파일을 따로 번들해야 해서, PDF는 대신 브라우저 인쇄 기능으로 처리한다
// (아래 /api/conversations/:id/export 는 markdown/docx만 서버에서 만든다).
app.get('/api/conversations/:id/export/docx', requireAuth, async (req, res) => {
  const conversation = await getExportableConversation(req.session.userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });

  const children = [new Paragraph({ text: conversation.title, heading: HeadingLevel.HEADING_1 })];
  for (const t of conversation.turns) {
    children.push(new Paragraph({ text: EXPORT_ROLE_LABEL[t.role] || t.role, heading: HeadingLevel.HEADING_2 }));
    const lines = (t.content || '').split('\n');
    for (const line of lines) {
      children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="specter-export.docx"');
  res.send(buffer);
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

const MAX_INSTRUCTIONS_LENGTH = 4000;
const VALID_PERSONAS = ['general', 'finance', 'legal', 'marketing'];

app.patch('/api/conversations/:id/instructions', requireAuth, async (req, res) => {
  const { instructions } = req.body || {};
  if (typeof instructions === 'string' && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return res.status(400).json({ error: `지침은 ${MAX_INSTRUCTIONS_LENGTH}자 이하로 입력하세요.` });
  }
  const conversation = await store.setConversationInstructions(req.session.userId, req.params.id, instructions);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(conversation);
});

app.patch('/api/conversations/:id/persona', requireAuth, async (req, res) => {
  const { persona } = req.body || {};
  if (persona && !VALID_PERSONAS.includes(persona)) {
    return res.status(400).json({ error: '알 수 없는 역할입니다.' });
  }
  const conversation = await store.setConversationPersona(req.session.userId, req.params.id, persona === 'general' ? null : persona);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(conversation);
});

app.get('/api/personas', requireAuth, (req, res) => {
  res.json(Object.entries(PERSONA_LABELS).map(([value, label]) => ({ value, label })));
});

// ---- 프로젝트별 지식 베이스 ----

const MAX_KNOWLEDGE_FILES = 10;
const MAX_KNOWLEDGE_FILE_BYTES = 15 * 1024 * 1024;
const KNOWLEDGE_MIME_TYPES = ['application/pdf', 'text/plain', ...OFFICE_MIME_TYPES];

app.post('/api/conversations/:id/knowledge', requireAuth, async (req, res) => {
  const { name, mimeType, data } = req.body || {};
  if (!name || typeof data !== 'string' || !KNOWLEDGE_MIME_TYPES.includes(mimeType)) {
    return res.status(400).json({ error: '파일 이름, 형식, 데이터가 필요합니다. (PDF, 텍스트, Excel, Word, CSV만 가능)' });
  }
  if (data.length * 0.75 > MAX_KNOWLEDGE_FILE_BYTES) {
    return res.status(400).json({ error: '파일은 15MB 이하만 가능합니다.' });
  }
  // listKnowledgeFiles는 소유자 확인을 하지 않으므로, 먼저 소유권을 확인한 뒤에만 호출한다.
  const conversation = await store.getConversation(req.session.userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  const existing = await store.listKnowledgeFiles(req.params.id);
  if (existing.length >= MAX_KNOWLEDGE_FILES) {
    return res.status(400).json({ error: `프로젝트당 참고 자료는 최대 ${MAX_KNOWLEDGE_FILES}개까지 가능합니다.` });
  }
  let finalMime = mimeType;
  let finalData = data;
  if (OFFICE_MIME_TYPES.includes(mimeType)) {
    const [converted] = await extractOfficeAttachments([{ mimeType, data, name }]);
    finalMime = converted.mimeType;
    finalData = converted.data;
  }
  const file = await store.addKnowledgeFile(req.session.userId, req.params.id, name, finalMime, finalData);
  if (!file) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(file);
});

app.get('/api/conversations/:id/knowledge', requireAuth, async (req, res) => {
  const conversation = await store.getConversation(req.session.userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  const files = await store.listKnowledgeFiles(req.params.id);
  res.json(files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, createdAt: f.createdAt })));
});

app.delete('/api/conversations/:id/knowledge/:fileId', requireAuth, async (req, res) => {
  const ok = await store.deleteKnowledgeFile(req.session.userId, req.params.id, req.params.fileId);
  if (!ok) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.json({ ok: true });
});

// ---- 대화 공유 ----

app.post('/api/conversations/:id/share', requireAuth, async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email이 필요합니다.' });
  const target = email.trim().toLowerCase();
  const result = await store.shareConversation(req.session.userId, req.params.id, target);
  if (result.error) return res.status(400).json({ error: result.error });
  store.logAudit(req.session.userId, 'conversation_shared', `${req.params.id} -> ${target}`).catch((err) => console.error('감사 로그 기록 실패:', err.message));
  res.json(result);
});

app.get('/api/conversations/:id/shares', requireAuth, async (req, res) => {
  const shares = await store.getConversationShares(req.session.userId, req.params.id);
  if (shares === null) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(shares);
});

app.delete('/api/conversations/:id/share/:userId', requireAuth, async (req, res) => {
  const ok = await store.unshareConversation(req.session.userId, req.params.id, req.params.userId);
  if (!ok) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  store.logAudit(req.session.userId, 'conversation_unshared', `${req.params.id} -> ${req.params.userId}`).catch((err) => console.error('감사 로그 기록 실패:', err.message));
  res.json({ ok: true });
});

app.get('/api/shared-with-me', requireAuth, async (req, res) => {
  res.json(await store.listSharedWithMe(req.session.userId));
});

// ---- 프롬프트 템플릿 ----

app.get('/api/templates', requireAuth, async (req, res) => {
  res.json(await store.listPromptTemplates());
});

app.post('/api/admin/templates', requireAuth, requireAdmin, async (req, res) => {
  const { title, content } = req.body || {};
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'title과 content가 필요합니다.' });
  }
  const template = await store.createPromptTemplate(req.session.userId, title.trim().slice(0, 100), content.trim().slice(0, 4000));
  store.logAudit(req.session.userId, 'template_created', template.title).catch((err) => console.error('감사 로그 기록 실패:', err.message));
  res.json(template);
});

app.delete('/api/admin/templates/:id', requireAuth, requireAdmin, async (req, res) => {
  const ok = await store.deletePromptTemplate(req.params.id);
  if (!ok) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
  store.logAudit(req.session.userId, 'template_deleted', String(req.params.id)).catch((err) => console.error('감사 로그 기록 실패:', err.message));
  res.json({ ok: true });
});

// ---- 본인 사용량 ----

app.get('/api/usage/me', requireAuth, async (req, res) => {
  const [mine, recentUser, recentOrg] = await Promise.all([
    store.getMyUsage(req.session.userId),
    store.getRecentUserTokenUsage(req.session.userId, 24),
    store.getRecentOrgTokenUsage(24),
  ]);
  res.json({ ...mine, recentUserTokens: recentUser, recentOrgTokens: recentOrg, dailyCap: DAILY_TOKEN_CAP_PER_USER });
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

// 조직 전체가 Gemini 무료 할당량을 키 하나로 공유하기 때문에, 한 사람이 몰아 쓰면 나머지
// 팀원 전체가 막힌다. DAILY_TOKEN_CAP_PER_USER(선택, 미설정 시 제한 없음)로 최근 24시간 개인
// 사용량에 소프트 캡을 둬서 최소한 한 사람이 전체 할당량을 다 써버리는 것은 막는다.
// "0"으로 완전히 차단하고 싶을 수도 있으므로 falsy(0) 체크가 아니라 undefined/빈 문자열/NaN만 걸러낸다.
const DAILY_TOKEN_CAP_PER_USER =
  process.env.DAILY_TOKEN_CAP_PER_USER !== undefined && process.env.DAILY_TOKEN_CAP_PER_USER !== ''
    ? parseInt(process.env.DAILY_TOKEN_CAP_PER_USER, 10)
    : null;

async function checkDailyCap(userId) {
  if (DAILY_TOKEN_CAP_PER_USER === null || Number.isNaN(DAILY_TOKEN_CAP_PER_USER)) return null;
  const used = await store.getRecentUserTokenUsage(userId, 24);
  if (used >= DAILY_TOKEN_CAP_PER_USER) {
    return '최근 24시간 개인 사용량 한도에 도달했습니다. 무료 할당량을 팀 전체가 함께 쓰고 있어 한 사람이 다 쓰지 않도록 두는 제한입니다. 시간이 지나면 다시 사용할 수 있습니다.';
  }
  return null;
}

// 기본 시스템 프롬프트 + 프로젝트별 페르소나/커스텀 지침 + 현재 시각(검색 결과의 날짜 판단에 필요) +
// (연결된 경우) 캘린더 도구 안내를 합쳐 최종 시스템 프롬프트를 만든다.
function buildFullSystemPrompt(settings, conversation, toolConfig) {
  let prompt = buildSystemPrompt(settings.pushbackIntensity, settings.memory);
  if (conversation.persona && PERSONA_PROMPTS[conversation.persona]) {
    prompt += `\n\n${PERSONA_PROMPTS[conversation.persona]}`;
  }
  if (conversation.instructions && conversation.instructions.trim()) {
    prompt += `\n\n## 이 프로젝트만의 지침\n${conversation.instructions.trim()}`;
  }
  const timeContext = `현재 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 표준시)`;
  prompt += `\n\n${timeContext}\n필요하면 구글 검색 도구로 최신 정보를 확인한 뒤 답하세요.`;
  if (toolConfig?.execute) {
    prompt +=
      '\n캘린더·Gmail 발송·할 일(Tasks) 도구를 쓸 수 있습니다. 일정 추가/조회, 메일 발송, 할 일 조회/추가/완료 요청이면 반드시 해당 도구를 사용하세요. ' +
      '메일 발송처럼 되돌리기 어려운 조치는 사용자가 명시적으로 요청했을 때만 실행하고, 받는 사람·제목·내용을 요청 내용과 다르게 지어내지 마세요. ' +
      '사용자가 받는사람/제목/내용을 이미 다 알려줬다면 바로 send_email을 호출하세요. 메일을 읽거나 검색하는 기능은 없으니, 요청받으면 없다고 안내하세요.';
  }
  return prompt;
}

// 프로젝트에 등록된 지식 베이스 파일들을 대화 맨 앞에 (참고자료 제시 → 확인 응답) 형태의
// 합성 턴 한 쌍으로 끼워 넣는다. 매 요청마다 다시 전송되므로 토큰 비용이 들지만, Gemini에는
// 요청 간 지속되는 서버 측 컨텍스트가 없어 이 방식이 가장 단순하고 확실하다.
async function buildKnowledgeContents(conversationId) {
  const files = await store.listKnowledgeFiles(conversationId);
  if (!files.length) return [];
  const parts = [{ text: '다음은 이 프로젝트의 참고 자료입니다. 답변할 때 항상 참고하세요.' }];
  for (const f of files) {
    parts.push({ inlineData: { data: f.data, mimeType: f.mimeType } });
  }
  return [
    { role: 'user', parts },
    { role: 'model', parts: [{ text: '참고 자료를 확인했습니다.' }] },
  ];
}

// Gemini 멀티모달이 직접 이해하지 못하는 오피스 문서(xlsx/docx)를 서버에서 텍스트로 뽑아
// mimeType: text/plain 첨부로 바꿔치기한다. 이미지/PDF는 그대로 둔다.
async function extractOfficeAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return attachments;
  const result = [];
  for (const a of attachments) {
    if (a.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || a.mimeType === 'text/csv') {
      const buf = Buffer.from(a.data, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const text = wb.SheetNames.map((name) => `[시트: ${name}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`).join('\n\n');
      result.push({ mimeType: 'text/plain', data: Buffer.from(text, 'utf-8').toString('base64'), name: a.name });
    } else if (a.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const buf = Buffer.from(a.data, 'base64');
      const { value } = await mammoth.extractRawText({ buffer: buf });
      result.push({ mimeType: 'text/plain', data: Buffer.from(value, 'utf-8').toString('base64'), name: a.name });
    } else {
      result.push(a);
    }
  }
  return result;
}

// 스트리밍 도중 에러가 나면 @google/genai SDK가 err.message 앞에 "got status: X. "를 붙여서
// 순수 JSON이 아니게 만든다(최초 HTTP 응답 자체가 실패할 때만 순수 JSON). 첫 '{' 이후부터
// 파싱하면 두 경우 모두 처리된다.
function parseGeminiErrorJson(err) {
  const start = err.message.indexOf('{');
  if (start === -1) throw new Error('에러 메시지에 JSON이 없습니다.');
  return JSON.parse(err.message.slice(start));
}

// Gemini는 잘못된 키를 401이 아니라 400(INVALID_ARGUMENT)으로 반환하고,
// 세부 사유는 message에 담긴 raw JSON 안의 details[].reason에 들어있다.
function isInvalidApiKey(err) {
  try {
    const parsed = parseGeminiErrorJson(err);
    return parsed?.error?.details?.some((d) => d.reason === 'API_KEY_INVALID');
  } catch {
    return false;
  }
}

// 429 응답의 세부 정보(QuotaFailure의 quotaId, RetryInfo의 retryDelay)를 읽어 분당 제한인지
// 일일 제한인지 구분한다. 일일 제한은 몇 초 뒤 재시도해봐야 또 실패하므로 안내 문구를 다르게 한다.
// 구조를 못 읽으면 안전하게 "분당 제한, 30초 후 재시도"로 취급한다.
function parseQuotaError(err) {
  try {
    const parsed = parseGeminiErrorJson(err);
    const details = parsed?.error?.details || [];
    const quotaId = details.find((d) => d['@type']?.includes('QuotaFailure'))?.violations?.[0]?.quotaId || '';
    const retryDelay = details.find((d) => d['@type']?.includes('RetryInfo'))?.retryDelay || '';
    const retryMatch = /^(\d+)s$/.exec(retryDelay);
    return {
      isDaily: /day/i.test(quotaId),
      retryAfterSeconds: retryMatch ? parseInt(retryMatch[1], 10) : 30,
    };
  } catch {
    return { isDaily: false, retryAfterSeconds: 30 };
  }
}

// checkDailyCap과 streamAndRespond의 catch 블록 양쪽에서 "일일 한도 초과" 429 응답을 조립하므로,
// 응답 형태가 두 곳에서 따로 드리프트하지 않도록 한 곳에 모아둔다.
function dailyQuotaResponse(message) {
  return { kind: 'rate_limit', daily: true, error: message };
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

  // 도구 호출 라운드 + 실제 스트리밍까지 한 번의 시도를 담당한다. 성공하면 응답을 끝까지
  // 쓰고 리턴하고, 실패하면 던진다 — 상위에서 검색 도구를 뺀 재시도 여부를 판단한다.
  async function runGeneration(activeToolConfig) {
    let workingContents = contents;
    for (let round = 0; round < 3; round++) {
      const stream = await generateStreamWithFallback({
        model: mode.model,
        contents: workingContents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: mode.thinkingLevel },
          ...(activeToolConfig ? { tools: activeToolConfig.tools } : {}),
        },
      });

      // 첫 청크를 헤더 커밋 전에 받아본다 — 레이트리밋/키 오류 같은 실패는
      // 보통 여기서 던져지므로, 그 경우엔 기존 JSON 에러 응답을 그대로 쓸 수 있다.
      const iterator = stream[Symbol.asyncIterator]();
      let result = await iterator.next();

      const functionCalls = !result.done && result.value?.functionCalls;
      if (activeToolConfig && functionCalls?.length) {
        const call = functionCalls[0];
        let toolResult;
        try {
          toolResult = await activeToolConfig.execute(call.name, call.args);
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
  }

  try {
    try {
      await runGeneration(toolConfig);
    } catch (err) {
      // 이 계정은 googleSearch 그라운딩 전용 할당량이 별도로 소진돼 있어(일반 생성은 멀쩡),
      // 검색 도구가 붙은 요청만 계속 429가 난다. 아직 아무것도 안 보낸 상태라면(스트리밍
      // 시작 전) 검색 도구만 빼고 한 번 더 시도해서, 검색이 꼭 필요하지 않은 메시지까지
      // 매번 막히지 않게 한다.
      if (!res.headersSent && err instanceof ApiError && err.status === 429 && hasSearchTool(toolConfig)) {
        await runGeneration(stripSearchTool(toolConfig));
        return;
      }
      throw err;
    }
  } catch (err) {
    if (res.headersSent) {
      // 스트리밍이 이미 시작된 뒤라 일반 텍스트만 보낼 수 있다 — 여기서 끊는다.
      res.end();
      return;
    }
    if (err instanceof ApiError && err.status === 429) {
      const quota = parseQuotaError(err);
      if (quota.isDaily) {
        // 일일 한도는 몇 초 뒤 재시도해도 다시 실패한다 — 카운트다운 대신 정직하게 안내한다.
        return res.status(429).json(
          dailyQuotaResponse(
            '오늘 무료 사용량 한도에 도달했습니다. 이 한도는 조직 전체가 하나의 계정으로 공유하고 있어 다른 팀원의 사용량에도 영향을 받습니다. 하루 단위로 초기화되니 몇 시간 뒤 다시 시도해주세요.'
          )
        );
      }
      return res.status(429).json({
        kind: 'rate_limit',
        retryAfterSeconds: quota.retryAfterSeconds,
        error: '요청이 몰려 잠시 제한되었습니다. 곧 자동으로 다시 시도할 수 있습니다.',
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
  const { conversationId, attachments: rawAttachments } = req.body || {};
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const attachmentError = validateAttachments(rawAttachments);
  if (!conversationId || (!message && !rawAttachments?.length)) {
    return res.status(400).json({ error: 'conversationId와 message 또는 attachments가 필요합니다.' });
  }
  if (attachmentError) {
    return res.status(400).json({ error: attachmentError });
  }
  const conversation = await store.getConversation(req.session.userId, conversationId);
  if (!conversation) {
    return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  }
  const capError = await checkDailyCap(req.session.userId);
  if (capError) return res.status(429).json(dailyQuotaResponse(capError));
  // 저장은 원본 첨부(엑셀/워드 원본 등)로 하고, Gemini에 보낼 때만 추출된 텍스트로 바꾼다.
  const attachments = await extractOfficeAttachments(rawAttachments);

  const settings = await store.getSettings(req.session.userId);
  const mode = resolveMode(settings.performanceMode, {
    textLength: message.length,
    hasAttachments: !!attachments?.length,
    turnCount: conversation.turns.length,
  });
  const user = await store.findUserById(req.session.userId);
  const toolConfig = buildToolConfig(user);
  const systemPrompt = buildFullSystemPrompt(settings, conversation, toolConfig);
  const knowledgeContents = await buildKnowledgeContents(conversationId);
  const contents = [
    ...knowledgeContents,
    ...toGeminiContents(compactHistory([...conversation.turns, { role: 'user', content: message, attachments }])),
  ];

  await streamAndRespond(
    req,
    res,
    contents,
    systemPrompt,
    mode,
    async (fullText, totalTokens) => {
      await store.appendTurn(req.session.userId, conversationId, 'user', message, rawAttachments);
      await store.appendTurn(req.session.userId, conversationId, 'model', fullText, undefined, totalTokens);
      if (settings.autoMemory) extractMemoryInBackground(req.session.userId, message, fullText, settings.memory);
    },
    toolConfig
  );
});

// 마지막 응답을 다시 받는다. 마지막 턴이 이미 모델 응답이면(같은 자리를 다시 재생성) 기존 응답을
// 지우지 않고 브랜치로 보관한 뒤 새 응답을 같은 자리의 대안으로 추가한다(대화 브랜칭).
// 마지막 턴이 사용자 메시지면(먼저 /rewind로 지운 뒤 호출하는 이전 방식) 예전처럼 새 응답만 추가한다.
app.post('/api/chat/regenerate', requireAuth, async (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId가 필요합니다.' });
  const conversation = await store.getConversation(req.session.userId, conversationId);
  if (!conversation) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  const capError = await checkDailyCap(req.session.userId);
  if (capError) return res.status(429).json(dailyQuotaResponse(capError));

  const lastTurn = conversation.turns[conversation.turns.length - 1];
  let branchGroup = null;
  let promptTurn = lastTurn;
  if (lastTurn && lastTurn.role === 'model') {
    const archived = await store.archiveLastModelTurn(req.session.userId, conversationId);
    if (!archived) return res.status(400).json({ error: '재생성할 응답이 없습니다.' });
    branchGroup = archived.branchGroup;
    promptTurn = conversation.turns[conversation.turns.length - 2];
  } else if (!lastTurn || lastTurn.role !== 'user') {
    return res.status(400).json({ error: '재생성할 응답이 없습니다.' });
  }

  const settings = await store.getSettings(req.session.userId);
  const mode = resolveMode(settings.performanceMode, {
    textLength: promptTurn?.content?.length || 0,
    hasAttachments: !!promptTurn?.attachments?.length,
    turnCount: conversation.turns.length,
  });
  const user = await store.findUserById(req.session.userId);
  const toolConfig = buildToolConfig(user);
  const systemPrompt = buildFullSystemPrompt(settings, conversation, toolConfig);
  const knowledgeContents = await buildKnowledgeContents(conversationId);
  // 방금 브랜치로 보관 처리한 이전 모델 답변은 다시 보내는 히스토리에서 제외한다.
  const historyTurns = branchGroup ? conversation.turns.slice(0, -1) : conversation.turns;
  const contents = [...knowledgeContents, ...toGeminiContents(compactHistory(historyTurns))];

  await streamAndRespond(
    req,
    res,
    contents,
    systemPrompt,
    mode,
    async (fullText, totalTokens) => {
      if (branchGroup) {
        await store.addBranchTurn(conversationId, 'model', fullText, undefined, totalTokens, branchGroup);
      } else {
        await store.appendTurn(req.session.userId, conversationId, 'model', fullText, undefined, totalTokens);
      }
    },
    toolConfig
  );
});

// 특정 자리(branchGroup)에 쌓인 대안 응답들을 조회/전환한다.
app.get('/api/conversations/:id/branches/:branchGroup', requireAuth, async (req, res) => {
  const branches = await store.getBranches(req.session.userId, req.params.id, req.params.branchGroup);
  if (branches === null) return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
  res.json(branches);
});

app.post('/api/conversations/:id/branches/:branchGroup/activate', requireAuth, async (req, res) => {
  const { turnId } = req.body || {};
  if (!turnId) return res.status(400).json({ error: 'turnId가 필요합니다.' });
  const ok = await store.activateBranch(req.session.userId, req.params.id, req.params.branchGroup, turnId);
  if (!ok) return res.status(404).json({ error: '브랜치를 찾을 수 없습니다.' });
  res.json({ ok: true });
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

// 매일 아침 8시(한국 표준시)에 오늘 일정 + 아직 안 끝난 할 일을 한 번에 요약해 푸시로 보낸다.
// 홈 화면 위젯은 PWA 구조상 만들 수 없어서(네이티브 전용 기능), 가장 가까운 대안으로
// "아침에 오늘 할 일을 알림으로 미리 보여주기"를 택했다. 5분 간격 스케줄러에 얹혀 돌아가므로,
// 8시 정각이 아니라 8:00~8:04 사이에 걸린 첫 실행에서 발송된다. 재시작해도 중복 발송이
// 안 나게 notified_events 테이블을 그대로 재사용한다(키를 "digest:유저:날짜"로 구성).
async function sendDailyDigest() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  if (kst.getHours() !== 8) return;
  const dateKey = kst.toISOString().slice(0, 10);
  try {
    const users = await store.getUsersWithCalendarAndPush();
    for (const u of users) {
      const digestKey = `digest:${u.userId}:${dateKey}`;
      if (await store.wasEventNotified(digestKey)) continue;
      try {
        const accessToken = await getGoogleAccessToken(u.googleCalendarRefreshToken);
        const dayStart = new Date(kst);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(kst);
        dayEnd.setHours(23, 59, 59, 999);
        const [events, tasks] = await Promise.all([
          listCalendarEvents(accessToken, dayStart.toISOString(), dayEnd.toISOString()),
          listTasks(accessToken).catch(() => []), // Tasks 미동의/오류는 조용히 건너뛰고 일정만이라도 보낸다
        ]);
        if (events.length === 0 && tasks.length === 0) {
          await store.markEventNotified(digestKey);
          continue;
        }
        const lines = [];
        for (const e of events.slice(0, 5)) {
          const time = e.start?.includes('T')
            ? new Date(e.start).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })
            : '종일';
          lines.push(`${time} ${e.title}`);
        }
        for (const t of tasks.slice(0, 5)) lines.push(`할 일: ${t.title}`);
        const body = lines.join(' · ').slice(0, 180);
        const payload = JSON.stringify({ title: '오늘 할 일', body });
        for (const sub of u.subscriptions) {
          try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) await store.deletePushSubscription(sub.endpoint);
          }
        }
        await store.markEventNotified(digestKey);
      } catch (err) {
        console.error(`유저 ${u.userId} 오늘 할 일 요약 발송 실패:`, err.message);
      }
    }
  } catch (err) {
    console.error('오늘 할 일 요약 스케줄러 실패:', err);
  }
}
setInterval(sendDailyDigest, 5 * 60 * 1000);

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
