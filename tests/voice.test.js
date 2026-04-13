import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  TRIAL_EXHAUSTED,
  NO_TASKS_FOUND,
  TOO_MANY_TASKS,
  ALL_VOICES_FAILED,
  BATCH_LIMIT_NOTE,
  TRANSCRIPT_TRUNCATED_NOTE,
  GENERIC_ERROR,
  partialFailureNote,
} from '../src/utils/messages.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal grammy-compatible context factory */
function makeCtx({
  chatId = 100,
  userId = 12345,
  username = 'testuser',
  fileId = 'voice_file_1',
  duration = 10,
  session = {},
  hasFrom = true,
} = {}) {
  const ctx = {
    chat: { id: chatId },
    from: hasFrom ? { id: userId, username } : undefined,
    message: {
      voice: { file_id: fileId, file_unique_id: 'u1', duration },
    },
    session: {
      awaitingFeedback: false,
      voiceRequestId: null,
      awaitingComment: false,
      awaitingConsent: false,
      inSurvey: false,
      surveyRetries: {},
      ...session,
    },
    api: {
      getFile: jest.fn().mockResolvedValue({
        file_path: 'voice/file_0.oga',
      }),
      sendChatAction: jest.fn().mockResolvedValue(true),
    },
    reply: jest.fn().mockResolvedValue({ message_id: 99 }),
  };
  return ctx;
}

/** Minimal audio-message context (no voice, has audio) */
function makeAudioCtx(overrides = {}) {
  const ctx = makeCtx(overrides);
  ctx.message = {
    audio: { file_id: overrides.fileId || 'audio_file_1', file_unique_id: 'a1', duration: overrides.duration || 10 },
  };
  return ctx;
}

/** Default dependency bag */
function makeDeps({
  transcribeResult = 'купить молоко и хлеб',
  extractResult = { tasks: ['Купить молоко', 'Купить хлеб'], marker: null, truncated: false },
  user = { id: 1, telegram_user_id: 12345, trial_remaining: 25, trial_phase: 1 },
} = {}) {
  return {
    transcribe: jest.fn().mockResolvedValue(transcribeResult),
    extractTasks: jest.fn().mockResolvedValue(extractResult),
    fetchFile: jest.fn().mockResolvedValue(Buffer.from('fake-audio')),
    upsertUser: jest.fn().mockReturnValue(user),
    getUserByTelegramId: jest.fn().mockReturnValue(user),
    createVoiceRequest: jest.fn().mockReturnValue({ id: 10 }),
    updateVoiceRequest: jest.fn(),
    saveFeedback: jest.fn(),
    decrementTrial: jest.fn().mockReturnValue(user.trial_remaining - 1),
    botToken: 'test-token',
    llmProvider: { complete: jest.fn().mockResolvedValue('1. Task one') },
  };
}

// ── import module under test ─────────────────────────────────────────────────

const { handleVoice, processVoiceBatch, clearBuffers, hasBuffer, getBufferSize } =
  await import('../src/handlers/voice.js');

// ── tests ────────────────────────────────────────────────────────────────────

describe('voice handler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearBuffers();
  });
  afterEach(() => {
    jest.useRealTimers();
    clearBuffers();
  });

  // ── single voice happy path ──────────────────────────────────────────────

  describe('single voice', () => {
    it('downloads audio, transcribes, shows action buttons', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.fetchFile).toHaveBeenCalled();
      expect(deps.transcribe).toHaveBeenCalled();
      // Should NOT extract tasks yet — shows action buttons first
      expect(deps.extractTasks).not.toHaveBeenCalled();
      // Should reply with transcript + action buttons
      expect(ctx.reply).toHaveBeenCalled();
      const replyCall = ctx.reply.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('Распознано')
      );
      expect(replyCall).toBeDefined();
      // Should have action buttons in reply_markup
      const kbCall = ctx.reply.mock.calls.find(
        (c) => c[1] && c[1].reply_markup
      );
      expect(kbCall).toBeDefined();
      const buttons = kbCall[1].reply_markup.inline_keyboard.flat();
      expect(buttons.map((b) => b.callback_data)).toEqual([
        'action:tasks', 'action:summary',
      ]);
      // Session state set for action choice
      expect(ctx.session.awaitingAction).toBe(true);
      expect(ctx.session.transcript).toBe('купить молоко и хлеб');
      expect(ctx.session.voiceRequestId).toBe(10);
    });

    it('does NOT decrement trial until action is chosen', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.decrementTrial).not.toHaveBeenCalled();
    });

    it('creates voice_request record in DB', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.createVoiceRequest).toHaveBeenCalledWith(1, 'voice_file_1', 10);
      expect(deps.updateVoiceRequest).toHaveBeenCalledWith(10, {
        transcriptLength: expect.any(Number),
      });
      // Session updated for action flow
      expect(ctx.session.awaitingAction).toBe(true);
      expect(ctx.session.voiceRequestId).toBe(10);
    });

    it('does NOT decrement trial on pipeline error', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      deps.extractTasks.mockRejectedValue(new Error('LLM failure'));

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.decrementTrial).not.toHaveBeenCalled();
    });

    it('handles audio messages (message:audio)', async () => {
      const ctx = makeAudioCtx({ fileId: 'audio_file_1' });
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.fetchFile).toHaveBeenCalled();
      expect(deps.transcribe).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalled();
    });

    // Markers (no_tasks, too_many_tasks) are handled in action callback handler,
    // not in voice handler. Voice handler only shows transcript + action buttons.

    it('ignores voice message with no ctx.from (channel posts)', async () => {
      const ctx = makeCtx({ hasFrom: false });
      const deps = makeDeps();
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.transcribe).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ── credential sanitization ───────────────────────────────────────────────

  describe('credential sanitization', () => {
    it('does not log bot token on fetchFile error', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const TOKEN = 'secret-bot-token-12345';
      const deps = makeDeps();
      deps.botToken = TOKEN;
      deps.fetchFile.mockRejectedValue(
        new Error(`GET https://api.telegram.org/file/bot${TOKEN}/voice/x.oga failed`)
      );
      const ctx = makeCtx();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain(TOKEN);
      }
      spy.mockRestore();
    });

    it('does not log bot token on transcription error', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const TOKEN = 'secret-bot-token-67890';
      const deps = makeDeps();
      deps.botToken = TOKEN;
      deps.transcribe.mockRejectedValue(
        new Error(`Request to https://api.telegram.org/file/bot${TOKEN}/path failed`)
      );
      const ctx = makeCtx();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain(TOKEN);
      }
      spy.mockRestore();
    });
  });

  // ── debounce buffer ──────────────────────────────────────────────────────

  describe('debounce buffer', () => {
    it('first voice starts 3s timer', () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);

      expect(hasBuffer(100)).toBe(true);
      expect(getBufferSize(100)).toBe(1);
      // Timer should not have fired yet
      expect(deps.transcribe).not.toHaveBeenCalled();
    });

    it('second voice within window resets timer', () => {
      const deps = makeDeps();
      const ctx1 = makeCtx({ fileId: 'v1' });
      const ctx2 = makeCtx({ fileId: 'v2' });

      handleVoice(ctx1, deps);
      jest.advanceTimersByTime(2000); // 2s in
      handleVoice(ctx2, deps);

      expect(getBufferSize(100)).toBe(2);

      // At 3s from start (1s after second voice), should NOT have fired
      jest.advanceTimersByTime(1000);
      expect(deps.transcribe).not.toHaveBeenCalled();

      // At 3s from second voice, should fire
      jest.advanceTimersByTime(2000);
    });

    it('timer fires with combined transcripts', async () => {
      const deps = makeDeps({
        transcribeResult: 'part one',
      });
      // Alternate transcript for second voice
      let callCount = 0;
      deps.transcribe.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 'part one' : 'part two');
      });

      const ctx1 = makeCtx({ fileId: 'v1' });
      const ctx2 = makeCtx({ fileId: 'v2' });

      handleVoice(ctx1, deps);
      handleVoice(ctx2, deps);

      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // Transcribe called twice (once per voice)
      expect(deps.transcribe).toHaveBeenCalledTimes(2);
      // extractTasks NOT called yet — user chooses via action buttons
      expect(deps.extractTasks).not.toHaveBeenCalled();
      // Should reply with transcript + action buttons
      expect(ctx1.reply).toHaveBeenCalled();
      // Session should have combined transcript
      expect(ctx1.session.transcript).toContain('part one');
      expect(ctx1.session.transcript).toContain('part two');
      expect(ctx1.session.awaitingAction).toBe(true);
    });

    it('voice after timer fires starts new buffer', async () => {
      const deps = makeDeps();
      const ctx1 = makeCtx({ fileId: 'v1' });
      const ctx2 = makeCtx({ fileId: 'v2' });

      handleVoice(ctx1, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // First batch processed
      expect(deps.transcribe).toHaveBeenCalledTimes(1);

      // New voice after timer — should start fresh buffer
      handleVoice(ctx2, deps);
      expect(hasBuffer(100)).toBe(true);
      expect(getBufferSize(100)).toBe(1);
    });

    it('batch limit 10 enforced', async () => {
      const deps = makeDeps();

      // Send 12 voices — all share the same chatId so they share the buffer
      const ctxs = [];
      for (let i = 0; i < 12; i++) {
        const ctx = makeCtx({ fileId: `v${i}` });
        ctxs.push(ctx);
        handleVoice(ctx, deps);
      }

      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // Only 10 should be transcribed
      expect(deps.transcribe).toHaveBeenCalledTimes(10);
      // User should be notified about the limit (reply on the replyCtx = ctxs[0])
      const replies = ctxs[0].reply.mock.calls.map((c) => c[0]).join(' ');
      expect(replies).toContain(BATCH_LIMIT_NOTE);
    });
  });

  // ── partial failure ──────────────────────────────────────────────────────

  describe('partial failure', () => {
    it('one of three voices fails transcription', async () => {
      const deps = makeDeps();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      let callCount = 0;
      deps.transcribe.mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error('whisper error'));
        return Promise.resolve(`transcript ${callCount}`);
      });

      const ctxs = [1, 2, 3].map((i) => makeCtx({ fileId: `v${i}` }));
      ctxs.forEach((c) => handleVoice(c, deps));

      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // extractTasks NOT called yet — user chooses via action buttons
      expect(deps.extractTasks).not.toHaveBeenCalled();
      // Reply should contain transcript + action buttons + partial failure note
      const replies = ctxs[0].reply.mock.calls.map((c) => c[0]).join(' ');
      expect(replies).toContain('1 из 3');
      spy.mockRestore();
    });

    it('all voices fail', async () => {
      const deps = makeDeps();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      deps.transcribe.mockRejectedValue(new Error('whisper error'));

      const ctxs = [1, 2, 3].map((i) => makeCtx({ fileId: `v${i}` }));
      ctxs.forEach((c) => handleVoice(c, deps));

      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.extractTasks).not.toHaveBeenCalled();
      expect(deps.decrementTrial).not.toHaveBeenCalled();
      // User should receive the all-voices-failed message
      expect(ctxs[0].reply).toHaveBeenCalledWith(ALL_VOICES_FAILED);
      spy.mockRestore();
    });

    it('fetchFile failure treated as failed voice', async () => {
      const deps = makeDeps();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      deps.fetchFile.mockRejectedValue(new Error('network error'));

      const ctx = makeCtx();
      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.extractTasks).not.toHaveBeenCalled();
      expect(deps.decrementTrial).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(ALL_VOICES_FAILED);
      spy.mockRestore();
    });
  });

  // ── transcript truncation ────────────────────────────────────────────────

  describe('transcript truncation', () => {
    it('combined transcript over 4000 chars truncated by handler', async () => {
      const deps = makeDeps();
      const longText = 'a'.repeat(5000);
      deps.transcribe.mockResolvedValue(longText);

      const ctx = makeCtx();
      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // extractTasks NOT called yet — user chooses via action buttons
      expect(deps.extractTasks).not.toHaveBeenCalled();
      // Session transcript should be truncated to 4000
      expect(ctx.session.transcript.length).toBeLessThanOrEqual(4000);
      // Reply should contain truncation note
      const replies = ctx.reply.mock.calls.map((c) => c[0]).join(' ');
      expect(replies).toMatch(/сокращён/i);
    });
  });

  // ── trial exhausted ──────────────────────────────────────────────────────

  describe('trial exhausted', () => {
    it('voice rejected when trial_remaining is 0', async () => {
      const user = { id: 1, telegram_user_id: 12345, trial_remaining: 0, trial_phase: 3 };
      const deps = makeDeps({ user });
      const ctx = makeCtx();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.transcribe).not.toHaveBeenCalled();
      expect(deps.extractTasks).not.toHaveBeenCalled();
      expect(deps.decrementTrial).not.toHaveBeenCalled();
      // User should get the specific trial-exhausted message
      expect(ctx.reply).toHaveBeenCalledWith(TRIAL_EXHAUSTED);
    });
  });

  // ── feedback interruption ────────────────────────────────────────────────

  describe('feedback interruption', () => {
    it('new voice resets pending feedback session', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({
        session: {
          awaitingFeedback: true,
          voiceRequestId: 5,
          awaitingComment: false,
          awaitingConsent: false,
          inSurvey: false,
          surveyRetries: {},
        },
      });

      handleVoice(ctx, deps);

      // Session should be reset immediately
      expect(ctx.session.awaitingFeedback).toBe(false);
      expect(ctx.session.voiceRequestId).toBeNull();
    });
  });

  // ── integration ──────────────────────────────────────────────────────────

  describe('integration', () => {
    it('full pipeline with mock services', async () => {
      const deps = makeDeps({
        transcribeResult: 'Нужно купить молоко и позвонить Маше',
        extractResult: {
          tasks: ['Купить молоко', 'Позвонить Маше'],
          marker: null,
          truncated: false,
        },
      });
      const ctx = makeCtx();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // Full pipeline executed (up to action buttons)
      expect(deps.upsertUser).toHaveBeenCalled();
      expect(deps.fetchFile).toHaveBeenCalled();
      expect(deps.transcribe).toHaveBeenCalled();
      // extractTasks NOT called yet — user chooses via action buttons
      expect(deps.extractTasks).not.toHaveBeenCalled();
      expect(deps.createVoiceRequest).toHaveBeenCalled();
      expect(deps.updateVoiceRequest).toHaveBeenCalled();
      // decrementTrial NOT called yet — only after action chosen
      expect(deps.decrementTrial).not.toHaveBeenCalled();

      // Session updated for action flow
      expect(ctx.session.awaitingAction).toBe(true);
      expect(ctx.session.voiceRequestId).toBe(10);

      // Reply contains transcript and action buttons
      const replyTexts = ctx.reply.mock.calls.map((c) => c[0]);
      const transcriptReply = replyTexts.find((t) => typeof t === 'string' && t.includes('Распознано'));
      expect(transcriptReply).toContain('Нужно купить молоко');

      // Check action buttons
      const kbCall = ctx.reply.mock.calls.find(
        (c) => c[1] && c[1].reply_markup
      );
      expect(kbCall).toBeDefined();
      const buttons = kbCall[1].reply_markup.inline_keyboard.flat();
      expect(buttons.map((b) => b.callback_data)).toEqual([
        'action:tasks', 'action:summary',
      ]);
    });
  });

  // ── action callback handlers ─────────────────────────────────────────────

  describe('action:tasks callback', () => {
    it('extracts tasks and sends rating keyboard when user clicks action:tasks', async () => {
      const deps = makeDeps({
        extractResult: { tasks: ['Купить молоко', 'Купить хлеб'], marker: null, truncated: false },
      });
      const ctx = makeCtx({
        session: {
          awaitingAction: true,
          pendingAction: null,
          transcript: 'нужно купить молоко и купить хлеб',
          voiceRequestId: 10,
          awaitingFeedback: false,
        },
      });
      // Simulate callback query context
      ctx.callbackQuery = { data: 'action:tasks' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();

      const { handleActionTasks } = await import('../src/handlers/feedback.js');
      await handleActionTasks(ctx, deps);

      expect(deps.extractTasks).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: null });
      expect(ctx.reply).toHaveBeenCalled();
      // Check rating keyboard
      const kbCall = ctx.reply.mock.calls.find(
        (c) => c[1] && c[1].reply_markup
      );
      expect(kbCall).toBeDefined();
      const buttons = kbCall[1].reply_markup.inline_keyboard.flat();
      expect(buttons.map((b) => b.callback_data)).toEqual([
        'rate:1', 'rate:2', 'rate:3', 'rate:4', 'rate:5',
      ]);
      expect(deps.decrementTrial).toHaveBeenCalledWith(ctx.from.id);
      expect(deps.updateVoiceRequest).toHaveBeenCalledWith(10, {
        actionType: 'tasks',
        taskCount: 2,
      });
    });

    it('shows expired message if awaitingAction is false', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({
        session: {
          awaitingAction: false,
          pendingAction: null,
          transcript: null,
          voiceRequestId: null,
        },
      });
      ctx.callbackQuery = { data: 'action:tasks' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();

      const { handleActionTasks } = await import('../src/handlers/feedback.js');
      await handleActionTasks(ctx, deps);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: expect.any(String) });
      expect(deps.extractTasks).not.toHaveBeenCalled();
    });

    it('shows no_tasks message when marker is no_tasks', async () => {
      const deps = makeDeps({
        extractResult: { tasks: [], marker: 'no_tasks', truncated: false },
      });
      const ctx = makeCtx({
        session: {
          awaitingAction: true,
          pendingAction: null,
          transcript: 'бла бла бла',
          voiceRequestId: 10,
          awaitingFeedback: false,
        },
      });
      ctx.callbackQuery = { data: 'action:tasks' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();

      const { handleActionTasks } = await import('../src/handlers/feedback.js');
      await handleActionTasks(ctx, deps);

      expect(ctx.reply).toHaveBeenCalledWith(NO_TASKS_FOUND);
      expect(deps.decrementTrial).not.toHaveBeenCalled();
    });

    it('shows too_many_tasks message when marker is too_many_tasks', async () => {
      const deps = makeDeps({
        extractResult: { tasks: [], marker: 'too_many_tasks', truncated: false },
      });
      const ctx = makeCtx({
        session: {
          awaitingAction: true,
          pendingAction: null,
          transcript: 'бла бла бла',
          voiceRequestId: 10,
          awaitingFeedback: false,
        },
      });
      ctx.callbackQuery = { data: 'action:tasks' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();

      const { handleActionTasks } = await import('../src/handlers/feedback.js');
      await handleActionTasks(ctx, deps);

      expect(ctx.reply).toHaveBeenCalledWith(TOO_MANY_TASKS);
      expect(deps.decrementTrial).not.toHaveBeenCalled();
    });
  });

  describe('action:summary callback', () => {
    it('generates summary and sends it when user clicks action:summary', async () => {
      const deps = makeDeps();
      deps.llmProvider.complete = jest.fn().mockResolvedValue('• Нужно купить молоко\n• Позвонить Маше');
      const ctx = makeCtx({
        session: {
          awaitingAction: true,
          pendingAction: null,
          transcript: 'нужно купить молоко и позвонить Маше',
          voiceRequestId: 10,
          awaitingFeedback: false,
        },
      });
      ctx.callbackQuery = { data: 'action:summary' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();

      const { handleActionSummary } = await import('../src/handlers/feedback.js');
      await handleActionSummary(ctx, deps);

      expect(deps.llmProvider.complete).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: null });
      expect(ctx.reply).toHaveBeenCalled();
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('Резюме');
      expect(replyText).toContain('молоко');
      expect(deps.decrementTrial).toHaveBeenCalledWith(ctx.from.id);
      expect(deps.updateVoiceRequest).toHaveBeenCalledWith(10, {
        actionType: 'summary',
        summaryLength: expect.any(Number),
      });
    });

    it('shows expired message if awaitingAction is false', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({
        session: {
          awaitingAction: false,
          pendingAction: null,
          transcript: null,
          voiceRequestId: null,
        },
      });
      ctx.callbackQuery = { data: 'action:summary' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();

      const { handleActionSummary } = await import('../src/handlers/feedback.js');
      await handleActionSummary(ctx, deps);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: expect.any(String) });
      expect(deps.llmProvider.complete).not.toHaveBeenCalled();
    });

    it('shows generic error if LLM call fails', async () => {
      const deps = makeDeps();
      deps.llmProvider.complete = jest.fn().mockRejectedValue(new Error('LLM error'));
      const ctx = makeCtx({
        session: {
          awaitingAction: true,
          pendingAction: null,
          transcript: 'нужно купить молоко',
          voiceRequestId: 10,
          awaitingFeedback: false,
        },
      });
      ctx.callbackQuery = { data: 'action:summary' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { handleActionSummary } = await import('../src/handlers/feedback.js');
      await handleActionSummary(ctx, deps);

      expect(ctx.reply).toHaveBeenCalledWith(GENERIC_ERROR);
      expect(deps.decrementTrial).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ── integration: full pipeline with both actions ─────────────────────────

  describe('integration: action flow', () => {
    it('voice → action:tasks → rating → feedback saved', async () => {
      const deps = makeDeps({
        transcribeResult: 'нужно купить молоко',
        extractResult: { tasks: ['Купить молоко'], marker: null, truncated: false },
      });
      const ctx = makeCtx();

      // Step 1: Voice → transcript + action buttons
      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(ctx.session.awaitingAction).toBe(true);
      expect(ctx.session.transcript).toBe('нужно купить молоко');
      expect(deps.extractTasks).not.toHaveBeenCalled();

      // Step 2: User clicks action:tasks
      ctx.callbackQuery = { data: 'action:tasks' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();
      ctx.reply = jest.fn().mockResolvedValue({ message_id: 100 });

      const { handleActionTasks } = await import('../src/handlers/feedback.js');
      await handleActionTasks(ctx, deps);

      expect(deps.extractTasks).toHaveBeenCalled();
      expect(deps.decrementTrial).toHaveBeenCalled();
      expect(ctx.session.awaitingFeedback).toBe(true);

      // Step 3: User rates 5
      const rateCtx = {
        ...ctx,
        callbackQuery: { data: 'rate:5' },
        answerCallbackQuery: jest.fn().mockResolvedValue(),
        editMessageReplyMarkup: jest.fn().mockResolvedValue(),
        reply: jest.fn().mockResolvedValue({ message_id: 101 }),
        session: { ...ctx.session, awaitingFeedback: true, voiceRequestId: 10 },
      };
      const { registerFeedbackHandler } = await import('../src/handlers/feedback.js');
      // Simulate callback routing
      const mockBot = { on: jest.fn() };
      registerFeedbackHandler(mockBot, deps);
      const callbackHandler = mockBot.on.mock.calls.find(
        (c) => c[0] === 'callback_query:data'
      )[1];
      await callbackHandler(rateCtx, () => {});

      expect(deps.saveFeedback).toHaveBeenCalledWith(10, 5, null, 0);
    });

    it('voice → action:summary → no rating flow', async () => {
      const deps = makeDeps({
        transcribeResult: 'встреча была полезная, обсудили план',
      });
      deps.llmProvider.complete = jest.fn().mockResolvedValue('• Обсудили план\n• Встреча полезная');
      const ctx = makeCtx();

      // Step 1: Voice → transcript + action buttons
      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(ctx.session.awaitingAction).toBe(true);
      expect(ctx.session.transcript).toBe('встреча была полезная, обсудили план');

      // Step 2: User clicks action:summary
      ctx.callbackQuery = { data: 'action:summary' };
      ctx.answerCallbackQuery = jest.fn().mockResolvedValue();
      ctx.editMessageReplyMarkup = jest.fn().mockResolvedValue();
      ctx.reply = jest.fn().mockResolvedValue({ message_id: 100 });

      const { handleActionSummary } = await import('../src/handlers/feedback.js');
      await handleActionSummary(ctx, deps);

      expect(deps.llmProvider.complete).toHaveBeenCalled();
      expect(deps.decrementTrial).toHaveBeenCalled();
      // No awaitingFeedback set
      expect(ctx.session.awaitingFeedback).toBe(false);
    });
  });
});
