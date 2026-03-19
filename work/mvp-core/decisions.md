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

(pending code-reviewer, security-auditor, infrastructure-reviewer)

**Verification:**
- `npm test` → 13 passed
- Smoke test `node -e "import Database from 'better-sqlite3'; ..."` → OK

---

## Task 3: System Prompt for Task Extraction

**Status:** Done
**Commit:** 23b3afe
**Agent:** prompt-engineer
**Summary:** Создан системный промпт `prompts/task-extraction.md` для извлечения задач из транскриптов голосовых сообщений. Промпт на русском языке, содержит правила очистки речевого мусора, разрешения трёх типов неопределённостей (неизвестный человек, альтернатива, делегирование), упорядочивания по зависимостям, защиту от prompt injection и 4 few-shot примера. Маркеры `__NO_TASKS__` и `__TOO_MANY_TASKS__` задокументированы в секции `<markers>` для интеграции с Task 5.
**Deviations:** None

**Reviews:**

(pending prompt-reviewer)

**Verification:**
- Manual walkthrough of 5 sample inputs from task spec — all produce expected outputs

---

## Task 2: LLM Provider Abstraction + GigaChat Client

**Status:** Done
**Commit:** (pending)
**Agent:** llm-engineer
**Summary:** Built the LLM provider abstraction (`LLMProvider` base class with `complete()` contract) and the `GigaChatProvider` implementation with OAuth2 token lifecycle (proactive refresh <60s before expiry, dedup of parallel refresh), retry logic (once on 401 with token refresh, once on 5xx/network error), 15s AbortController timeout, and Sberbank CA cert loading via HTTPS agent. Used constructor injection for `fetchFn` to enable clean unit testing without unstable ESM module mocking. Credential sanitization enforced: error logs contain only status codes and response bodies, never Authorization headers or tokens.
**Deviations:** None

**Reviews:**

(pending code-reviewer, security-auditor, test-reviewer)

**Verification:**
- `npm test` → 24 passed (13 existing + 11 new)
- Smoke test `node -e "import { GigaChatProvider } from './src/services/llm/gigachat.js'; console.log('import OK')"` → OK
