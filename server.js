require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./system-prompt');

const PORT = process.env.PORT || 3210;
const MODEL = process.env.SPECTER_MODEL || 'claude-sonnet-5';
const EFFORT = process.env.SPECTER_EFFORT || 'medium';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// 대화가 길어질수록 매 요청마다 전체 히스토리를 다시 보내는 비용이 커지므로,
// 가장 최근 메시지에 캐시 breakpoint를 찍어 시스템 프롬프트+이전 대화를 재사용한다.
function withCacheBreakpoint(messages) {
  return messages.map((m, i) => {
    if (i !== messages.length - 1) return m;
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
    };
  });
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1536,
      system: SYSTEM_PROMPT,
      output_config: { effort: EFFORT },
      messages: withCacheBreakpoint(messages),
    });

    const u = response.usage;
    console.log(
      `[usage] input=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens}`
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    res.json({ text });
  } catch (err) {
    // 레이트리밋(429)은 일시적 제한 — 자동으로 풀리므로 대기 후 재시도가 유효하다.
    if (err instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(err.headers?.['retry-after']) || 30;
      return res.status(429).json({
        kind: 'rate_limit',
        retryAfterSeconds: retryAfter,
        error: `요청이 많아 잠시 제한되었습니다. 약 ${retryAfter}초 후 자동으로 다시 시도됩니다.`,
      });
    }
    // 크레딧 소진(403 billing_error)은 시간이 지나도 저절로 풀리지 않는다 — 직접 충전이 필요하다.
    if (err instanceof Anthropic.PermissionDeniedError) {
      if (err.error?.error?.type === 'billing_error') {
        return res.status(403).json({
          kind: 'billing_exhausted',
          error: 'API 크레딧이 모두 소진되었습니다. console.anthropic.com에서 충전이 필요합니다. (시간이 지나도 자동으로 재개되지 않습니다)',
        });
      }
      return res.status(403).json({ kind: 'permission', error: 'API 키에 이 요청을 처리할 권한이 없습니다.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ kind: 'auth', error: 'API 키가 유효하지 않습니다. .env 파일을 확인하세요.' });
    }
    console.error(err);
    res.status(502).json({ kind: 'unknown', error: 'Claude API 호출에 실패했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`Specter가 http://localhost:${PORT} 에서 실행 중입니다. (model=${MODEL}, effort=${EFFORT})`);
});
