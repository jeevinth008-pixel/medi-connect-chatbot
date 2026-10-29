# MediConnect AI

Educational health chatbot. **Frontend** (`index.html`, `config.js`) runs in the browser. **Backend** (`server.js` + `lib/`) is a Node.js server that holds your Groq API key and calls the Groq API.

```
Browser (localhost / GitHub Pages) --POST /api/chat--> Node.js server --(GROQ_API_KEY)--> Groq API
```

## How the API key works

```
.env (secret, never committed) -> server.js loads it -> lib/handler.js calls Groq
```

**Key points:**
- The API key is **only** in `.env` (server-side). It is **never** sent to the browser.
- `dotenv/config` loads `.env` into `process.env` when the server starts.
- The backend uses built-in `fetch` to call Groq's OpenAI-compatible API; no provider SDK is needed.
- The frontend (`index.html`) calls `/api/chat` on the same server — it never sees the key.

## Files

| File | Purpose |
|---|---|
| `index.html` | MediConnect UI + chat engine (safe rendering, history, error handling) |
| `config.js` | Public backend URL only (no secrets) |
| `server.js` | Node.js HTTP server, serves frontend + routes `/api/chat` to handler |
| `lib/handler.js` | Validation, CORS, rate limit, Groq API call, error mapping |
| `lib/safety.js` | Emergency pre-check, personal-data redaction |
| `lib/prompt.js` | System prompt describing MediConnect features |
| `tests/` | Backend + frontend integration tests (`npm test`) |
| `smoke.mjs` | Tests a deployed backend end to end |
| `api/chat.js`, `vercel.json` | Vercel serverless deployment entry point and configuration |
| `.env.example` | Template for `.env` (safe to commit) |
| `.env` | Your actual secrets (never commit this) |
| `.gitignore`, `package.json` | Config |

## Quick start (local)

```bash
# 1. Install dependencies (one time)
npm install

# 2. Create .env with your API key
#    Create a key at https://console.groq.com/keys
cp .env.example .env
#    Edit .env and paste your key

# 3. Start the server
npm start

# 4. Open in browser
#    http://localhost:3000
```

## What is real and what is a demo

- **Real:** the AI chat (Groq API), emergency pre-check, safe rendering, session memory.
- **Simulated demo:** doctors, slots, booking, "My records", "Reminders". They exist only in the browser tab, are labelled DEMO in the UI, and the AI is told it cannot see or confirm them.

## API reference

`POST /api/chat`, `Content-Type: application/json`

Request:
```json
{ "messages": [
  { "role": "user", "content": "What is diabetes?" },
  { "role": "assistant", "content": "Diabetes is a condition where blood sugar stays high..." },
  { "role": "user", "content": "What causes it?" } ] }
```
Success `200`:
```json
{ "reply": "Common causes and risk factors include...", "emergency": false, "source": "groq" }
```
Emergency phrase `200`: `{ "reply": "**This could be a medical emergency. Please call 112 now**...", "emergency": true, "source": "safety" }`

Errors `4xx/5xx`: `{ "error": { "code": "RATE_LIMITED", "message": "Too many requests..." } }`

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` / `INVALID_MESSAGES` | 400 | Bad input |
| `ORIGIN_NOT_ALLOWED` | 403 | Website not in `ALLOWED_ORIGINS` |
| `RATE_LIMITED` | 429 | Too many requests from one IP |
| `SERVER_NOT_CONFIGURED` | 500 | `GROQ_API_KEY` missing |
| `AI_AUTH` | 502 | Key invalid |
| `AI_RATE_LIMIT` / `AI_OVERLOADED` | 429/503 | Provider busy |
| `AI_TIMEOUT` / `AI_UNREACHABLE` / `AI_ERROR` | 504/502 | Provider failure |
| `EMPTY_AI_RESPONSE` | 502 | Groq returned no text |

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ Yes | — | Your Groq API key |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed origins |
| `GROQ_MODEL` | No | `qwen/qwen3.8-27b` | Groq model to use |
| `RATE_LIMIT_MAX` | No | `10` | Max requests per IP per window |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window (ms) |

## Troubleshooting

- **"Assistant unavailable":** Check that `.env` has `GROQ_API_KEY` (not `.env.example`). Restart with `npm start`.
- **Model error:** Check that the model configured in `GROQ_MODEL` is available to your Groq account.
- **CORS error in console:** `ALLOWED_ORIGINS` must exactly match your site origin. No trailing slash.
- **`AI_AUTH`:** Key is invalid or revoked. Create a new one at https://console.groq.com/keys.

## Security notes

- The API key stays on the server. It is never in `index.html`, `config.js`, logs, or API responses.
- CORS limits which browsers may call the API. The per-IP rate limit is your real protection.
- Request limits: 20 messages, 2000 chars per message, 1024 output tokens.
- Emails, phone numbers and 12-digit IDs are redacted before text reaches the AI.
- Emergency rules are a safety net, not triage. Edit `lib/safety.js` and `index.html` together.
- Conversation memory lives only in the browser tab (cleared on refresh/New chat).
