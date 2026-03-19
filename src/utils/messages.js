/**
 * Centralized module for all user-facing Russian strings.
 * Single source of truth — no hardcoded strings in handlers.
 */

export const WELCOME =
  'Привет! Я помогу превратить голосовые сообщения в список задач.\n\n' +
  'Просто перешли мне голосовое сообщение, и я извлеку из него задачи — ' +
  'уберу словесный мусор, разрешу неопределённости и упорядочу по зависимостям.\n\n' +
  'У тебя есть {TRIAL_REMAINING} бесплатных обработок голосовых сообщений. Начнём!';

export const NON_VOICE_EXPLANATION =
  'Я работаю только с голосовыми сообщениями. ' +
  'Перешли мне голосовое, и я извлеку из него список задач.';

export const GENERIC_ERROR =
  'Что-то пошло не так. Попробуй ещё раз чуть позже.';

// ── Voice handler messages ───────────────────────────────────────────────────

export const TRIAL_EXHAUSTED =
  'К сожалению, лимит бесплатных обработок исчерпан.';

export const NO_TASKS_FOUND =
  'Не удалось выделить задачи из этого сообщения. ' +
  'Попробуй переслать голосовое, в котором есть конкретные поручения.';

export const TOO_MANY_TASKS =
  'В сообщении слишком много задач. Попробуй разбить на несколько коротких голосовых.';

export const ALL_VOICES_FAILED =
  'Не удалось обработать голосовое сообщение. Попробуй ещё раз.';

export const BATCH_LIMIT_NOTE =
  'Принято максимум 10 голосовых за раз, остальные пропущены.';

export const TRANSCRIPT_TRUNCATED_NOTE =
  '\n\n⚠️ Текст был сокращён из-за ограничений по длине.';

/**
 * Build partial failure note.
 * @param {number} failed - number of failed voices
 * @param {number} total - total voices in batch
 * @returns {string}
 */
export function partialFailureNote(failed, total) {
  return `\n\n⚠️ ${failed} из ${total} голосовых не удалось обработать.`;
}

/**
 * Format a numbered task list from an array of task strings.
 * @param {string[]} tasks
 * @returns {string}
 */
export function formatTaskList(tasks) {
  return tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');
}
