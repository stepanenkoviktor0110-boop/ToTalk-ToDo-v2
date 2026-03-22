/**
 * Feedback flow + Survey handler.
 *
 * Feedback pipeline (post-task-extraction):
 *   1. Rating callback (rate:1–5) — if 5, save immediately; if <5, ask comment
 *   2. Text comment collection — then ask voice consent
 *   3. Consent callback (consent:yes/no) — save feedback, optionally save audio
 *
 * Survey pipeline (trial exhausted, Decision 15):
 *   4 sequential questions with heuristic gate + LLM sanity check.
 *   2-strike rule per question. Fail-open on LLM error. Resumption from DB state.
 *
 * Decision 9: new voice during pending feedback silently abandons it (handled in voice.js).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InlineKeyboard } from 'grammy';
import {
  FEEDBACK_THANKS,
  FEEDBACK_ASK_COMMENT,
  FEEDBACK_ASK_CONSENT,
  FEEDBACK_SAVED,
  FEEDBACK_EXPIRED,
  FEEDBACK_PRESS_BUTTON,
  SURVEY_INTRO,
  SURVEY_RETRY,
  SURVEY_BLOCKED,
  SURVEY_COMPLETE,
  SURVEY_QUESTIONS,
  formatSurveyQuestion,
} from '../utils/messages.js';

const VOICES_DIR = join(process.cwd(), 'data', 'voices');

// ── Feedback helpers ────────────────────────────────────────────────────────

/**
 * Reset all feedback-related session fields.
 * @param {object} session
 */
function resetFeedbackSession(session) {
  session.awaitingFeedback = false;
  session.voiceRequestId = null;
  session.awaitingComment = false;
  session.awaitingConsent = false;
  session.pendingRating = null;
  session.pendingComment = null;
}

/**
 * Handle rating callback query (rate:1 through rate:5).
 * @param {object} ctx - grammy callback query context
 * @param {object} deps - injected dependencies
 */
async function handleRating(ctx, deps) {
  if (!ctx.session.awaitingFeedback) {
    await ctx.answerCallbackQuery({ text: FEEDBACK_EXPIRED });
    return;
  }

  const rating = parseInt(ctx.callbackQuery.data.split(':')[1], 10);
  if (isNaN(rating) || rating < 1 || rating > 5) return;

  await ctx.answerCallbackQuery();
  ctx.session.awaitingFeedback = false;

  if (rating === 5) {
    deps.saveFeedback(ctx.session.voiceRequestId, 5, null, 0);
    resetFeedbackSession(ctx.session);
    await ctx.reply(FEEDBACK_THANKS);
    return;
  }

  // Rating < 5: ask for comment
  ctx.session.pendingRating = rating;
  ctx.session.awaitingComment = true;
  await ctx.reply(FEEDBACK_ASK_COMMENT);
}

/**
 * Handle consent callback query (consent:yes / consent:no).
 * Saves feedback to DB. If consent=yes, downloads and saves audio file.
 * @param {object} ctx - grammy callback query context
 * @param {object} deps - injected dependencies
 */
async function handleConsent(ctx, deps) {
  if (!ctx.session.awaitingConsent) {
    await ctx.answerCallbackQuery({ text: FEEDBACK_EXPIRED });
    return;
  }

  const consent = ctx.callbackQuery.data === 'consent:yes' ? 1 : 0;
  await ctx.answerCallbackQuery();

  const voiceRequestId = ctx.session.voiceRequestId;
  const rating = ctx.session.pendingRating;
  const comment = ctx.session.pendingComment;

  deps.saveFeedback(voiceRequestId, rating, comment, consent);

  // If consent given, save audio file
  if (consent === 1 && voiceRequestId) {
    try {
      const vr = deps.getVoiceRequest(voiceRequestId);
      if (vr && vr.telegram_file_id) {
        const fileInfo = await ctx.api.getFile(vr.telegram_file_id);
        const audioBuffer = await deps.fetchFile(deps.botToken, fileInfo.file_path);

        await mkdir(VOICES_DIR, { recursive: true });
        const relativePath = `data/voices/${voiceRequestId}.oga`;
        await writeFile(join(process.cwd(), relativePath), audioBuffer);

        deps.updateVoiceRequest(voiceRequestId, { audioPath: relativePath });
      }
    } catch (err) {
      // Non-critical: feedback is saved, audio saving is best-effort
      const ts = new Date().toISOString();
      console.error(
        `[${ts}] Failed to save voice audio: voiceRequestId=${voiceRequestId}, error=${err.message}`
      );
    }
  }

  resetFeedbackSession(ctx.session);
  await ctx.reply(FEEDBACK_SAVED);
}

// ── Survey helpers ──────────────────────────────────────────────────────────

const SANITY_CHECK_PROMPT =
  'Ты проверяешь ответы на опрос о Telegram-боте. ' +
  'Пользователю задан вопрос, и он дал ответ. ' +
  'Определи: ответ осмысленный и по теме, или это мусор (бессмыслица, не по теме, отписка). ' +
  'Ответь одним словом: "адекватный" или "неадекватный".';

/**
 * Heuristic gate — fast pre-check before LLM sanity check (Decision 5).
 * Q1-Q3: reject under 5 words or punctuation/emoji-only.
 * Q4: accept single digit 1-5.
 *
 * @param {number} questionIndex - 0-based question index
 * @param {string} answer - user's answer text
 * @returns {boolean} true if passes gate
 */
export function passesHeuristicGate(questionIndex, answer) {
  const trimmed = answer.trim();
  if (!trimmed) return false;

  // Q4 (index 3): accept single digit 1-5
  if (questionIndex === 3) {
    return /^[1-5]$/.test(trimmed);
  }

  // Q1-Q3: reject punctuation/emoji-only
  if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) return false;

  // Q1-Q3: reject under 5 words
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return words.length >= 5;
}

/**
 * LLM sanity check — ask LLM if the answer is adequate (Decision 5).
 * Fail-open: if LLM call fails, accept the answer.
 *
 * @param {string} answer - user's answer
 * @param {string} questionText - the survey question
 * @param {object} llmProvider - LLM provider with complete() method
 * @returns {Promise<boolean>} true if adequate or LLM unavailable
 */
async function llmSanityCheck(answer, questionText, llmProvider) {
  try {
    const userMessage = `Вопрос: ${questionText}\nОтвет: ${answer}`;
    const response = await llmProvider.complete(SANITY_CHECK_PROMPT, userMessage);
    const r = response.trim().toLowerCase();
    if (r.includes('неадекватный')) return false;
    if (r.includes('адекватный')) return true;
    // Ambiguous response — fail-open
    return true;
  } catch {
    // Fail-open: LLM unavailable → accept answer
    return true;
  }
}

/**
 * Handle a survey answer from the user.
 *
 * Flow per answer:
 *   1. Heuristic gate (fast, no LLM)
 *   2. LLM sanity check (fail-open)
 *   3. If inadequate: increment retries, 2nd strike → block
 *   4. If adequate: save to DB, advance progress, ask next or complete
 *
 * @param {object} ctx - grammy context
 * @param {object} deps - injected dependencies
 */
async function handleSurveyAnswer(ctx, deps) {
  const userId = ctx.from.id;
  const user = deps.getUserByTelegramId(userId);
  if (!user) return;

  const questionIndex = user.survey_progress;
  if (questionIndex >= SURVEY_QUESTIONS.length) return;

  const answer = ctx.message.text;
  const questionText = SURVEY_QUESTIONS[questionIndex];

  // Step 1: Heuristic gate
  let isAdequate = passesHeuristicGate(questionIndex, answer);
  let rejectionReason = isAdequate ? null : 'heuristic';

  // Step 2: LLM sanity check (only if heuristic passed, Q4 skips LLM)
  if (isAdequate && questionIndex < 3) {
    const llmResult = await llmSanityCheck(answer, questionText, deps.llmProvider);
    if (!llmResult) {
      isAdequate = false;
      rejectionReason = 'llm';
    }
  }

  // Step 3: Handle inadequate answer
  if (!isAdequate) {
    const retryKey = String(questionIndex);
    const currentRetries = ctx.session.surveyRetries[retryKey] || 0;

    if (currentRetries >= 1) {
      // 2nd strike — block survey permanently
      deps.saveSurveyResponse(user.id, questionIndex + 1, answer, 0, rejectionReason);
      deps.blockSurvey(user.id);
      ctx.session.inSurvey = false;
      ctx.session.surveyRetries = {};

      const ts = new Date().toISOString();
      console.log(
        `[${ts}] survey_blocked: userId=${user.id}, questionNum=${questionIndex + 1}`
      );

      await ctx.reply(SURVEY_BLOCKED);
      return;
    }

    // 1st strike — ask to retry
    ctx.session.surveyRetries[retryKey] = currentRetries + 1;
    deps.saveSurveyResponse(user.id, questionIndex + 1, answer, 0, rejectionReason);
    await ctx.reply(SURVEY_RETRY);
    return;
  }

  // Step 4: Adequate answer — save and advance
  deps.saveSurveyResponse(user.id, questionIndex + 1, answer, 1, null);
  deps.advanceSurveyProgress(user.id);

  const nextIndex = questionIndex + 1;

  if (nextIndex >= SURVEY_QUESTIONS.length) {
    // Survey complete — unlock +20
    deps.completeSurvey(user.id);
    ctx.session.inSurvey = false;
    ctx.session.surveyRetries = {};
    await ctx.reply(SURVEY_COMPLETE);
    return;
  }

  // Ask next question
  await ctx.reply(formatSurveyQuestion(nextIndex));
}

/**
 * Enter survey mode: send intro (if first time) + current question.
 * Called from voice.js when trial exhausted and user is eligible.
 *
 * @param {object} ctx - grammy context
 * @param {object} user - DB user row
 */
export async function enterSurvey(ctx, user) {
  ctx.session.inSurvey = true;

  const questionIndex = user.survey_progress;
  const intro = questionIndex === 0 ? SURVEY_INTRO + '\n\n' : '';
  await ctx.reply(intro + formatSurveyQuestion(questionIndex));
}

// ── Handler registration ────────────────────────────────────────────────────

/**
 * Register feedback + survey handlers on a grammy bot instance.
 *
 * Must be registered AFTER session middleware and BEFORE voice handler,
 * so callback queries are intercepted correctly.
 *
 * @param {import('grammy').Bot} bot
 * @param {object} deps - dependency bag
 */
export function registerFeedbackHandler(bot, deps) {
  // Callback queries: ratings and consent buttons
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith('rate:')) {
      return handleRating(ctx, deps);
    }
    if (data.startsWith('consent:')) {
      return handleConsent(ctx, deps);
    }
    return next();
  });

  // Text messages: survey answers, comment collection, consent reminder.
  // Reached only when bot.js catch-all calls next() for these states.
  bot.on('message:text', async (ctx, next) => {
    // Survey answer collection
    if (ctx.session.inSurvey) {
      return handleSurveyAnswer(ctx, deps);
    }

    // Feedback comment collection
    if (ctx.session.awaitingComment) {
      const comment = ctx.message.text;
      ctx.session.pendingComment = comment;
      ctx.session.awaitingComment = false;
      ctx.session.awaitingConsent = true;

      const keyboard = new InlineKeyboard()
        .text('Да', 'consent:yes')
        .text('Нет', 'consent:no');

      await ctx.reply(FEEDBACK_ASK_CONSENT, { reply_markup: keyboard });
      return;
    }

    // User sent text during consent (should press buttons)
    if (ctx.session.awaitingConsent) {
      await ctx.reply(FEEDBACK_PRESS_BUTTON);
      return;
    }

    return next();
  });
}
