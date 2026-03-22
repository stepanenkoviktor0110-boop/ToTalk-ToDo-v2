# Patterns & Conventions

Coding conventions, development workflow, and project-specific practices.
For universal coding standards, see `~/.claude/skills/code-writing/references/universal-patterns.md`.

---

## Project-Specific Code Patterns

### Pipeline Pattern

Each voice message passes through a sequential pipeline of stages: download audio, transcribe, extract tasks, format output, send to user, request feedback. Each stage is a separate function with single responsibility. Implementation in `src/handlers/voice.js`.

Error at any stage → user-friendly message (not a technical stack trace).

### LLM Provider Abstraction

All LLM calls go through a provider interface (`src/services/llm/provider.js`). Implementations (GigaChat, DeepSeek, Claude) are swappable via config. Never call LLM APIs directly from business logic.

### Prompt as Separate File

System prompt lives in `prompts/task-extraction.md`, not hardcoded in source. This allows iterating on the prompt without changing logic. Commit prefix `prompt:` for prompt-only changes.

### Multi-Voice Context Merging

When multiple voice messages arrive simultaneously (forwarded batch), their transcripts are concatenated before sending to LLM as a single context. The LLM extracts tasks from the combined text.

### Ambiguity Resolution Types

| Type | Speech example | Handling |
|------|---------------|----------|
| Unknown person | "that repairman" | Clarification task: "Find out repairman's contact" |
| Alternative ("or") | "Vanya or Andrey" | Clarification task: "Determine who exactly is needed" |
| Someone else knows | "Anya knows" | Delegation task: "Ask Anya" |

Principle: **never guess — make clarification an explicit step**.

---

## Git Workflow

### Branch Structure

- **`main`** — Production-ready code (protected). Only merge from `dev` after full testing. Triggers production deployment.
- **`dev`** — Active development. Integration branch for all work.
- **`feature/XXX-name`** — For complex features (optional). Created from `dev`, merged back via PR, deleted after merge.

### Branch Decision Criteria

**Direct to `dev`:** Bug fixes, single file changes, simple improvements, docs, config changes, prompt changes, no breaking changes.

**Feature branch:** New features, multiple files affected, breaking changes, new dependencies, external integrations, DB schema changes, architecture changes.

### Commit Prefixes

`feat:`, `fix:`, `prompt:`, `refactor:`, `docs:`, `chore:`

Special prefix `prompt:` — changes only to prompt files (no logic changes).

### Testing Requirements

- **On commit:** Code changed → Unit + Integration tests. Docs/prompts only → Skip tests.
- **On merge to dev:** Unit + Integration (auto). E2E (optional).
- **On merge to main:** Unit + Integration (auto). E2E (strongly recommended).

### Security & Quality Gates

- **Pre-commit:** Gitleaks scans for secrets (API keys, tokens, credentials). Commit blocked if detected.
- **Pre-push:** Code review agent validates changes. All checks must pass.

---

## Testing & Verification

### Test Infrastructure

Framework: Jest (ESM mode). Run with `npm test`.

### Key Test Cases for Task Extraction

1. Simple single task without ambiguities
2. Multiple tasks in one voice message
3. Voice with explicit unknown person ("Anya knows")
4. Voice with alternative ("Vanya or Andrey")
5. Voice with no tasks at all (just thinking aloud)
6. Very short voice (< 5 seconds)
7. Voice with background noise (transcript with errors)

### Agent Verification Methods

None configured yet.

### User Verification Methods

None configured yet.

---

## Business Rules

- No tasks detected → inform user explicitly, don't return empty list silently
- Max 10 tasks per voice message — if more, ask user to split into shorter messages
- Processing > 5 seconds → send status message ("Обрабатываю голосовое..."), auto-deleted when done
- Voice > 3 minutes → warn about longer processing time before processing starts
- Feedback flow (Decision 9): after each task list, show 1-5 rating buttons. Rating=5 → save and thank. Rating<5 → ask text comment → ask voice consent (Yes/No buttons) → save feedback. New voice during pending feedback silently abandons it.
- Voice consent: after comment, ask consent to save original audio for quality improvement. If yes → download audio, save to `data/voices/{id}.oga`, set `audio_path` in DB. If no → `voice_consent=0`, no audio saved.
- User tracking: register every user on first interaction, track usage statistics (total messages, last active, trial remaining).
- Trial system (Decision 15): 30 free → survey (4 questions) → +20 → full block. Phase transitions: phase 1 (30 free) → phase 2 (survey completed, +20) → phase 3 (exhausted).
- Survey flow: 4 questions asked sequentially. Each answer checked by heuristic gate (Q1-Q3: min 5 words, no punctuation-only; Q4: digit 1-5), then LLM sanity check. 2-strike rule per question → permanent block (`survey_blocked=1`). Fail-open on LLM error. Resumption from `survey_progress` in DB if user abandons mid-flow.
- Counter guard: trial counter decrements only on successful task list delivery, not on errors or special markers.
