require('dotenv').config();
const express = require('express');
const { GoogleGenAI, ApiError } = require('@google/genai');
const { SYSTEM_PROMPT } = require('./system-prompt');

const PORT = process.env.PORT || 3210;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// 프론트엔드는 {role: 'user'|'assistant', content: string} 형태로 보내는데,
// Gemini는 role을 'user'|'model'로 요구하고 각 메시지를 parts 배열로 감싼다.
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
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

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: toGeminiContents(messages),
      config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 1536 },
    });

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
