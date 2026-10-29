// MediConnect chat handler — Groq backend.
// Preserves the /api/chat contract: { messages } → { reply, emergency, source }.
// Groq uses the OpenAI-compatible chat completions API — no SDK needed.

import { buildSystemPrompt } from './prompt.js';
import { checkEmergency, emergencyReply, redact } from './safety.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const LIMITS = {
  MAX_OUTPUT_TOKENS: 1024,
  TIMEOUT_MS: 30000,
  MAX_MESSAGES: 20,
  MAX_MESSAGE_LENGTH: 4000,
  MAX_BODY_BYTES: 100 * 1024,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_WINDOW_MS: 60000
};

const rateLimits = new Map();

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  for (const [key, value] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  })) {
    res.setHeader(key, value);
  }

  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message, headers) {
  return send(res, status, { error: { code, message } }, headers);
}

function getHeader(req, name) {
  if (typeof req.headers?.get === 'function') {
    return req.headers.get(name);
  }

  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  const forwarded = getHeader(req, 'x-forwarded-for');
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

function checkRateLimit(ip, env) {
  const max = Number(env.RATE_LIMIT_MAX) || LIMITS.RATE_LIMIT_MAX;
  const windowMs =
    Number(env.RATE_LIMIT_WINDOW_MS) || LIMITS.RATE_LIMIT_WINDOW_MS;

  const now = Date.now();
  const record = rateLimits.get(ip);

  // Clean up stale entries periodically
  if (rateLimits.size > 5000) {
    for (const [k, v] of rateLimits) {
      if (now - v.start >= windowMs) rateLimits.delete(k);
    }
  }

  if (!record || now - record.start >= windowMs) {
    rateLimits.set(ip, { start: now, count: 1 });
    return true;
  }

  if (record.count >= max) {
    return false;
  }

  record.count += 1;
  return true;
}

function getBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  return null;
}

// ---------- error mapping (Grok / OpenAI-compatible) ----------

function mapGroqError(err) {
  const status = err && err.status;
  const text = String((err && err.message) || '').toLowerCase();

  if (err && err.name === 'AbortError') {
    return { http: 504, code: 'AI_TIMEOUT', message: 'The AI took too long to respond. Please try again.' };
  }

  if (status === 401 || status === 403 || text.includes('api key') || text.includes('unauthorized') || text.includes('invalid_api_key')) {
    return { http: 502, code: 'AI_AUTH', message: 'The assistant\u2019s API credentials are missing or invalid. The site owner needs to fix this.' };
  }

  if (status === 429 || text.includes('quota') || text.includes('rate limit') || text.includes('too many')) {
    return { http: 429, code: 'AI_RATE_LIMIT', message: 'The AI service is busy right now. Please wait a moment and try again.' };
  }

  if (status === 503 || status === 500 || text.includes('overloaded') || text.includes('unavailable')) {
    return { http: 503, code: 'AI_OVERLOADED', message: 'The AI service is temporarily unavailable. Please try again shortly.' };
  }

  if (text.includes('fetch') || text.includes('econnrefused') || text.includes('network') || text.includes('dns')) {
    return { http: 502, code: 'AI_UNREACHABLE', message: 'The backend could not reach the AI service. Please try again.' };
  }

  return { http: 502, code: 'AI_ERROR', message: 'Something went wrong while contacting the AI. Please try again.' };
}

// ---------- handler factory ----------

export function createHandler({ callGroq: injectedCallGroq } = {}) {
  // Allow injecting a mock for testing
  let callGroq = injectedCallGroq || null;

  return async function handler(req, res) {
    const method = req.method || 'GET';

    // --- CORS ---
    const origin = getHeader(req, 'origin');
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((item) => item.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    if (origin && !allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
      return fail(res, 403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to use the chatbot.');
    }

    const corsHeaders = origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin'
        }
      : {};

    if (method === 'OPTIONS') {
      return send(res, 204, {}, corsHeaders);
    }

    if (method !== 'POST') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST to send a message.', corsHeaders);
    }

    // --- Body parsing ---
    const body = getBody(req);

    if (!body || !Array.isArray(body.messages)) {
      return send(res, 400, {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Please send a valid chat message.'
        }
      }, corsHeaders);
    }

    const messages = body.messages;

    if (
      messages.length === 0 ||
      messages.length > LIMITS.MAX_MESSAGES ||
      messages.some((message) =>
        !message ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        !message.content.trim() ||
        message.content.length > LIMITS.MAX_MESSAGE_LENGTH
      )
    ) {
      return send(res, 400, {
        error: {
          code: 'INVALID_MESSAGES',
          message: 'The conversation is empty or too long.'
        }
      }, corsHeaders);
    }

    // --- Rate limit ---
    const ip = getClientIp(req);

    if (!checkRateLimit(ip, process.env)) {
      return send(res, 429, {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please wait a minute and try again.'
        }
      }, corsHeaders);
    }

    // --- Find latest user message ---
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user');

    if (!latestUserMessage) {
      return send(res, 400, {
        error: {
          code: 'MISSING_USER_MESSAGE',
          message: 'Please enter a message.'
        }
      }, corsHeaders);
    }

    // --- Emergency pre-check (instant, no AI wait) ---
    const safety = checkEmergency(latestUserMessage.content);
    if (safety.emergency) {
      return send(res, 200, {
        reply: emergencyReply(safety.kind),
        emergency: true,
        source: 'safety'
      }, corsHeaders);
    }

    // --- API key check ---
    const apiKey = process.env.GROQ_API_KEY;
    if (!callGroq && !apiKey) {
      console.error('GROQ_API_KEY is not set');
      return fail(res, 500, 'SERVER_NOT_CONFIGURED',
        'The assistant is not configured yet. The site owner needs to add the API key.',
        corsHeaders);
    }

    // --- Build messages for Grok (OpenAI format) ---
    // Grok uses the same user/assistant roles as our frontend — no mapping needed!
    // Just add the system prompt and redact PII.
    const grokMessages = [
      { role: 'system', content: buildSystemPrompt() },
      ...messages.map((msg) => ({
        role: msg.role,
        content: redact(msg.content)
      }))
    ];

    // --- Call Grok API ---
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIMITS.TIMEOUT_MS);

    try {
      const model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

      // Use injected mock or real fetch
      const apiCall = callGroq || (async (payload) => {
        const resp = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (!resp.ok) {
          const err = new Error(`Groq API error: ${resp.status}`);
          err.status = resp.status;
          try { err.body = await resp.json(); } catch (_) { /* ignore */ }
          throw err;
        }

        return resp.json();
      });

      const data = await apiCall({
        model,
        messages: grokMessages,
        max_tokens: LIMITS.MAX_OUTPUT_TOKENS,
        temperature: 0.7
      });

      // --- Extract reply ---
      const choice = data.choices && data.choices[0];
      const reply = (choice && choice.message && choice.message.content || '').trim();

      if (!reply) {
        return send(res, 502, {
          error: {
            code: 'EMPTY_AI_RESPONSE',
            message: 'The AI returned an empty response. Please try again.'
          }
        }, corsHeaders);
      }

      return send(res, 200, {
        reply,
        emergency: false,
        source: 'groq'
      }, corsHeaders);

    } catch (error) {
      const mapped = mapGroqError(error);
      console.error('Groq API error:', mapped.code, error && error.status);
      return fail(res, mapped.http, mapped.code, mapped.message, corsHeaders);
    } finally {
      clearTimeout(timeout);
    }
  };
}
