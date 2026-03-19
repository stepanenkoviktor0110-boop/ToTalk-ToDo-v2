# Code Research: mvp-core

**Date:** 2026-03-19
**Status:** New project — no application code exists yet. Research is based on project knowledge files and planning documents.

---

## 1. Entry Points

This is a greenfield project. No source files exist yet. The planned entry points based on architecture decisions:

**`src/bot.js`** — Main entry point. Initializes the grammy bot instance, loads environment variables via dotenv, registers all handlers, runs migrations, starts long polling. Signature pattern: `const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)`.

**`src/handlers/voice.js`** — Core voice message handler. Orchestrates the full voice-to-tasks pipeline. Registered on grammy's `bot.on('message:voice', ...)`. Handles both single voice and multi-voice forwarded batches.

**`src/handlers/feedback.js`** — Handles inline keyboard callbacks for 1-5 ratings and comment collection. Registered on `bot.on('callback_query:data', ...)` or `bot.on('message:text', ...)` for comment flow.

No routes or HTTP server — the bot uses Telegram long polling exclusively.

---

## 2. Data Layer

**Database:** SQLite via `better-sqlite3` (synchronous driver). File location: `data/bot.db` or configured via env var.

**Migrations:** SQL scripts in `src/db/migrations/`, numbered with sequence prefix (e.g., `001_initial.sql`). Run automatically on bot startup via `src/db/index.js`.

### Tables

**`users`**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `telegram_user_id` INTEGER UNIQUE NOT NULL
- `telegram_username` TEXT
- `first_seen_at` DATETIME NOT NULL
- `last_active_at` DATETIME NOT NULL
- `total_voice_count` INTEGER DEFAULT 0
- `trial_remaining` INTEGER DEFAULT 30
- `trial_phase` INTEGER DEFAULT 1 — 1 = first 30, 2 = bonus 20 (after survey), 3 = exhausted
- `survey_progress` INTEGER DEFAULT 0 — 0-4, which survey question user is on
- `survey_blocked` INTEGER DEFAULT 0 — 1 if user gave garbage answers

**`voice_requests`**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `user_id` INTEGER NOT NULL → FK `users.id`
- `telegram_file_id` TEXT NOT NULL
- `duration_seconds` INTEGER
- `task_count` INTEGER
- `transcript_length` INTEGER
- `audio_path` TEXT — NULL unless user consents (per-message consent)
- `created_at` DATETIME NOT NULL

**`feedback`**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `voice_request_id` INTEGER NOT NULL → FK `voice_requests.id`
- `rating` INTEGER NOT NULL — CHECK (rating BETWEEN 1 AND 5)
- `comment` TEXT — NULL unless rating < 5 and user provided comment
- `voice_consent` INTEGER NOT NULL — 0/1 boolean; only asked when rating < 5
- `created_at` DATETIME NOT NULL

**`survey_responses`**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `user_id` INTEGER NOT NULL → FK `users.id`
- `question_num` INTEGER NOT NULL
- `answer` TEXT NOT NULL
- `is_adequate` INTEGER DEFAULT 1
- `rejection_reason` TEXT — LLM sanity check reason when rejected
- `created_at` DATETIME NOT NULL

### Trial System Logic

- `trial_remaining` decrements only on successful task list delivery (not on errors).
- Phase 1: 30 free uses. When exhausted → survey triggers.
- Phase 2: +20 uses after survey completion. When exhausted → phase 3 (blocked).
- Survey: 4 questions, `survey_progress` (0-4) tracks position. 2-strike rejection per question. `survey_blocked=1` is permanent.
- Query pattern: `db.prepare('UPDATE users SET trial_remaining = trial_remaining - 1 WHERE id = ?').run(userId)`.

---

## 3. Similar Features

No existing application code to reference. The `files/` directory contains original planning documents from the initial project conception.

**Early architecture sketch** in `d:/МОИ ПРОЕКТЫ/Сказал-сделал-бот/files/architecture.md` shows an earlier design using `@anthropic-ai/sdk` (Claude). This was superseded by the GigaChat decision for cost reasons. The LLM abstraction pattern was added specifically to allow future swapping back.

**Key pattern divergence:** The `files/` documents use CommonJS or ESM TBD — the final decision is **ESM** (`"type": "module"` in package.json). All imports use `import`/`export`, not `require`.

---

## 4. Integration Points

### Telegram Bot API (via grammy)
- **Auth:** `TELEGRAM_BOT_TOKEN` env var
- **Voice file download:** `bot.api.getFile(fileId)` then fetch from `https://api.telegram.org/file/bot{token}/{filePath}`
- **Inline keyboards:** `new InlineKeyboard()` for 1-5 feedback buttons
- **Message editing:** `ctx.editMessageText()` to update "processing..." status after result ready
- **File size limit:** Telegram caps voice files at 20MB (practical limit ~30min audio)

### faster-whisper (Flask, localhost:8765)
- **Purpose:** Speech-to-text transcription
- **Auth:** None — local service, same VPS
- **Endpoint contract (to be confirmed):** `POST http://localhost:8765/transcribe` with multipart form data containing audio file
- **Response:** JSON with `{ text: string, language: string }` (exact contract needs verification against running service)
- **Env var:** `WHISPER_URL=http://localhost:8765`
- **Client location:** `src/services/transcription.js` using `node-fetch` v3 built-in `FormData` (NOT `form-data` npm package)

### GigaChat API
- **Auth:** OAuth2 client credentials flow
  - Token endpoint: `https://ngw.devices.sberbank.ru:9443/api/v2/oauth`
  - Credentials: `GIGACHAT_CLIENT_ID`, `GIGACHAT_CLIENT_SECRET` env vars
  - Token refresh: automatic, cached in memory, checked before each request
- **Chat endpoint:** `https://gigachat.devices.sberbank.ru/api/v1/chat/completions`
- **Model:** `GigaChat-2`
- **SSL note:** GigaChat uses Sberbank's self-signed CA cert — may need to disable TLS verification or bundle the cert (`NODE_TLS_REJECT_UNAUTHORIZED=0` is a dev workaround; production should use the proper cert bundle)
- **Client location:** `src/services/llm/gigachat.js`
- **Abstraction:** `src/services/llm/provider.js` defines the interface; `src/services/taskExtractor.js` calls through the abstraction

---

## 5. Existing Tests

No tests exist yet. Based on project knowledge:

**Framework:** Jest in ESM mode
**Runner:** `npm test`
**Config needed:** `jest.config.js` with `"transform": {}` for ESM, or use `--experimental-vm-modules` flag

**Planned test patterns (from `patterns.md`):**

```js
// Unit: taskExtractor with mocked LLM provider
test('extracts single clear task', async () => {
  const mockProvider = { complete: jest.fn().mockResolvedValue('1. Call Ivan') };
  const result = await extractTasks('need to call Ivan', mockProvider);
  expect(result).toHaveLength(1);
});

// Unit: feedback DB queries
test('saves feedback rating', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  saveFeedback(db, { voiceRequestId: 1, rating: 4, comment: null, voiceConsent: false });
  const row = db.prepare('SELECT * FROM feedback').get();
  expect(row.rating).toBe(4);
});
```

**Key test cases defined in `patterns.md`:**
1. Simple single task, no ambiguities
2. Multiple tasks in one voice
3. Unknown person ("Аня знает") → delegation task
4. Alternative ("Ваня или Андрей") → clarification task
5. No tasks (thinking aloud)
6. Short voice < 5 seconds
7. Voice with background noise (transcription errors)

---

## 6. Shared Utilities

Planned based on architecture:

**`src/utils/messages.js`** — All user-facing string constants and Telegram message helpers. Functions: `sendTaskList(ctx, tasks)`, `sendProcessingStatus(ctx)`, `sendError(ctx, type)`, `requestFeedback(ctx, voiceRequestId)`. All Russian-language strings defined here (single source of truth per UX guidelines).

**`src/db/index.js`** — SQLite connection singleton. Exports `db` instance (better-sqlite3 `Database` object). Also exports `runMigrations(db)`.

**`src/db/queries.js`** — Named query functions wrapping prepared statements. Pattern: synchronous, return plain objects. Functions: `upsertUser(db, telegramUser)`, `createVoiceRequest(db, data)`, `decrementTrial(db, userId)`, `saveFeedback(db, data)`, `getUser(db, telegramUserId)`.

**`src/services/llm/provider.js`** — LLM provider interface definition. Contract: `{ complete(systemPrompt: string, userMessage: string): Promise<string> }`. Active provider loaded from config, defaulting to GigaChat.

---

## 7. Potential Problems

### GigaChat TLS / SSL
GigaChat API requires Sberbank CA certificates not in Node.js's default trust store. `NODE_TLS_REJECT_UNAUTHORIZED=0` is the quick fix but is a security risk in production. Proper fix: load Sberbank's CA cert bundle via `https.globalAgent.options.ca`.

### faster-whisper API Contract Unknown
The exact request/response format of the running faster-whisper Flask server is not documented in any project file. Before implementing `src/services/transcription.js`, the actual endpoint must be verified via `curl` against `localhost:8765` on the VPS. Assumptions: multipart POST, JSON response — but this must be confirmed.

### Multi-Voice Context Race Condition
When a user forwards multiple voice messages, Telegram delivers them as separate update events in rapid succession. grammy processes them concurrently. A naive implementation will start 3 separate pipelines for 3 forwarded voices. Mitigation: collect forwarded voices within a short time window (e.g., 500ms debounce per chat), merge transcripts, then run one LLM call. This requires per-chat state (a `Map<chatId, pendingVoices>` with a timer).

### GigaChat Token Expiry During Request
OAuth2 tokens expire. If a token expires mid-request, the call fails. The GigaChat client in `src/services/llm/gigachat.js` must implement proactive token refresh (check expiry before each call, refresh if < 60s remaining) rather than relying on 401 retry.

### Feedback State Management
After returning the task list, the bot must remember which `voice_request_id` to associate with the incoming rating. grammy's session middleware (in-memory or SQLite-backed) is needed to store `{ awaitingFeedback: true, voiceRequestId: number }` per chat. Without sessions, callback query handlers can't correlate ratings to requests.

### Input Sanitization
Transcribed text is sent directly to GigaChat as user content. No injection risk in the traditional sense (it's a prompt, not SQL), but extremely long transcripts (>10min voices) could hit GigaChat token limits. Should truncate input at a safe character limit (e.g., 8000 chars) before LLM call.

### Non-Voice Messages
Bot must handle all message types gracefully. If user sends text, photo, sticker, etc. — respond with a friendly explanation. grammy's `bot.on('message', ...)` catch-all handler needed as fallback.

### `better-sqlite3` and ESM
`better-sqlite3` is a native addon. It works with ESM but must be imported with `import Database from 'better-sqlite3'` (default import). The package is CommonJS internally but has an ESM-compatible export. Verify version compatibility with Node.js 22.

---

## 8. Constraints & Infrastructure

### Runtime
- **Node.js v22** on VPS (already installed)
- **ESM only** — `"type": "module"` in `package.json`. No `require()`, no CommonJS. All files use `.js` extension with ESM syntax.

### Framework
- **grammy** — ESM-native, lightweight. Chosen over `node-telegram-bot-api` for better ESM support and documentation.

### Database
- **better-sqlite3** — synchronous SQLite. No connection pool needed. Single DB file. Write operations are serialized automatically.

### Deployment
- **VPS:** 37.233.82.205, user `xander_bot`, Ubuntu 24.04
- **Working directory:** `/home/xander_bot/totalk-todo/`
- **Service file:** `/etc/systemd/system/totalk-todo.service`
- **Node.js binary:** `/usr/bin/node`
- **Deploy command:** `git pull origin main && npm install --production && systemctl restart totalk-todo`

### Environment Variables (all required)
| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `GIGACHAT_CLIENT_ID` | GigaChat OAuth2 client ID |
| `GIGACHAT_CLIENT_SECRET` | GigaChat OAuth2 client secret |
| `WHISPER_URL` | faster-whisper endpoint (default: `http://localhost:8765`) |
| `NODE_ENV` | `production` / `development` |

### Pre-commit Hooks
- **Gitleaks** scans for secrets on every commit. Will block commits containing token values.
- `.env` must be in `.gitignore`.

### CI/CD
- No CI/CD in MVP. Manual deploy via SSH.
- GitHub Actions planned for v2.

### Existing Services on VPS (do not touch)
- `faster-whisper` on port 8765 — already running
- `n8n` on port 5678 — unrelated, must not conflict

---

## 9. External Libraries

### grammy
- **Purpose:** Telegram Bot API framework
- **Key APIs:**
  - `new Bot(token)` — bot instance
  - `bot.on('message:voice', handler)` — voice message handler
  - `bot.on('callback_query:data', handler)` — inline keyboard callback
  - `bot.use(session({ initial: () => ({}) }))` — session middleware for feedback state
  - `ctx.replyWithChatAction('typing')` — show "typing..." indicator
  - `ctx.reply(text, { reply_markup: keyboard })` — send with inline keyboard
  - `new InlineKeyboard().text('1', 'feedback:1').text('2', 'feedback:2')...` — feedback keyboard
  - `bot.start()` — begin long polling

### better-sqlite3
- **Purpose:** Synchronous SQLite driver
- **Key APIs:**
  - `new Database(filepath)` — open/create DB file
  - `db.prepare(sql).run(...params)` — write query
  - `db.prepare(sql).get(...params)` — read one row
  - `db.prepare(sql).all(...params)` — read all rows
  - `db.exec(sql)` — run migration SQL directly
  - No async/await — all calls are synchronous

### node-fetch
- **Purpose:** HTTP client for faster-whisper and GigaChat API calls
- **Version:** v3 (ESM-only) — compatible with the ESM project setup
- **Key APIs:** `fetch(url, { method, headers, body })` returns `Promise<Response>`

### GigaChat API
- **Auth flow:** POST to `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` with `Authorization: Basic base64(clientId:clientSecret)` and body `scope=GIGACHAT_API_PERS`
- **Chat completion:** POST to `https://gigachat.devices.sberbank.ru/api/v1/chat/completions` with Bearer token
- **Request body:** `{ model: "GigaChat-2", messages: [{ role: "system", content: prompt }, { role: "user", content: transcript }] }`
- **Response:** `{ choices: [{ message: { content: string } }] }`
- **SSL:** Requires Sberbank CA cert or `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only)

### dotenv
- **Purpose:** Load `.env` file into `process.env`
- **ESM usage:** Must call `import 'dotenv/config'` at the top of `src/bot.js` (ESM import side-effect pattern, not `dotenv.config()`)

---

## Project File Map (to be created)

Based on architecture decisions, the complete file tree to build:

```
src/
  bot.js                         — entry point, grammy init, handler registration
  handlers/
    voice.js                     — voice pipeline orchestrator
    feedback.js                  — rating + comment collection
  services/
    transcription.js             — faster-whisper HTTP client
    taskExtractor.js             — calls LLM provider with prompt
    llm/
      provider.js                — interface: { complete(system, user): Promise<string> }
      gigachat.js                — GigaChat implementation with OAuth2
  db/
    index.js                     — DB singleton + runMigrations()
    queries.js                   — named query functions
    migrations/
      001_initial.sql            — create users, voice_requests, feedback tables
utils/
    messages.js                  — message strings + send helpers
prompts/
  task-extraction.md             — LLM system prompt (iterable without code changes)
package.json                     — "type": "module", dependencies, jest config
.env.example                     — template for required env vars
.gitignore                       — node_modules, .env, data/*.db
```
