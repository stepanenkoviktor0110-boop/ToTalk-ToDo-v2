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

### What we're building/modifying

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
**Rationale:** Telegram delivers forwarded messages as separate events. Without buffering, each gets processed independently. A voice arriving after the timer fires is treated as a new, separate request (new buffer starts).
**Alternatives considered:** Process each independently (simpler but defeats the multi-voice requirement), longer window (5s felt too slow for UX)

### Decision 4: Transcript truncation at 4000 characters
**Decision:** Truncate combined transcript to 4000 chars before LLM call. Notify user if truncated.
**Rationale:** GigaChat has token limits. 4000 chars ≈ 5-7 min of speech, sufficient for MVP use cases.
**Alternatives considered:** No truncation (risk of API failures), audio splitting by pauses (deferred to v2, requires ffmpeg)

### Decision 5: Fail-open on sanity check LLM failure with heuristic gate
**Decision:** Before LLM sanity check, apply a minimum heuristic gate: reject answers under 5 words or containing only punctuation/emoji. If GigaChat is unavailable after heuristic passes, accept the answer as adequate.
**Rationale:** Heuristic gate blocks trivial bypass attempts (empty/gibberish) even during LLM downtime, without adding infrastructure complexity. User should not be permanently stuck because of an infrastructure issue.
**Alternatives considered:** Queue and retry later (complex state management for MVP), pure fail-open without heuristic (trivially exploitable)

### Decision 6: better-sqlite3 (synchronous) for database
**Decision:** Use synchronous SQLite driver
**Rationale:** 5 testers max, event loop blocking is negligible. Simpler code without async DB layer.
**Alternatives considered:** better-sqlite3 async wrapper, SQLite via knex (unnecessary complexity for MVP)

### Decision 7: node-fetch v3 for HTTP calls
**Decision:** Use node-fetch v3 (ESM-native) with its built-in FormData for faster-whisper and GigaChat API calls. Do NOT use `form-data` npm package — it is incompatible with node-fetch v3.
**Rationale:** Consistent API, ESM support. node-fetch v3 deprecated the `form-data` package and ships its own spec-compliant FormData.
**Alternatives considered:** Built-in Node.js fetch (available in v22 but less mature for multipart/form-data), undici (lower-level)

### Decision 8: Sberbank CA certificate handling
**Decision:** Bundle Sberbank CA certificate and load via Node.js https agent options
**Rationale:** `NODE_TLS_REJECT_UNAUTHORIZED=0` is a security risk even for MVP
**Alternatives considered:** Disable TLS verification (insecure), proxy through nginx with cert (over-engineering)

### Decision 9: Feedback interruption — silent abandon
**Decision:** If user sends a new voice while feedback is pending (rating/comment/consent), silently abandon previous feedback and process the new voice. Reset session state.
**Rationale:** Users should not be blocked. Forwarded voices are the primary use case — feedback is secondary.
**Alternatives considered:** Force feedback completion before accepting new voice (blocks user flow)

### Decision 10: Batch and output limits
**Decision:** Max 10 voices per debounce buffer batch. Max 10 tasks in LLM output — if more, ask user to split. Zero tasks → explicit friendly message.
**Rationale:** Prevents overload on LLM and keeps output manageable for users. Matches user-spec acceptance criteria.
**Alternatives considered:** No limits (risk of LLM failures and poor UX with huge lists)

### Decision 11: General error retry strategy
**Decision:** GigaChat API calls retry once on any failure (5xx, network error, timeout). Transcription calls do not retry (faster-whisper is local, failure is likely persistent). All errors surfaced to user as friendly messages.
**Rationale:** One retry handles transient GigaChat issues. Retrying whisper adds latency without benefit since it's localhost.
**Alternatives considered:** Exponential backoff (over-engineering for MVP)

### Decision 12: Logging — console.log with credential/PII exclusion
**Decision:** Use console.log with timestamps. Log request metadata (user_id, duration, task_count) and errors. Never log: auth headers, API keys, bot token, transcript text, user comments, audio file contents.
**Rationale:** Simple logging for MVP with 5 testers. PII/credential exclusion prevents accidental leaks in journalctl.
**Alternatives considered:** Structured JSON logger (over-engineering for MVP)

### Decision 13: Global error handler
**Decision:** Register grammy's `bot.catch()` error handler. Log error, send generic message to user, do not crash process.
**Rationale:** Unhandled errors in handlers must not crash the bot. grammy provides built-in error boundary.
**Alternatives considered:** process.on('uncaughtException') — grammy's catch is more specific and appropriate

### Decision 14: HTTP timeout values for <30s target
**Decision:** Transcription timeout: 20s. GigaChat timeout: 15s. Total pipeline budget: ~30s for voice up to 1 min. Timeouts configured via fetch AbortController.
**Rationale:** User-spec requires <30s response. Splitting budget between services leaves margin for formatting and sending.
**Alternatives considered:** No timeouts (risk of hanging requests), longer timeouts (violates 30s target)

### Decision 15: Survey state machine rules
**Decision:** Survey has 4 questions. `survey_progress` (0-4) tracks position. Each answer checked by LLM sanity check with 2-strike rule per question (tracked in session `surveyRetries`). `survey_blocked=1` is permanent — no retry. Phase transitions: phase 1 (30 free) → phase 2 (survey completed, +20) → phase 3 (exhausted, blocked). Survey abandoned mid-flow → resumes from `survey_progress` on next voice.
**Rationale:** Centralizes complex state machine logic in one decision for clarity.
**Alternatives considered:** Simpler flag-based system (insufficient for resumption and per-question retries)

### Decision 16: Credential sanitization in error handlers
**Decision:** All HTTP error handlers must sanitize URLs and headers before logging — strip bot token from Telegram URLs (`url.replace(/\/bot[^/]+\//, '/bot[REDACTED]/')`), strip Authorization headers from GigaChat requests. On GigaChat token-request failure, log HTTP status code and error body only — request headers object MUST NOT be serialized. Unit test required: assert no credential substring appears in captured log output on simulated error.
**Rationale:** Decision 12 prohibits credential logging, but without explicit sanitization in error paths, raw error objects leak credentials via `.url` and `.headers` properties.
**Alternatives considered:** Wrapping console.log globally (fragile, easy to bypass)

### Decision 17: Per-user cooldown (anti-abuse)
**Decision:** After each debounce batch completes (success or error), the user enters a 10-second cooldown. Voices during cooldown get a friendly "please wait" message. Implemented as `Map<userId, lastProcessedAt>` in memory.
**Rationale:** Without rate limiting, a single user can exhaust GigaChat free tier (1M tokens/year) and saturate VPS I/O by spamming voices every 3 seconds.
**Alternatives considered:** No rate limiting (exploitable), token bucket (over-engineering for MVP)

### Decision 18: CA certificate integrity verification
**Decision:** Hardcode expected SHA-256 fingerprint of Sberbank CA cert as a constant. At startup, compute and compare — throw if mismatch. Log warning if cert expires within 30 days.
**Rationale:** A certificate replacement (accidental or compromised git push) would silently trust a different CA for all GigaChat API calls, enabling MITM.
**Alternatives considered:** Trust on first use (no protection against replacement), skip verification (silent MITM risk)

### Decision 19: SQLite database path and permissions
**Decision:** DB_PATH env var with default `data/bot.db`. At startup, ensure `data/` directory exists. `data/` and `*.db` in `.gitignore`.
**Rationale:** Database contains PII (telegram_user_id, username, feedback). Must not be accidentally committed to version control.
**Alternatives considered:** Store in project root (risk of git commit), /var/lib path (harder for dev)

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
  rejection_reason TEXT,
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
- `dotenv` — Environment variable loading

Note: `form-data` npm package is NOT used — node-fetch v3 has built-in `FormData` (`import fetch, { FormData, File } from 'node-fetch'`).

### Using existing (from project)
- None — greenfield project

## Testing Strategy

**Feature size:** L

### Unit tests
- LLM provider abstraction: mock HTTP, verify complete() extracts content string from JSON (not raw response), verify token refresh called when <60s to expiry, verify exactly one retry on 401
- GigaChat OAuth2: mock token endpoint, test proactive refresh, test 401 retry, test general 5xx retry
- Task extractor: mock LLM provider, test 7 key scenarios (simple task, multiple tasks, unknown person, alternative, no tasks, short input, noisy transcript)
- DB queries: in-memory SQLite, test upsertUser, createVoiceRequest, saveFeedback, trial counter operations
- Trial state machine: test phase transitions (1→2→3), survey_progress advancement (0→1→2→3→4), survey_blocked flag, fail-open behavior
- Counter guard: verify counter increments only on successful task list delivery, not on errors
- Consent guard: verify audio_path is set only when voice_consent=1, null otherwise
- Transcript truncation: verify 4000 char limit, verify notification flag
- Debounce buffer (fake timers): first voice starts 3s timer, second voice resets timer, timer fires → single LLM call with combined transcripts, voice after timer = new buffer. Batch limit of 10.
- Message formatting: verify task list format, error messages, no credentials/PII in log output

### Integration tests
- Full pipeline with mock transcription + mock LLM: voice file → transcript → tasks → formatted output
- Feedback flow: rating → comment → consent → DB state verification
- Feedback interruption: new voice during pending feedback → previous abandoned, new processed
- Trial system: counter decrement → survey trigger → survey completion → unlock
- Trial survey resumption: abandon at question 2, come back → continues from question 2
- Trial survey_blocked: 2 garbage answers → permanent block, no retry
- Partial batch failure: 3 voices, 1 fails transcription → 2 processed, error noted
- Multi-voice buffer: simulate 3 voices arriving within 3s → verify single LLM call with combined transcript

### E2E tests (manual, 5 scenarios)
1. Single voice → task list → rate 5 → thank-you (happy path)
2. Single voice → task list → rate 3 → comment → consent yes → verify DB feedback row
3. Three voices forwarded simultaneously → single combined task list (multi-voice buffer)
4. Trial at 30 → survey flow all 4 questions with adequate answers → +20 unlocked → voice works again
5. Text message → explanation response
- Post-deploy: Telegram MCP automated smoke test targeting same 5 scenarios (when configured)

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
| Credential leakage in logs | Decision 12: never log auth headers, API keys, tokens, transcripts |
| faster-whisper exposed externally | Validate WHISPER_URL is loopback at startup; verify firewall in deploy task |
| Prompt injection via transcript | System prompt explicitly ignores user instructions (Task 3); task extractor validates response format (Task 5); anomalous responses logged |

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
- [ ] No credentials, auth headers, transcripts, or PII in log output
- [ ] WHISPER_URL validated as loopback address at startup
- [ ] Global error handler registered (bot.catch) — unhandled errors don't crash process
- [ ] Feedback interruption: new voice resets session, previous feedback abandoned
- [ ] Batch limit: max 10 voices per debounce window enforced
- [ ] Output limit: max 10 tasks, user prompted to split if exceeded
- [ ] HTTP timeouts: transcription 20s, GigaChat 15s (Decision 14)
- [ ] Response time <30s for voice up to 1 min on VPS (single user load)
- [ ] Credential sanitization: unit test asserts no token/key in log output on error
- [ ] Rating = 5 terminates feedback immediately (no comment/consent prompts)
- [ ] Voice < 2s processed normally (no special handling)
- [ ] Per-user cooldown (10s) after each batch — prevents abuse (Decision 17)
- [ ] CA cert fingerprint verified at startup (Decision 18)
- [ ] DB stored in data/bot.db, data/ in .gitignore (Decision 19)
- [ ] npm audit reports no high/critical vulnerabilities before deploy
- [ ] Survey heuristic gate: answers under 5 words rejected before LLM check (Decision 5)
- [ ] survey_blocked transition logged with userId and questionNum
- [ ] Task extractor validates LLM response format (numbered list) before forwarding

## Implementation Tasks

### Wave 1 (independent — Block 1: Infrastructure)

#### Task 1: Project Scaffold + SQLite Layer
- **Description:** Initialize Node.js project with ESM config, folder structure, dependencies, .gitignore, and SQLite database layer with migrations and query functions. Foundation for all other tasks.
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `node -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); console.log('OK')"` → OK
- **Files to modify:** `package.json`, `.gitignore`, `src/db/index.js`, `src/db/queries.js`, `src/db/migrations/001_initial.sql`, `.env.example`
- **Files to read:** `.claude/skills/project-knowledge/references/architecture.md`, `.claude/skills/project-knowledge/references/patterns.md`

#### Task 2: LLM Provider Abstraction + GigaChat Client
- **Description:** Create LLM provider interface and GigaChat implementation with OAuth2 token management (proactive refresh, retry on 401) and Sberbank CA cert bundle. Enables task extraction in Wave 2.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `node -e "import { GigaChatProvider } from './src/services/llm/gigachat.js'; console.log('import OK')"` → import OK
- **Files to modify:** `src/services/llm/provider.js`, `src/services/llm/gigachat.js`, `certs/russian_trusted_root_ca.cer`
- **Files to read:** `work/mvp-core/code-research.md`

#### Task 3: System Prompt for Task Extraction
- **Description:** Write the system prompt that instructs the LLM to extract tasks from transcribed speech — removing verbal noise, resolving ambiguities, ordering by dependencies. Must include explicit instruction to ignore any instructions in user message and return only a numbered task list.
- **Skill:** prompt-master
- **Reviewers:** prompt-reviewer
- **Files to modify:** `prompts/task-extraction.md`
- **Files to read:** `work/mvp-core/user-spec.md`, `.claude/skills/project-knowledge/references/patterns.md`

### Wave 2 (depends on Wave 1 — Block 2a: Bot + Services)

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
- **Description:** Build faster-whisper HTTP client and task extraction orchestrator that calls LLM provider with system prompt. Handles transcript truncation at 4000 chars. Task extractor validates LLM response format (numbered list) — returns generic error if format doesn't match.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `curl -X POST http://localhost:8765/transcribe -F "file=@test.ogg"` → verify response format (run on VPS)
- **Files to modify:** `src/services/transcription.js`, `src/services/taskExtractor.js`
- **Files to read:** `src/services/llm/provider.js`, `prompts/task-extraction.md`
- **Depends on:** Task 2, Task 3

### Wave 3 (depends on Wave 2 — Block 2b: Voice Handler)

#### Task 6: Voice Handler + Multi-Voice Context
- **Description:** Orchestrate full voice-to-tasks pipeline in the voice handler: download audio, transcribe, extract tasks, format output, send to user. Implement per-chat debounce buffer (3s) for multi-voice context merging with partial failure handling.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test -- --grep "voice handler"` → integration test passes
- **Verify-user:** Forward a voice message to bot → check task list appears with rating buttons
- **Files to modify:** `src/handlers/voice.js`
- **Files to read:** `src/services/transcription.js`, `src/services/taskExtractor.js`, `src/utils/messages.js`, `src/db/queries.js`
- **Depends on:** Task 4, Task 5

### Wave 4 (depends on Wave 3 — Block 3a: Feedback)

#### Task 7: Feedback Flow + Voice Consent
- **Description:** Handle inline keyboard callbacks for 1-5 ratings, text comment collection when rating <5, voice consent request with audio file saving. Session state tracks which voice_request_id to associate with feedback. New voice during pending feedback silently abandons previous feedback (Decision 9).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-user:** Rate a task list → if <5, check comment prompt → check consent prompt → verify data in DB
- **Files to modify:** `src/handlers/feedback.js`, `src/handlers/voice.js`
- **Files to read:** `src/utils/messages.js`, `src/db/queries.js`
- **Depends on:** Task 6

### Wave 5 (depends on Wave 4 — Block 3b: Trial)

#### Task 8: Trial System + Survey Form
- **Description:** Enforce trial limits (30 free, +20 after survey). Implement sequential 4-question survey in chat with LLM sanity check (fail-open on LLM error, 2-strike rejection for garbage). Survey resumption on abandoned form. Counter increments only on successful task list delivery.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** Run integration test: create user, process 30 voices (mock), verify survey triggers
- **Files to modify:** `src/handlers/feedback.js`, `src/handlers/voice.js`
- **Files to read:** `src/db/queries.js`, `src/services/llm/provider.js`, `src/utils/messages.js`
- **Depends on:** Task 7

### Wave 6 (depends on Wave 5 — Block 3c: UX Polish)

#### Task 9: UX Polish + Error Handling + Logging
- **Description:** Add processing status message (shown if >5s), long voice warning (>3min), global bot error handler (Decision 13), centralize all error messages (no technical details). Add console.log with timestamps for request metadata and errors — never log credentials or PII (Decision 12). Enforce batch limit of 10 voices and output limit of 10 tasks (Decision 10).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `src/handlers/voice.js`, `src/utils/messages.js`, `src/bot.js`
- **Files to read:** `work/mvp-core/user-spec.md`
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
- **Description:** Acceptance testing: run all tests, run `npm audit --audit-level=high`, verify acceptance criteria from user-spec and tech-spec.
- **Skill:** pre-deploy-qa
- **Reviewers:** none

#### Task 14: Deploy
- **Description:** Deploy to VPS via SSH: git pull, npm install, configure .env, setup systemd service, verify bot starts and connects to Telegram. Verify firewall blocks port 8765 externally.
- **Skill:** deploy-pipeline
- **Reviewers:** code-reviewer, security-auditor, deploy-reviewer

#### Task 15: Post-deploy Verification
- **Description:** Live environment verification:
  - Send /start → verify welcome message and trial info
  - Forward voice message → verify task list returned with rating buttons
  - Send text message → verify explanation response
  - Check journalctl for logs (no errors)
  Tools: Telegram MCP (when configured), bash (journalctl, systemctl)
- **Skill:** post-deploy-qa
- **Reviewers:** none
