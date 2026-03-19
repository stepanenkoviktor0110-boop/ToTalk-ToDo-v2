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
