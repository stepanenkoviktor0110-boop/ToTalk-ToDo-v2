/**
 * Voice pipeline orchestrator.
 *
 * Downloads audio via Telegram API, transcribes via faster-whisper,
 * shows transcript with action buttons [📋 Извлечь задачи] [📝 Сделать резюме].
 * User chooses which action to run — task extraction or summary.
 *
 * Implements per-chat debounce buffer (3s) for multi-voice context merging,
 * partial failure handling, and trial enforcement.
 */

import { basename } from 'node:path';
import { InlineKeyboard } from 'grammy';
import {
  TRIAL_EXHAUSTED,
  NO_TASKS_FOUND,
  TOO_MANY_TASKS,
  ALL_VOICES_FAILED,
  GENERIC_ERROR,
  BATCH_LIMIT_NOTE,
  TRANSCRIPT_TRUNCATED_NOTE,
  PROCESSING_STATUS,
  LONG_VOICE_WARNING,
  partialFailureNote,
  ACTION_KEYBOARD,
  ACTION_TASKS_BTN,
  ACTION_SUMMARY_BTN,
} from '../utils/messages.js';
import { enterSurvey } from './feedback.js';

const DEBOUNCE_MS = 3000;
const MAX_BATCH_SIZE = 10;
const MAX_TRANSCRIPT_LENGTH = 4000;
const STATUS_DELAY_MS = 5000;
const LONG_VOICE_SECONDS = 180; // 3 minutes

/**
 * Per-chat debounce buffer.
 * Key: chatId (number)
 * Value: { voices: Array<{ ctx, fileId, duration }>, timer: ReturnType<setTimeout>, deps }
 * @type {Map<number, { voices: Array, timer: any, deps: object }>}
 */
const debounceBuffers = new Map();

/** Clear all buffers (for test cleanup). */
export function clearBuffers() {
  for (const [, entry] of debounceBuffers) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  debounceBuffers.clear();
}

/** Return current buffer size for a chat (test inspector). */
export function getBufferSize(chatId) {
  const entry = debounceBuffers.get(chatId);
  return entry ? entry.voices.length : 0;
}

/** Check whether a buffer exists for a chat. */
export function hasBuffer(chatId) {
  return debounceBuffers.has(chatId);
}

/**
 * Sanitize a string by removing bot tokens from Telegram API URLs.
 * Decision 16: credential sanitization in error handlers.
 * @param {string} str
 * @returns {string}
 */
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
}

/**
 * Delete the "processing..." status message if it was sent.
 * Best-effort — silently ignores failures.
 *
 * @param {object} ctx - grammy context
 * @param {number|null} messageId
 */
async function deleteStatusMessage(ctx, messageId) {
  if (messageId) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, messageId);
    } catch { /* non-critical */ }
  }
}

/**
 * Handle an incoming voice/audio message.
 *
 * Adds the voice to a per-chat debounce buffer. When the 3s timer fires,
 * the entire batch is processed as a single context.
 *
 * @param {object} ctx - grammy context
 * @param {object} deps - injected dependencies
 */
export function handleVoice(ctx, deps) {
  const chatId = ctx.chat.id;
  const voice = ctx.message.voice ?? ctx.message.audio;
  if (!voice) return;
  const fileId = voice.file_id;
  const duration = voice.duration || 0;

  // Decision 9: reset pending feedback AND action sessions
  if (
    ctx.session.awaitingFeedback ||
    ctx.session.awaitingComment ||
    ctx.session.awaitingConsent ||
    ctx.session.awaitingAction
  ) {
    ctx.session.awaitingFeedback = false;
    ctx.session.voiceRequestId = null;
    ctx.session.awaitingComment = false;
    ctx.session.awaitingConsent = false;
    ctx.session.awaitingAction = false;
    ctx.session.pendingAction = null;
    ctx.session.transcript = null;
  }

  const voiceEntry = { ctx, fileId, duration };

  if (debounceBuffers.has(chatId)) {
    const entry = debounceBuffers.get(chatId);
    clearTimeout(entry.timer);
    entry.voices.push(voiceEntry);
    entry.timer = setTimeout(() => onTimerFire(chatId), DEBOUNCE_MS);
  } else {
    const entry = {
      voices: [voiceEntry],
      timer: setTimeout(() => onTimerFire(chatId), DEBOUNCE_MS),
      deps,
      // Keep first ctx for replying after batch processing
      replyCtx: ctx,
    };
    debounceBuffers.set(chatId, entry);
  }
}

/**
 * Called when the debounce timer fires for a chat.
 * Extracts the buffer entry and triggers batch processing.
 */
function onTimerFire(chatId) {
  const entry = debounceBuffers.get(chatId);
  if (!entry) return;
  debounceBuffers.delete(chatId);

  // Fire and forget — errors are handled inside processVoiceBatch
  processVoiceBatch(entry.replyCtx, entry.voices, entry.deps).catch((err) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] processVoiceBatch unexpected error: chatId=${chatId}, error=${sanitize(err.message)}`);
  });
}

/**
 * Download and transcribe each voice in the batch.
 *
 * @param {Array<{ ctx: object, fileId: string, duration: number }>} processVoices
 * @param {object} deps - injected dependencies
 * @param {number} chatId - for logging
 * @returns {Promise<{ transcripts: string[], failedCount: number, successfulVoices: Array }>}
 */
async function downloadAndTranscribe(processVoices, deps, chatId) {
  const { transcribe, fetchFile, botToken } = deps;
  const transcripts = [];
  let failedCount = 0;
  const successfulVoices = [];

  for (let i = 0; i < processVoices.length; i++) {
    const v = processVoices[i];
    try {
      const fileInfo = await v.ctx.api.getFile(v.fileId);
      const filePath = fileInfo.file_path;
      const audioBuffer = await fetchFile(botToken, filePath);
      // Sanitize filename from Telegram (defense-in-depth)
      const safeFilename = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_') || 'audio.oga';
      const transcript = await transcribe(audioBuffer, safeFilename);
      transcripts.push(transcript);
      successfulVoices.push(v);
    } catch (err) {
      failedCount++;
      const ts = new Date().toISOString();
      // Decision 12: log metadata only, no transcript/PII/fileId
      console.error(
        `[${ts}] voice transcription failed: chatId=${chatId}, voiceIndex=${i}, error=${sanitize(err.message)}`
      );
    }
  }

  return { transcripts, failedCount, successfulVoices };
}

/**
 * Build the reply message from extraction result and notes.
 *
 * @param {{ tasks: string[], truncated: boolean }} result
 * @param {number} failedCount
 * @param {number} totalCount
 * @param {boolean} batchLimitExceeded
 * @returns {string}
 */
function buildReplyMessage(result, failedCount, totalCount, batchLimitExceeded) {
  let message = formatTaskList(result.tasks);

  if (result.truncated) {
    message += TRANSCRIPT_TRUNCATED_NOTE;
  }
  if (failedCount > 0) {
    message += partialFailureNote(failedCount, totalCount);
  }
  if (batchLimitExceeded) {
    message += '\n\n' + BATCH_LIMIT_NOTE;
  }

  return message;
}

/**
 * Persist voice request to the database (after transcription, before action choice).
 *
 * @param {{ id: number }} user
 * @param {Array} successfulVoices
 * @param {string} combinedTranscript
 * @param {object} deps
 * @returns {number|null} lastVoiceRequestId
 */
function persistVoiceRequest(user, successfulVoices, combinedTranscript, deps) {
  const { createVoiceRequest, updateVoiceRequest } = deps;
  let lastVoiceRequestId = null;

  for (const v of successfulVoices) {
    const vr = createVoiceRequest(user.id, v.fileId, v.duration);
    updateVoiceRequest(vr.id, {
      transcriptLength: combinedTranscript.length,
    });
    lastVoiceRequestId = vr.id;
  }

  return lastVoiceRequestId;
}

/**
 * Show "typing..." indicator repeatedly until the returned stop function is called.
 * Telegram clears the indicator after 5s, so we refresh every 4s.
 *
 * @param {object} ctx - grammy context
 * @returns {Function} stop — call to cancel the interval
 */
function startTyping(ctx) {
  const send = () => ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

/**
 * Process a batch of voice messages.
 *
 * Pipeline: trial check → download → transcribe → show transcript + action buttons
 * (user chooses: tasks or summary — handled by callback in feedback.js)
 *
 * @param {object} ctx - grammy context (used for reply and session)
 * @param {Array<{ ctx: object, fileId: string, duration: number }>} voices
 * @param {object} deps - injected dependencies
 */
export async function processVoiceBatch(ctx, voices, deps) {
  const { upsertUser } = deps;

  // Guard: channel posts may have no ctx.from
  if (!ctx.from) {
    console.warn(`[${new Date().toISOString()}] voice message with no ctx.from (chatId=${ctx.chat?.id}), ignoring`);
    return;
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || null;

  // Upsert user and check trial
  const user = upsertUser(userId, username);
  if (user.trial_remaining === 0) {
    // Check if eligible for survey (Decision 15)
    if (user.trial_phase === 1 && !user.survey_blocked && user.survey_progress < 4) {
      await enterSurvey(ctx, user);
      return;
    }
    await ctx.reply(TRIAL_EXHAUSTED);
    return;
  }

  // Enforce batch limit (Decision 10)
  let batchLimitExceeded = false;
  let processVoices = voices;
  if (voices.length > MAX_BATCH_SIZE) {
    batchLimitExceeded = true;
    processVoices = voices.slice(0, MAX_BATCH_SIZE);
  }

  // Long voice warning (>3 min) — send before processing starts
  const maxDuration = Math.max(...processVoices.map((v) => v.duration));
  if (maxDuration > LONG_VOICE_SECONDS) {
    await ctx.reply(LONG_VOICE_WARNING);
  }

  // Show typing indicator for the duration of processing
  const stopTyping = startTyping(ctx);

  // Status message if processing takes >5s
  let statusMessageId = null;
  const statusTimer = setTimeout(async () => {
    try {
      const sent = await ctx.reply(PROCESSING_STATUS);
      statusMessageId = sent.message_id;
    } catch { /* non-critical */ }
  }, STATUS_DELAY_MS);

  const pipelineStart = Date.now();

  // Download and transcribe each voice
  const { transcripts, failedCount, successfulVoices } =
    await downloadAndTranscribe(processVoices, deps, ctx.chat.id);

  // All voices failed
  if (transcripts.length === 0) {
    clearTimeout(statusTimer);
    stopTyping();
    await deleteStatusMessage(ctx, statusMessageId);
    await ctx.reply(ALL_VOICES_FAILED);
    return;
  }

  // Build combined transcript for DB storage
  let combinedTranscript = transcripts.join('\n');
  const wasTruncated = combinedTranscript.length > MAX_TRANSCRIPT_LENGTH;
  if (wasTruncated) {
    combinedTranscript = combinedTranscript.slice(0, MAX_TRANSCRIPT_LENGTH);
  }

  // Show transcript + action buttons
  const transcriptMsg = wasTruncated
    ? `🗣 Распознано: ${combinedTranscript}${TRANSCRIPT_TRUNCATED_NOTE}`
    : `🗣 Распознано: ${combinedTranscript}`;

  if (failedCount > 0) {
    // Append failure note to transcript message
    // We'll send it as a follow-up to keep the transcript clean
  }

  const keyboard = new InlineKeyboard()
    .text(ACTION_TASKS_BTN, 'action:tasks')
    .text(ACTION_SUMMARY_BTN, 'action:summary');

  // Store transcript in session for callback handler
  ctx.session.transcript = combinedTranscript;

  // Persist voice request (without action_type yet — set in callback)
  const lastVoiceRequestId = persistVoiceRequest(user, successfulVoices, combinedTranscript, deps);
  ctx.session.voiceRequestId = lastVoiceRequestId;

  // Set action state
  ctx.session.awaitingAction = true;
  ctx.session.pendingAction = null;

  // Decision 12: log request metadata
  const durationMs = Date.now() - pipelineStart;
  const totalDurationSec = processVoices.reduce((sum, v) => sum + v.duration, 0);
  console.log(
    `[${new Date().toISOString()}] voice transcribed: userId=${user.id}, voices=${successfulVoices.length}, audioDuration=${totalDurationSec}s, transcriptLength=${combinedTranscript.length}, pipelineMs=${durationMs}`
  );

  clearTimeout(statusTimer);
  stopTyping();
  await deleteStatusMessage(ctx, statusMessageId);

  // Send transcript with action buttons
  await ctx.reply(`${transcriptMsg}\n\n${ACTION_KEYBOARD}`, { reply_markup: keyboard });

  // If some voices failed, send note after
  if (failedCount > 0) {
    await ctx.reply(partialFailureNote(failedCount, processVoices.length));
  }
  if (batchLimitExceeded) {
    await ctx.reply('\n\n' + BATCH_LIMIT_NOTE);
  }
}

/**
 * Register the voice handler on a grammy bot instance.
 *
 * @param {import('grammy').Bot} bot
 * @param {object} deps - dependency bag
 */
export function registerVoiceHandler(bot, deps) {
  bot.on('message:voice', (ctx) => handleVoice(ctx, deps));
  bot.on('message:audio', (ctx) => handleVoice(ctx, deps));
}
