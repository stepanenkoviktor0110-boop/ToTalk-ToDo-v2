# Decisions Log: mvp-core

Agent reports on completed tasks. Each entry is written by the agent that executed the task.

---

<!-- Entries are added by agents as tasks are completed.

Format is strict — use only these sections, do not add others.
Do not include: file lists, findings tables, JSON reports, step-by-step logs.
Review details — in JSON files via links. QA report — in logs/working/.

## Task N: [title]

**Status:** Done
**Commit:** abc1234
**Agent:** [teammate name or "main agent"]
**Summary:** 1-3 sentences: what was done, key decisions. Not a file list.
**Deviations:** None / Deviated from spec: [reason], did [what].

**Reviews:**

*Round 1:*
- code-reviewer: 2 findings → [logs/working/task-N/code-reviewer-1.json]
- security-auditor: OK → [logs/working/task-N/security-auditor-1.json]

*Round 2 (after fixes):*
- code-reviewer: OK → [logs/working/task-N/code-reviewer-2.json]

**Verification:**
- `npm test` → 42 passed
- Manual check → OK

-->

## Task 1: Project Scaffold + SQLite Layer

**Status:** Done
**Commit:** 911e761
**Agent:** scaffolder
**Summary:** Initialized the greenfield Node.js ESM project with all runtime and dev dependencies, folder structure, .gitignore, and .env.example. Built the complete SQLite layer: connection singleton with WAL mode and foreign keys, migration runner with tracking table, 001_initial.sql creating all 4 tables, and all 11 named query functions. TDD approach: 13 tests written first, confirmed failing, then implementation made them pass.
**Deviations:** None

**Reviews:**

*Round 1:*
- code-reviewer: pass (2 major, 5 minor) → [logs/working/task-1/code-reviewer-1.json]
- security-auditor: pass (0 critical, 3 minor) → [logs/working/task-1/security-auditor-1.json]
- infrastructure-reviewer: pass (0 critical, 2 minor) → [logs/working/task-1/infrastructure-reviewer-1.json]

**Verification:**
- `npm test` → 13 passed
- Smoke test `node -e "import Database from 'better-sqlite3'; ..."` → OK

---

## Task 2: LLM Provider Abstraction + GigaChat Client

**Status:** Done
**Commit:** 052f23c, ee54fc3
**Agent:** llm-engineer
**Summary:** Built the LLM provider abstraction (`LLMProvider` base class with `complete()` contract) and the `GigaChatProvider` implementation with OAuth2 token lifecycle (proactive refresh <60s before expiry, dedup of parallel refresh), retry logic (once on 401 with token refresh, once on 5xx/network error), 15s AbortController timeout, and Sberbank CA cert loading via HTTPS agent. Used constructor injection for `fetchFn` to enable clean unit testing. Round 1 review found 3 critical issues (Windows path, retry bypass, dedup bypass) — all fixed in Round 2.
**Deviations:** None

**Reviews:**

*Round 1:*
- code-reviewer: fail (3 critical, 4 major) → [logs/working/task-2/code-reviewer-1.json]
- security-auditor: pass (3 major) → [logs/working/task-2/security-auditor-1.json]
- test-reviewer: fail (4 major gaps) → [logs/working/task-2/test-reviewer-1.json]

*Round 2 (after fixes):*
- code-reviewer: pass (2 minor remain) → [logs/working/task-2/code-reviewer-2.json]
- security-auditor: pass (1 minor remain) → [logs/working/task-2/security-auditor-2.json]
- test-reviewer: pass (2 minor remain) → [logs/working/task-2/test-reviewer-2.json]

**Verification:**
- `npm test` → 29 passed (13 DB + 16 LLM)
- Smoke test import → OK

---

## Task 3: System Prompt for Task Extraction

**Status:** Done
**Commit:** 23b3afe, 5de23c5
**Agent:** prompt-engineer
**Summary:** Создан системный промпт `prompts/task-extraction.md` для извлечения задач из транскриптов голосовых сообщений. Промпт на русском языке, содержит правила очистки речевого мусора, разрешения трёх типов неопределённостей, упорядочивания по зависимостям, защиту от prompt injection и 5 few-shot примеров. Round 1 review нашёл 3 major: баг с "одним словом" vs маркеры, отсутствие примера TOO_MANY_TASKS, слабая injection-защита — все исправлены в Round 2.
**Deviations:** None

**Reviews:**

*Round 1:*
- prompt-reviewer: fail (3 major) → [logs/working/task-3/prompt-reviewer-1.json]

*Round 2 (after fixes):*
- prompt-reviewer: pass (minors only) → [logs/working/task-3/prompt-reviewer-2.json]

**Verification:**
- Manual walkthrough of 5 sample inputs — all produce expected outputs

---

## Task 4: Bot Entry Point + Handler Skeleton

**Status:** Done
**Commit:** efa508b
**Agent:** bot-builder
**Summary:** Created grammy bot entry point (`src/bot.js`) with `createBot()` factory function, session middleware matching tech-spec contract (awaitingFeedback, voiceRequestId, awaitingComment, awaitingConsent, inSurvey, surveyRetries), /start handler with upsertUser and dynamic trial info in welcome message, non-voice message handlers for text/photo/sticker/document/video/audio/animation/location/contact that exclude voice messages (left for Task 6), and global error handler with credential sanitization (Decision 16). Created centralized messages module (`src/utils/messages.js`) with all Russian strings. TDD: 13 tests written first (10 bot + 3 messages), confirmed failing, then implementation made all pass.
**Deviations:** Added `options` parameter to `createBot()` to accept grammy `botInfo` for testability — not in spec but necessary for unit testing without network calls.

**Reviews:**

(no review round — direct implementation)

**Verification:**
- `npm test` → 59 passed (29 existing + 16 LLM + 10 bot + 3 messages + 1 extra from llm.test.js)

---

## Task 5: Transcription + Task Extraction Services

**Status:** Done
**Commit:** (see below)
**Agent:** service-builder
**Summary:** Built two core service modules: `src/services/transcription.js` (faster-whisper HTTP client with 20s AbortController timeout, multipart/form-data via node-fetch v3 built-in FormData/Blob, WHISPER_URL env var support) and `src/services/taskExtractor.js` (reads system prompt from `prompts/task-extraction.md` with lazy caching, concatenates transcripts, truncates at 4000 chars, calls LLM provider, parses numbered list / __NO_TASKS__ / __TOO_MANY_TASKS__ markers). Both use constructor/parameter injection for testability following the GigaChat pattern.
**Deviations:** None

**Reviews:**

(no review round — direct implementation)

**Verification:**
- `npm test` (db + llm + transcription + taskExtractor) → 46 passed (29 existing + 17 new)
