# UX Guidelines

## Purpose
UX standards for bot communication in Telegram. Helps agents write consistent bot messages.

---

## Interface Language

**Primary language:** Russian

**Localization:** Single language — no i18n in MVP

---

## Tone of Voice

**Overall tone:** Friendly, concise

**Writing style:** Short sentences. No formalities. The bot speaks as a helpful assistant, not a corporate system. Uses "ты" form. Avoids jargon and technical terms in user-facing messages.

**Voice characteristics:**
- **Formality level:** Casual but respectful — "ты", no slang, no corporate speak
- **Emotional tone:** Warm and supportive — the bot is on the user's side
- **Technical complexity:** Hide all technical details from the user
- **Humor:** Minimal — friendly but not clownish

**Example phrases by context:**

- Good: "Обрабатываю голосовое...", "Вот что нужно сделать:", "Не смог разобрать задачи — попробуй ещё раз?"
- Avoid: "Произошла ошибка #500", "Транскрипция завершена, запускаю NLP-pipeline", "Пожалуйста, повторите попытку позднее"

---

## Domain Glossary

- **Голосовое** — voice message in Telegram (not "аудиосообщение", not "войс")
- **Задача** — extracted action item (not "таск", not "действие")
- **Уточнение** — clarification sub-task when something is ambiguous

---

## Text Patterns

### Bot Responses

All user-facing strings are defined in a single messages module (see `src/utils/telegram.js`).

**Task list** — header line introducing the list, then numbered tasks. Tone: helpful, concise.

**No tasks found** — friendly message explaining nothing actionable was detected, suggesting to try again. Not a dry error.

**Processing status** — short "working on it" message, shown when processing takes more than 5 seconds.

**Long voice warning** — heads-up for voice messages over 3 minutes that processing will take longer.

### Error Messages

Errors are always user-friendly — no technical details, no error codes. Three categories: transcription failure (suggest re-recording in a quiet place), LLM failure (suggest trying again in a minute), non-voice message (explain what the bot does).

### Feedback Request

After returning the task list, bot asks for a 1-5 rating. If rating is below 5, bot asks for a short comment explaining what was wrong. After receiving feedback, bot thanks the user. All strings in the messages module.
