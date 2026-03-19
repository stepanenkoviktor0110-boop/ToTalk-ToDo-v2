/**
 * Voice pipeline orchestrator.
 *
 * Downloads audio via Telegram API, transcribes via faster-whisper,
 * extracts tasks via LLM, formats output, sends to user with rating buttons.
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
  partialFailureNote,
  formatTaskList,
} from '../utils/messages.js';

const DEBOUNCE_MS = 3000;
const MAX_BATCH_SIZE = 10;
const MAX_TRANSCRIPT_LENGTH = 4000;

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

  // Decision 9: reset pending feedback session
  if (
    ctx.session.awaitingFeedback ||
    ctx.session.awaitingComment ||
    ctx.session.awaitingConsent
  ) {
    ctx.session.awaitingFeedback = false;
    ctx.session.voiceRequestId = null;
    ctx.session.awaitingComment = false;
    ctx.session.awaitingConsent = false;
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
 * Persist batch results to the database.
 *
 * @param {{ id: number }} user
 * @param {Array} successfulVoices
 * @param {{ tasks: string[] }} result
 * @param {string} combinedTranscript
 * @param {object} deps
 * @returns {number|null} lastVoiceRequestId
 */
function persistBatch(user, successfulVoices, result, combinedTranscript, deps) {
  const { createVoiceRequest, updateVoiceRequest } = deps;
  let lastVoiceRequestId = null;

  for (const v of successfulVoices) {
    const vr = createVoiceRequest(user.id, v.fileId, v.duration);
    updateVoiceRequest(vr.id, {
      taskCount: result.tasks.length,
      transcriptLength: combinedTranscript.length,
    });
    lastVoiceRequestId = vr.id;
  }

  return lastVoiceRequestId;
}

/**
 * Process a batch of voice messages.
 *
 * Pipeline: trial check → download → transcribe → truncate → extract → format → send → DB
 *
 * @param {object} ctx - grammy context (used for reply and session)
 * @param {Array<{ ctx: object, fileId: string, duration: number }>} voices
 * @param {object} deps - injected dependencies
 */
export async function processVoiceBatch(ctx, voices, deps) {
  const { extractTasks, upsertUser, decrementTrial } = deps;

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

  // Download and transcribe each voice
  const { transcripts, failedCount, successfulVoices } =
    await downloadAndTranscribe(processVoices, deps, ctx.chat.id);

  // All voices failed
  if (transcripts.length === 0) {
    await ctx.reply(ALL_VOICES_FAILED);
    return;
  }

  // Build combined transcript for DB storage
  let combinedTranscript = transcripts.join('\n');
  if (combinedTranscript.length > MAX_TRANSCRIPT_LENGTH) {
    combinedTranscript = combinedTranscript.slice(0, MAX_TRANSCRIPT_LENGTH);
  }

  // Extract tasks — pass array, taskExtractor handles join+truncation
  let result;
  try {
    result = await extractTasks(transcripts, deps.llmProvider);
  } catch (err) {
    const ts = new Date().toISOString();
    // Decision 12: generic error type only, no transcript/PII in logs
    console.error(`[${ts}] task extraction failed: chatId=${ctx.chat.id}, errorType=${err.constructor.name}`);
    await ctx.reply(GENERIC_ERROR);
    return;
  }

  // Handle special markers
  if (result.marker === 'no_tasks') {
    await ctx.reply(NO_TASKS_FOUND);
    return;
  }
  if (result.marker === 'too_many_tasks') {
    await ctx.reply(TOO_MANY_TASKS);
    return;
  }
  if (result.marker === 'summary') {
    await ctx.reply(`📝 ${result.summary}`);
    return;
  }
  if (result.tasks.length === 0) {
    await ctx.reply(NO_TASKS_FOUND);
    return;
  }

  // Build reply, send with rating keyboard, persist to DB
  const message = buildReplyMessage(result, failedCount, processVoices.length, batchLimitExceeded);
  const keyboard = new InlineKeyboard()
    .text('1', 'rate:1').text('2', 'rate:2').text('3', 'rate:3')
    .text('4', 'rate:4').text('5', 'rate:5');

  await ctx.reply(message, { reply_markup: keyboard });

  const lastVoiceRequestId = persistBatch(user, successfulVoices, result, combinedTranscript, deps);
  decrementTrial(user.id);

  // Set session state for feedback flow (Task 7)
  ctx.session.awaitingFeedback = true;
  ctx.session.voiceRequestId = lastVoiceRequestId;
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
