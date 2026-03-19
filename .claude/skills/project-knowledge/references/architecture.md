# Architecture

## Purpose
Technical architecture overview for AI agents. Helps agents understand HOW the system is built.

---

## Tech Stack

**Runtime:** Node.js v22 (ESM — `"type": "module"` in package.json)
- **Why:** Already on VPS, unified stack, modern ESM support

**Telegram framework:** grammy
- **Why:** Lightweight, ESM-native, excellent documentation, MIT license, free

**LLM (task extraction):** GigaChat API (GigaChat-2) — behind an LLM provider abstraction
- **Why:** Free tier (1M tokens/year), excellent Russian language support including slang and conversational speech, no VPN needed, registration with Russian phone number, payment in rubles
- **Abstraction:** Single interface for LLM provider. GigaChat is the default; can be swapped to DeepSeek, Claude, or others by changing config

**STT:** faster-whisper (Flask server, port 8765) — already deployed on VPS
- **Why:** Self-hosted, free, good Russian speech recognition

**Database:** SQLite
- **Why:** Simple, no infrastructure needed, stores feedback ratings and trial counters, easy export to CSV

**Hosting:** VPS 37.233.82.205, user `xander_bot`

---

## Project Structure

Entry point is `src/bot.js` — initializes grammy bot and registers handlers.

**`src/handlers/`** — Telegram message handlers. `voice.js` orchestrates the full voice-to-tasks pipeline.

**`src/services/`** — Business logic services. `transcription.js` wraps the faster-whisper HTTP client. `llm/` directory contains the LLM provider abstraction (`provider.js`) and implementations (`gigachat.js`). `taskExtractor.js` orchestrates task extraction using the LLM provider.

**`src/db/`** — SQLite database connection, queries, and migrations.

**`src/utils/`** — Helpers for formatting and sending Telegram responses.

**`prompts/`** — System prompts as separate markdown files (iterable without code changes). `task-extraction.md` is the main prompt for LLM task extraction.

---

## Key Dependencies

**Critical packages:**
- `grammy` — Telegram Bot API framework
- `better-sqlite3` — SQLite driver for Node.js (synchronous, fast)
- `node-fetch` — HTTP client for faster-whisper and GigaChat API calls
- `dotenv` — Environment variable loading

---

## External Integrations

**Telegram Bot API**
- **Purpose:** Receive voice messages, send task lists back to user
- **Auth method:** Bot token from @BotFather in `TELEGRAM_BOT_TOKEN` env var

**GigaChat API**
- **Purpose:** Extract structured tasks from transcribed speech
- **Auth method:** OAuth2 client credentials flow. `GIGACHAT_CLIENT_ID` and `GIGACHAT_CLIENT_SECRET` env vars. Token refreshed automatically.

**faster-whisper**
- **Purpose:** Speech-to-text transcription
- **Auth method:** No auth — local service on same VPS, `WHISPER_URL=http://localhost:8765`

---

## Data Flow

User sends voice message in Telegram → bot downloads audio file via Telegram API → sends audio to faster-whisper (HTTP POST to port 8765) → receives text transcript → sends transcript to GigaChat API with system prompt for task extraction → receives structured task list → formats as numbered list → sends back to user in same chat → asks for 1-5 feedback rating.

---

## Data Model

**Database:** SQLite (via better-sqlite3)

### Main Tables

**users**
- Purpose: User registry with usage statistics
- Key fields: `id`, `telegram_user_id`, `telegram_username`, `first_seen_at`, `last_active_at`, `total_voice_count`, `trial_remaining`
- Relationships: `users.id → voice_requests.user_id`

**voice_requests**
- Purpose: Log of processed voice messages for analytics and trial counting
- Key fields: `id`, `user_id`, `telegram_file_id`, `duration_seconds`, `task_count`, `audio_path` (nullable, stored only with consent), `created_at`
- Relationships: `voice_requests.user_id → users.id`, `voice_requests.id → feedback.voice_request_id`

**feedback**
- Purpose: User feedback after each voice message processing
- Key fields: `id`, `voice_request_id`, `rating` (1-5), `comment` (nullable, requested when rating < 5), `voice_consent` (boolean, whether user consented to voice review), `created_at`
- Relationships: `feedback.voice_request_id → voice_requests.id`

### Key Constraints

- **Required fields:** `users`: `telegram_user_id`, `first_seen_at`. `voice_requests`: `user_id`, `created_at`. `feedback`: `voice_request_id`, `rating`.
- **Rating range:** `feedback.rating` CHECK (1-5)
- **Foreign keys:** `voice_requests.user_id → users.id`, `feedback.voice_request_id → voice_requests.id`
- **Unique constraints:** `users.telegram_user_id` must be unique

### Migration Strategy

**Tool:** Manual SQL scripts in `src/db/migrations/`
**Process:** Migrations run automatically on bot startup. Each migration file has a sequence number prefix.

### Sensitive Data

**PII fields:**
- `users.telegram_user_id` — Telegram user identifier
- `users.telegram_username` — Telegram username
- `voice_requests.audio_path` — Original voice file (stored only with explicit user consent, per-message)
