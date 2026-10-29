import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHandler } from '../lib/handler.js';
import { checkEmergency, redact } from '../lib/safety.js';
import { buildSystemPrompt } from '../lib/prompt.js';

const ORIGIN = 'https://student.github.io';

// ---------- test helpers ----------

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b = '') => { res.body = b; };
  res.json = () => (res.body ? JSON.parse(res.body) : null);
  return res;
}
function mockReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: { messages: [{ role: 'user', content: 'What is diabetes?' }] },
    ...overrides
  };
}
async function run(handler, req) { const res = mockRes(); await handler(req, res); return res; }

// ---------- Mock Gemini SDK client ----------
// The handler calls: ai.models.generateContent({ model, config, contents })
// and reads: response.candidates[0].finishReason, response.text

function fakeAi(impl) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (args) => {
        calls.push(args);
        return impl(args);
      }
    }
  };
}

function okAi(text = 'Diabetes is a condition...') {
  return fakeAi(() => ({
    text,
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }]
  }));
}

// Store/restore env for tests that need specific env vars
const savedEnv = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------- safety tests ----------

test('emergency check: urgent phrases', () => {
  for (const t of ["I can't breathe", 'severe chest pain and sweating', 'my face is drooping and speech slurred',
    'he is unconscious', 'my throat is swelling after eating peanuts', 'I want to die', 'heavy bleeding that wont stop']) {
    assert.equal(checkEmergency(t).emergency || checkEmergency(t + ' slurred speech').emergency, true, t);
  }
  assert.equal(checkEmergency('I want to die').kind, 'mental_health');
});

test('emergency check: educational/benign questions are not flagged', () => {
  for (const t of ['What is diabetes?', 'What causes it?', 'What is a stroke?', 'I have a cough and fever',
    'Which specialist handles skin conditions?', 'what does BP mean', 'Explain what MediConnect is',
    'How does an appointment system work?']) {
    assert.equal(checkEmergency(t).emergency, false, t);
  }
});

test('redact removes emails, phones and 12-digit ids', () => {
  const r = redact('mail me a@b.com or call +91 98765 43210, id 1234 5678 9012, bp 120 80');
  assert.ok(!r.includes('a@b.com') && !r.includes('98765') && !r.includes('9012'));
  assert.ok(r.includes('120 80'));
});

test('system prompt describes demo-only features and forbids fabrication', () => {
  const p = buildSystemPrompt();
  assert.match(p, /SIMULATED DEMO ONLY/);
  assert.match(p, /Never invent hospital names/);
  assert.match(p, /Gemini/i);
});

// ---------- handler tests ----------

test('success: calls Gemini with history and returns reply; key never in response', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const ai = okAi('Diabetes is...');
    const h = createHandler({ ai });
    const res = await run(h, mockReq({ body: { messages: [
      { role: 'user', content: 'What is diabetes?' },
      { role: 'assistant', content: 'Diabetes is a condition of high blood sugar.' },
      { role: 'user', content: 'What causes it?' }] } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reply, 'Diabetes is...');
    assert.equal(res.json().source, 'gemini');
    assert.equal(ai.calls.length, 1);
    // Verify conversation history mapped to Gemini format
    assert.ok(ai.calls[0].contents.length >= 2);
    // Verify system instruction sent
    assert.ok(ai.calls[0].config.systemInstruction.length > 100);
    // Key never leaked in response
    assert.ok(!res.body.includes('key'));
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  } finally { restoreEnv(); }
});

test('emergency bypasses AI call', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const ai = okAi();
    const h = createHandler({ ai });
    const res = await run(h, mockReq({ body: { messages: [{ role: 'user', content: "I can't breathe and have severe chest pain" }] } }));
    assert.equal(res.json().emergency, true);
    assert.match(res.json().reply, /112/);
    assert.equal(ai.calls.length, 0);
  } finally { restoreEnv(); }
});

test('PII is redacted before reaching the provider', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const ai = okAi();
    const h = createHandler({ ai });
    await run(h, mockReq({ body: { messages: [{ role: 'user', content: 'my email is jeev@example.com, what is anemia?' }] } }));
    assert.equal(ai.calls.length, 1);
    const sentText = JSON.stringify(ai.calls[0].contents);
    assert.ok(!sentText.includes('jeev@example.com'));
  } finally { restoreEnv(); }
});

test('CORS: disallowed origin rejected, preflight OK, GET rejected', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const h = createHandler({ ai: okAi() });
    assert.equal((await run(h, mockReq({ headers: { origin: 'https://evil.com', 'content-type': 'application/json' } }))).statusCode, 403);
    const pre = await run(h, mockReq({ method: 'OPTIONS' }));
    assert.equal(pre.statusCode, 204);
    const get = await run(h, mockReq({ method: 'GET' }));
    assert.equal(get.statusCode, 405);
  } finally { restoreEnv(); }
});

test('invalid body and empty messages', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const h = createHandler({ ai: okAi() });
    assert.equal((await run(h, mockReq({ body: { messages: [] } }))).statusCode, 400);
    assert.equal((await run(h, mockReq({ body: 'not json' }))).statusCode, 400);
  } finally { restoreEnv(); }
});

test('missing API key gives safe config error', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN, GEMINI_API_KEY: undefined });
  try {
    const h = createHandler();  // no injected ai, no env key
    const res = await run(h, mockReq());
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error.code, 'SERVER_NOT_CONFIGURED');
  } finally { restoreEnv(); }
});

test('rate limiting returns 429', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN, RATE_LIMIT_MAX: '2' });
  try {
    const h = createHandler({ ai: okAi() });
    const ip = '200.200.200.200';
    const headers = { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip };
    assert.equal((await run(h, mockReq({ headers }))).statusCode, 200);
    assert.equal((await run(h, mockReq({ headers }))).statusCode, 200);
    const res = await run(h, mockReq({ headers }));
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.code, 'RATE_LIMITED');
  } finally { restoreEnv(); }
});

test('Gemini API errors map to safe codes without leaking details', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const cases = [
      [{ status: 401, message: 'API key not valid' }, 'AI_AUTH'],
      [{ status: 429, message: 'quota exceeded' }, 'AI_RATE_LIMIT'],
      [{ status: 503, message: 'service unavailable' }, 'AI_OVERLOADED'],
      [{ message: 'fetch failed ECONNREFUSED' }, 'AI_UNREACHABLE'],
      [{ message: 'something random' }, 'AI_ERROR'],
    ];
    for (const [errProps, expectedCode] of cases) {
      const err = new Error(errProps.message || 'error');
      if (errProps.status) err.status = errProps.status;
      const ai = fakeAi(() => { throw err; });
      const h = createHandler({ ai });
      const res = await run(h, mockReq());
      assert.equal(res.json().error.code, expectedCode, `Expected ${expectedCode} for ${JSON.stringify(errProps)}`);
      assert.ok(!res.body.includes('ECONNREFUSED') || expectedCode === 'AI_UNREACHABLE');
    }
  } finally { restoreEnv(); }
});

test('empty provider response is reported honestly', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const ai = fakeAi(() => ({ text: '', candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP' }] }));
    const h = createHandler({ ai });
    const res = await run(h, mockReq());
    assert.equal(res.json().error.code, 'EMPTY_AI_RESPONSE');
  } finally { restoreEnv(); }
});

test('safety-blocked response returns a polite fallback', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const ai = fakeAi(() => ({
      text: '',
      candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'SAFETY' }]
    }));
    const h = createHandler({ ai });
    const res = await run(h, mockReq());
    assert.equal(res.statusCode, 200);
    assert.match(res.json().reply, /rephrase/i);
    assert.equal(res.json().source, 'gemini-safety');
  } finally { restoreEnv(); }
});

test('message role mapping: assistant becomes model for Gemini', async () => {
  setEnv({ ALLOWED_ORIGINS: ORIGIN });
  try {
    const ai = okAi('Answer');
    const h = createHandler({ ai });
    await run(h, mockReq({ body: { messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Question' }
    ] } }));
    const contents = ai.calls[0].contents;
    assert.ok(contents.every(c => ['user', 'model'].includes(c.role)));
    assert.ok(!contents.some(c => c.role === 'assistant'));
  } finally { restoreEnv(); }
});

test('no secrets in frontend files', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const cfg = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + cfg, /sk-ant-|ANTHROPIC_API_KEY|GEMINI_API_KEY|AIza/);
});
