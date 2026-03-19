---
created: 2026-03-19
status: draft
branch: feature/mvp-core
size: L
---

# Tech Spec: MVP Core — Voice-to-Tasks Pipeline

## Solution

Build a Telegram bot (grammy, Node.js 22 ESM) that accepts forwarded voice messages, transcribes them via faster-whisper (already running on VPS port 8765), extracts structured tasks via GigaChat API (behind an LLM provider abstraction), and returns a numbered task list. The bot collects 1-5 feedback with voice consent, tracks users in SQLite, and enforces a trial system (30 free + 20 after feedback form).

The system prompt is a separate markdown file iterable without code changes. Multi-voice context is handled via a per-chat debounce buffer (3-5s). All user-facing strings are centralized in a messages module.

## Architecture

### What we're building

- **`src/bot.js`** — Entry point. Initializes grammy bot, session middleware, registers handlers, runs DB migrations, starts long polling.
- **`src/handlers/voice.js`** — Voice pipeline orchestrator. Downloads audio, calls transcription + task extraction, sends results, triggers feedback flow.
- **`src/handlers/feedback.js`** — Feedback handler. Inline keyboard callbacks for ratings, comment collection, voice consent, trial feedback form.
- **`src/services/transcription.js`** — HTTP client for faster-whisper on localhost:8765.
- **`src/services/taskExtractor.js`** — Orchestrates LLM call with system prompt, parses response.
- **`src/services/llm/provider.js`** — LLM provider interface. Contract: `complete(systemPrompt, userMessage) → Promise<string>`.
- **`src/services/llm/gigachat.js`** — GigaChat implementation with OAuth2 token management.
- **`src/db/index.js`** — SQLite connection singleton via better-sqlite3, migration runner.
- **`src/db/queries.js`** — Named query functions (upsertUser, createVoiceRequest, saveFeedback, etc.).
- **`src/utils/messages.js`** — All user-facing Russian strings (single source of truth).
- **`prompts/task-extraction.md`** — System prompt for LLM task extraction.

### How it works

1. User forwards voice message(s) → grammy receives update(s)
2. Voice handler checks trial limit → if exhausted, triggers feedback form flow
3. If multi-voice: debounce buffer collects voices for 3-5s per chat
4. Download audio file(s) via Telegram API → POST to faster-whisper → get transcript(s)
5. Concatenate transcripts if multi-voice, truncate to 4000 chars if needed
6. Read system prompt from file → send to LLM provider with transcript → parse task list
7. Format numbered list → send to user → show inline rating buttons 1-5
8. Store voice_request in DB, increment user counter
9. On rating callback: if <5 → ask comment → ask voice consent → save feedback
10. On rating =5 → save feedback, thank user

### Shared resources

| Resource | Owner (creates) | Consumers | Instance count |
|----------|----------------|-----------|----------------|
| SQLite Database | `src/db/index.js` | All handlers, queries.js | 1 (singleton) |
| GigaChat OAuth2 token | `src/services/llm/gigachat.js` | taskExtractor | 1 (cached in memory) |
| grammy Session | `bot.js` (middleware) | voice.js, feedback.js | 1 per chat |

## Decisions

### Decision 1: GigaChat as default LLM provider
**Decision:** Use GigaChat-2 API with LLM provider abstraction
**Rationale:** Free tier (1M tokens/year), excellent Russian support, no VPN needed, payment in rubles
**Alternatives considered:** Claude API (better quality but paid, $0.006/request), DeepSeek (free tier but payment in yuan), Ollama on VPS (free but lower Russian quality, uses VPS resources)

### Decision 2: Proactive OAuth2 token refresh
**Decision:** Check token expiry before each request, refresh if <60s remaining. Retry once on 401.
**Rationale:** Prevents mid-request failures. Code research identified this as a real risk.
**Alternatives considered:** Reactive-only (retry on 401) — simpler but causes user-visible delays on first failure

### Decision 3: Per-chat debounce buffer for multi-voice
**Decision:** On first voice in a chat, start a 3-second timer. Collect all voices arriving within the window. Process as batch after timer fires.
**Rationale:** Telegram delivers forwarded messages as separate events. Without buffering, each gets processed independently.
**Alternatives considered:** Process each independently (simpler but defeats the multi-voice requirement), longer window (5s felt too slow for UX)

### Decision 4: Transcript truncation at 4000 characters
**Decision:** Truncate combined transcript to 4000 chars before LLM call. Notify user if truncated.
**Rationale:** GigaChat has token limits. 4000 chars ≈ 5-7 min of speech, sufficient for MVP use cases.
**Alternatives considered:** No truncation (risk of API failures), audio splitting by pauses (deferred to v2, requires ffmpeg)

### Decision 5: Fail-open on sanity check LLM failure
**Decision:** If GigaChat is unavailable during trial feedback form sanity check, accept the answer as adequate.
**Rationale:** User should not be stuck because of an infrastructure issue. Better to accept a potentially bad answer than block the user entirely.
**Alternatives considered:** Queue and retry later (complex state management for MVP)

### Decision 6: better-sqlite3 (synchronous) for database
**Decision:** Use synchronous SQLite driver
**Rationale:** 5 testers max, event loop blocking is negligible. Simpler code without async DB layer.
**Alternatives considered:** better-sqlite3 async wrapper, SQLite via knex (unnecessary complexity for MVP)

### Decision 7: node-fetch v3 for HTTP calls
**Decision:** Use node-fetch v3 (ESM-native) for faster-whisper and GigaChat API calls
**Rationale:** Consistent API, ESM support, handles multipart form data well
**Alternatives considered:** Built-in Node.js fetch (available in v22 but less mature for multipart/form-data), undici (lower-level)

### Decision 8: Sberbank CA certificate handling
**Decision:** Bundle Sberbank CA certificate and load via Node.js https agent options
**Rationale:** `NODE_TLS_REJECT_UNAUTHORIZED=0` is a security risk even for MVP
**Alternatives considered:** Disable TLS verification (insecure), proxy through nginx with cert (over-engineering)

## Data Models

### SQLite Schema

**users**
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER UNIQUE NOT NULL,
  telegram_username TEXT,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_voice_count INTEGER NOT NULL DEFAULT 0,
  trial_remaining INTEGER NOT NULL DEFAULT 30,
  trial_phase INTEGER NOT NULL DEFAULT 1,
  survey_progress INTEGER NOT NULL DEFAULT 0,
  survey_blocked INTEGER NOT NULL DEFAULT 0
);
```

- `trial_phase`: 1 = first 30, 2 = bonus 20 (after survey), 3 = exhausted
- `survey_progress`: 0-4, tracks which survey question user is on (0 = not started)
- `survey_blocked`: 1 if user gave garbage answers and lost survey access

**voice_requests**
```sql
CREATE TABLE voice_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  telegram_file_id TEXT NOT NULL,
  duration_seconds INTEGER,
  task_count INTEGER,
  transcript_length INTEGER,
  audio_path TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**feedback**
```sql
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voice_request_id INTEGER NOT NULL REFERENCES voice_requests(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  voice_consent INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**survey_responses**
```sql
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  question_num INTEGER NOT NULL,
  answer TEXT NOT NULL,
  is_adequate INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Session State (in-memory, grammy session)

```js
{
  awaitingFeedback: false,    // waiting for rating button press
  voiceRequestId: null,       // which voice_request to associate feedback with
  awaitingComment: false,     // waiting for text comment
  awaitingConsent: false,     // waiting for voice consent Yes/No
  inSurvey: false,            // user is in trial survey flow
  surveyRetries: {}           // { questionNum: retryCount } for sanity check
}
```

## Dependencies

### New packages
- `grammy` — Telegram Bot API framework
- `better-sqlite3` — Synchronous SQLite driver
- `node-fetch` v3 — HTTP client (ESM-native)
- `form-data` — Multipart form data for faster-whisper
- `dotenv` — Environment variable loading

### Using existing (from project)
- None — greenfield project

## Testing Strategy

**Feature size:** L

### Unit tests
- LLM provider abstraction: mock GigaChat, verify complete() contract
- GigaChat OAuth2: mock token endpoint, test proactive refresh, test 401 retry
- Task extractor: mock LLM provider, test 7 key scenarios (simple task, multiple tasks, unknown person, alternative, no tasks, short input, noisy transcript)
- DB queries: in-memory SQLite, test upsertUser, createVoiceRequest, saveFeedback, trial counter operations
- Transcript truncation: verify 4000 char limit, verify notification flag
- Message formatting: verify task list format, error messages

### Integration tests
- Full pipeline with mock transcription + mock LLM: voice file → transcript → tasks → formatted output
- Feedback flow: rating → comment → consent → DB state verification
- Trial system: counter decrement → survey trigger → survey completion → unlock
- Multi-voice buffer: simulate 3 voices arriving within 3s → verify single LLM call with combined transcript

### E2E tests
- Manual smoke test on VPS with real Telegram bot (5 test voices)
- Post-deploy: Telegram MCP automated smoke test (when configured)

## Agent Verification Plan

### Verification approach
Agent runs unit and integration tests via `npm test`. Agent verifies bot starts without errors. Agent checks DB schema via sqlite3 CLI. Post-deploy smoke test via Telegram MCP sends a voice message and checks the response format.

### Tools required
- bash (npm test, node process check, sqlite3)
- Telegram MCP (post-deploy smoke test — to be configured after first deploy)

## Risks

| Risk | Mitigation |
|------|-----------|
| GigaChat quality for Russian conversational speech extraction | LLM provider abstraction — swap to DeepSeek/Claude via config |
| GigaChat TLS — Sberbank CA cert not in Node.js trust store | Bundle Sberbank CA cert, load via https agent options |
| GigaChat OAuth2 token expiry mid-request | Proactive refresh (<60s remaining), retry on 401 |
| faster-whisper API contract not verified | Verify via curl on VPS before implementing transcription client |
| Multi-voice race condition | Per-chat debounce buffer (3s) with Map + timer |
| Long transcript exceeds GigaChat token limit | Truncate to 4000 chars with user notification |
| better-sqlite3 blocks event loop | Acceptable for 5 testers; switch to async driver in v2 if needed |

## Acceptance Criteria

Technical acceptance criteria (complement user-spec criteria):

- [ ] All unit tests pass (`npm test`)
- [ ] Integration tests pass (pipeline, feedback, trial, multi-voice)
- [ ] DB migrations run without errors on fresh database
- [ ] Bot starts and connects to Telegram without errors
- [ ] GigaChat OAuth2 token refreshes proactively (no 401 errors in normal operation)
- [ ] Sberbank CA cert loaded — no TLS errors in production
- [ ] System prompt loaded from file (not hardcoded)
- [ ] LLM provider is swappable via configuration
- [ ] Session state correctly tracks feedback flow across message events
- [ ] Multi-voice debounce buffer fires after 3s and processes batch
- [ ] Transcript truncation at 4000 chars with user notification
- [ ] All user-facing strings centralized in messages module
- [ ] Logging: each request logged with user_id, duration, task_count; all errors logged with timestamp

## Implementation Tasks

### Wave 1 (independent — Block 1: Infrastructure)

#### Task 1: Project Scaffold + SQLite Layer
- **Description:** Initialize Node.js project with ESM config, folder structure, dependencies, .gitignore, and SQLite database layer with migrations and query functions. Foundation for all other tasks.
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `node -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); console.log('OK')"` → OK
- **Files to modify:** `package.json`, `.gitignore`, `src/db/index.js`, `src/db/queries.js`, `src/db/migrations/001_initial.sql`
- **Files to read:** `.env.example`, architecture.md, patterns.md

#### Task 2: LLM Provider Abstraction + GigaChat Client
- **Description:** Create LLM provider interface and GigaChat implementation with OAuth2 token management (proactive refresh, retry on 401) and Sberbank CA cert bundle. Enables task extraction in Wave 2.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `node -e "import { GigaChatProvider } from './src/services/llm/gigachat.js'; console.log('import OK')"` → import OK
- **Files to modify:** `src/services/llm/provider.js`, `src/services/llm/gigachat.js`, `certs/russian_trusted_root_ca.cer`
- **Files to read:** code-research.md (GigaChat API section)

#### Task 3: System Prompt for Task Extraction
- **Description:** Write the system prompt that instructs the LLM to extract tasks from transcribed speech — removing verbal noise, resolving ambiguities, ordering by dependencies. Core intelligence of the bot.
- **Skill:** prompt-master
- **Reviewers:** prompt-reviewer
- **Files to modify:** `prompts/task-extraction.md`
- **Files to read:** user-spec.md (acceptance criteria, ambiguity examples), patterns.md (ambiguity resolution types)

### Wave 2 (depends on Wave 1 — Block 2: Core Pipeline)

#### Task 4: Bot Entry Point + Handler Skeleton
- **Description:** Create grammy bot initialization with session middleware, /start handler with welcome message and trial info, non-voice message handler, and user auto-registration on first contact.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `node src/bot.js` → bot starts, responds to /start in Telegram
- **Verify-user:** Send /start to bot → check welcome message + trial info
- **Files to modify:** `src/bot.js`, `src/utils/messages.js`
- **Files to read:** `src/db/queries.js`, `src/db/index.js`
- **Depends on:** Task 1

#### Task 5: Transcription + Task Extraction Services
- **Description:** Build faster-whisper HTTP client and task extraction orchestrator that calls LLM provider with system prompt. Handles transcript truncation at 4000 chars. These two services form the core data processing pipeline.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `curl -X POST http://localhost:8765/transcribe -F "file=@test.ogg"` → verify response format (run on VPS)
- **Files to modify:** `src/services/transcription.js`, `src/services/taskExtractor.js`
- **Files to read:** `src/services/llm/provider.js`, `prompts/task-extraction.md`
- **Depends on:** Task 2, Task 3

#### Task 6: Voice Handler + Multi-Voice Context
- **Description:** Orchestrate full voice-to-tasks pipeline in the voice handler: download audio, transcribe, extract tasks, format output, send to user. Implement per-chat debounce buffer (3s) for multi-voice context merging with partial failure handling.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-user:** Forward a voice message to bot → check task list appears with rating buttons
- **Files to modify:** `src/handlers/voice.js`
- **Files to read:** `src/services/transcription.js`, `src/services/taskExtractor.js`, `src/utils/messages.js`, `src/db/queries.js`
- **Depends on:** Task 4, Task 5

### Wave 3 (depends on Wave 2 — Block 3: Feedback & Trial)

#### Task 7: Feedback Flow + Voice Consent
- **Description:** Handle inline keyboard callbacks for 1-5 ratings, text comment collection when rating <5, voice consent request with audio file saving. Session state tracks which voice_request_id to associate with feedback.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-user:** Rate a task list → if <5, check comment prompt → check consent prompt → verify data in DB
- **Files to modify:** `src/handlers/feedback.js`
- **Files to read:** `src/utils/messages.js`, `src/db/queries.js`, `src/handlers/voice.js`
- **Depends on:** Task 6

#### Task 8: Trial System + Survey Form
- **Description:** Enforce trial limits (30 free, +20 after survey). Implement sequential 4-question survey in chat with LLM sanity check (fail-open on LLM error, 2-strike rejection for garbage). Survey resumption on abandoned form. Counter increments only on successful task list delivery.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `src/handlers/feedback.js` (survey flow), `src/handlers/voice.js` (trial check)
- **Files to read:** `src/db/queries.js`, `src/services/llm/provider.js`, `src/utils/messages.js`
- **Depends on:** Task 7

#### Task 9: UX Polish + Error Handling + Logging
- **Description:** Add processing status message (shown if >5s), long voice warning (>3min), centralize all error messages (no technical details), add console.log with timestamps for each request (user_id, duration, task_count) and all errors.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, test-reviewer
- **Files to modify:** `src/handlers/voice.js`, `src/utils/messages.js`, `src/bot.js`
- **Files to read:** user-spec.md (error scenarios, edge cases)
- **Depends on:** Task 8

### Audit Wave

#### Task 10: Code Audit
- **Description:** Full-feature code quality audit. Read all source files created in this feature. Review holistically for cross-component issues: duplicate resource initialization, shared resources compliance, architectural consistency. Write audit report.
- **Skill:** code-reviewing
- **Reviewers:** none

#### Task 11: Security Audit
- **Description:** Full-feature security audit. Read all source files. Analyze for OWASP Top 10 across all components, cross-component auth/data flow, credential handling (API keys, tokens, consent data). Write audit report.
- **Skill:** security-auditor
- **Reviewers:** none

#### Task 12: Test Audit
- **Description:** Full-feature test quality audit. Read all test files. Verify coverage of 7 key test cases, meaningful assertions, integration test adequacy for L-size feature. Write audit report.
- **Skill:** test-master
- **Reviewers:** none

### Final Wave

#### Task 13: Pre-deploy QA
- **Description:** Acceptance testing: run all tests, verify acceptance criteria from user-spec and tech-spec.
- **Skill:** pre-deploy-qa
- **Reviewers:** none

#### Task 14: Deploy
- **Description:** Deploy to VPS via SSH: git pull, npm install, configure .env, setup systemd service, verify bot starts and connects to Telegram.
- **Skill:** deploy-pipeline
- **Reviewers:** none

#### Task 15: Post-deploy Verification
- **Description:** Live environment verification:
  - Send /start → verify welcome message and trial info
  - Forward voice message → verify task list returned with rating buttons
  - Send text message → verify explanation response
  - Check journalctl for logs (no errors)
  Tools: Telegram MCP (when configured), bash (journalctl, systemctl)
- **Skill:** post-deploy-qa
- **Reviewers:** none
