import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the DB module before importing bot
const mockUpsertUser = jest.fn(() => ({
  id: 1,
  telegram_user_id: 12345,
  telegram_username: 'testuser',
  trial_remaining: 30,
  trial_phase: 1,
}));

jest.unstable_mockModule('../src/db/index.js', () => ({
  initDb: jest.fn(),
  runMigrations: jest.fn(),
  getDb: jest.fn(),
}));

jest.unstable_mockModule('../src/db/queries.js', () => ({
  upsertUser: mockUpsertUser,
  getUserByTelegramId: jest.fn(),
}));

const { createBot, getInitialSession } = await import('../src/bot.js');
const { WELCOME, NON_VOICE_EXPLANATION, GENERIC_ERROR } = await import('../src/utils/messages.js');

// Fake botInfo to avoid needing bot.init() / getMe API call
const TEST_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'TestBot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

describe('bot session', () => {
  it('should initialize session with correct default state', () => {
    const session = getInitialSession();
    expect(session).toEqual({
      awaitingFeedback: false,
      voiceRequestId: null,
      awaitingComment: false,
      awaitingConsent: false,
      inSurvey: false,
      surveyRetries: {},
    });
  });
});

describe('bot handlers', () => {
  let bot;
  let repliedTexts;

  beforeEach(() => {
    mockUpsertUser.mockClear();
    repliedTexts = [];
    bot = createBot('test-token-12345', { botInfo: TEST_BOT_INFO });

    // Intercept bot.api.sendMessage to capture replies
    bot.api.config.use((prev, method, payload) => {
      if (method === 'sendMessage') {
        repliedTexts.push(payload.text);
      }
      // Return a minimal successful response
      return { ok: true, result: { message_id: 1, chat: { id: payload.chat_id }, date: 0 } };
    });
  });

  function makeStartUpdate() {
    return {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, is_bot: false, first_name: 'Test', username: 'testuser' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    };
  }

  function makeTextUpdate(text = 'hello') {
    return {
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 12345, is_bot: false, first_name: 'Test', username: 'testuser' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    };
  }

  function makePhotoUpdate() {
    return {
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: 12345, is_bot: false, first_name: 'Test', username: 'testuser' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'abc123', file_unique_id: 'u1', width: 100, height: 100 }],
      },
    };
  }

  function makeVoiceUpdate() {
    return {
      update_id: 4,
      message: {
        message_id: 4,
        from: { id: 12345, is_bot: false, first_name: 'Test', username: 'testuser' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice123', file_unique_id: 'v1', duration: 10 },
      },
    };
  }

  it('should call upsertUser on /start command', async () => {
    await bot.handleUpdate(makeStartUpdate());
    expect(mockUpsertUser).toHaveBeenCalledWith(12345, 'testuser');
  });

  it('should reply with welcome message on /start', async () => {
    await bot.handleUpdate(makeStartUpdate());
    expect(repliedTexts.length).toBe(1);
    expect(repliedTexts[0]).toContain('30');
  });

  it('should reply with explanation on text message', async () => {
    await bot.handleUpdate(makeTextUpdate('hello'));
    expect(repliedTexts.length).toBe(1);
    expect(repliedTexts[0]).toBe(NON_VOICE_EXPLANATION);
  });

  it('should reply with explanation on photo message', async () => {
    await bot.handleUpdate(makePhotoUpdate());
    expect(repliedTexts.length).toBe(1);
    expect(repliedTexts[0]).toBe(NON_VOICE_EXPLANATION);
  });

  it('should not handle voice messages in catch-all', async () => {
    await bot.handleUpdate(makeVoiceUpdate());
    // Voice messages must NOT trigger the non-voice handler
    expect(repliedTexts.length).toBe(0);
  });

  it('should register global error handler', () => {
    expect(bot.errorHandler).toBeDefined();
    expect(typeof bot.errorHandler).toBe('function');
  });

  it('should log errors without crashing on handler failure', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mockCtx = {
      reply: jest.fn().mockResolvedValue(undefined),
      chat: { id: 123 },
    };
    const err = {
      message: 'test error',
      ctx: mockCtx,
      error: new Error('test error'),
    };

    await bot.errorHandler(err);

    expect(consoleSpy).toHaveBeenCalled();
    expect(mockCtx.reply).toHaveBeenCalledWith(GENERIC_ERROR);
    consoleSpy.mockRestore();
  });

  it('should sanitize bot token from error URLs before logging', async () => {
    const loggedMessages = [];
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      loggedMessages.push(args.join(' '));
    });
    const mockCtx = {
      reply: jest.fn().mockResolvedValue(undefined),
      chat: { id: 123 },
    };
    const error = new Error('Request failed');
    error.url = 'https://api.telegram.org/bot123SECRET456/getMe';
    const err = {
      message: error.message,
      ctx: mockCtx,
      error,
    };

    await bot.errorHandler(err);

    const allOutput = loggedMessages.join(' ');
    expect(allOutput).not.toContain('123SECRET456');
    expect(allOutput).toContain('[REDACTED]');
    consoleSpy.mockRestore();
  });

  it('should handle upsertUser with null username on /start', async () => {
    const update = makeStartUpdate();
    delete update.message.from.username;
    await bot.handleUpdate(update);
    expect(mockUpsertUser).toHaveBeenCalledWith(12345, null);
  });
});
