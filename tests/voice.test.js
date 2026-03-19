import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  TRIAL_EXHAUSTED,
  NO_TASKS_FOUND,
  TOO_MANY_TASKS,
  ALL_VOICES_FAILED,
  BATCH_LIMIT_NOTE,
  TRANSCRIPT_TRUNCATED_NOTE,
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
    it('downloads audio, transcribes, extracts tasks, sends formatted list', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      // processVoiceBatch is async — flush microtasks
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.fetchFile).toHaveBeenCalled();
      expect(deps.transcribe).toHaveBeenCalled();
      expect(deps.extractTasks).toHaveBeenCalled();
      // Should reply with numbered task list
      expect(ctx.reply).toHaveBeenCalled();
      const replyCall = ctx.reply.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('1.')
      );
      expect(replyCall).toBeDefined();
      expect(replyCall[0]).toContain('1.');
      expect(replyCall[0]).toContain('2.');
      expect(replyCall[0]).toContain('Купить молоко');
      expect(replyCall[0]).toContain('Купить хлеб');
    });

    it('sends inline rating keyboard after task list', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      // Find the reply call with reply_markup (inline keyboard)
      const kbCall = ctx.reply.mock.calls.find(
        (c) => c[1] && c[1].reply_markup
      );
      expect(kbCall).toBeDefined();
      // The inline keyboard should have 5 rating buttons
      const kb = kbCall[1].reply_markup;
      expect(kb).toBeDefined();
      // Check that buttons exist with callback data rate:1 through rate:5
      const buttons = kb.inline_keyboard.flat();
      expect(buttons.length).toBe(5);
      expect(buttons.map((b) => b.callback_data)).toEqual([
        'rate:1', 'rate:2', 'rate:3', 'rate:4', 'rate:5',
      ]);
    });

    it('creates voice_request record in DB', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.createVoiceRequest).toHaveBeenCalledWith(1, 'voice_file_1', 10);
      expect(deps.updateVoiceRequest).toHaveBeenCalledWith(10, {
        taskCount: 2,
        transcriptLength: expect.any(Number),
      });
      // Session updated for feedback flow
      expect(ctx.session.awaitingFeedback).toBe(true);
      expect(ctx.session.voiceRequestId).toBe(10);
    });

    it('decrements trial counter on success', async () => {
      const ctx = makeCtx();
      const deps = makeDeps();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.decrementTrial).toHaveBeenCalledWith(1);
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

    it('sends no-tasks message when extractTasks returns no_tasks marker', async () => {
      const deps = makeDeps({
        extractResult: { tasks: [], marker: 'no_tasks', truncated: false },
      });
      const ctx = makeCtx();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(ctx.reply).toHaveBeenCalledWith(NO_TASKS_FOUND);
      expect(deps.decrementTrial).not.toHaveBeenCalled();
    });

    it('sends split message when extractTasks returns too_many_tasks marker', async () => {
      const deps = makeDeps({
        extractResult: { tasks: [], marker: 'too_many_tasks', truncated: false },
      });
      const ctx = makeCtx();

      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(ctx.reply).toHaveBeenCalledWith(TOO_MANY_TASKS);
      expect(deps.decrementTrial).not.toHaveBeenCalled();
    });

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
      // extractTasks called once with combined transcript string
      expect(deps.extractTasks).toHaveBeenCalledTimes(1);
      // Should reply
      expect(ctx1.reply).toHaveBeenCalled();
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

      // extractTasks called with 2 successful transcripts
      expect(deps.extractTasks).toHaveBeenCalledTimes(1);
      // Reply should contain partial failure note
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
      deps.extractTasks.mockResolvedValue({
        tasks: ['Task 1'],
        marker: null,
        truncated: false,
      });

      const ctx = makeCtx();
      handleVoice(ctx, deps);
      jest.advanceTimersByTime(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect(deps.extractTasks).toHaveBeenCalled();
      // Handler should truncate the combined transcript to 4000 chars before calling extractTasks
      const arg = deps.extractTasks.mock.calls[0][0];
      const combined = typeof arg === 'string' ? arg : (Array.isArray(arg) ? arg.join('\n') : '');
      expect(combined.length).toBeLessThanOrEqual(4000);
      // Reply should contain truncation note
      const replies = ctx.reply.mock.calls.map((c) => c[0]).join(' ');
      expect(replies).toMatch(/сокращён|обрезан|truncat/i);
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

      // Full pipeline executed
      expect(deps.upsertUser).toHaveBeenCalled();
      expect(deps.fetchFile).toHaveBeenCalled();
      expect(deps.transcribe).toHaveBeenCalled();
      expect(deps.extractTasks).toHaveBeenCalled();
      expect(deps.createVoiceRequest).toHaveBeenCalled();
      expect(deps.updateVoiceRequest).toHaveBeenCalled();
      expect(deps.decrementTrial).toHaveBeenCalled();

      // Session updated for feedback flow
      expect(ctx.session.awaitingFeedback).toBe(true);
      expect(ctx.session.voiceRequestId).toBe(10);

      // Reply contains task list and keyboard
      const replyTexts = ctx.reply.mock.calls.map((c) => c[0]);
      const taskListReply = replyTexts.find((t) => t.includes('1.'));
      expect(taskListReply).toContain('Купить молоко');
      expect(taskListReply).toContain('Позвонить Маше');
    });
  });
});
