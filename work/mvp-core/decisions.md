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
