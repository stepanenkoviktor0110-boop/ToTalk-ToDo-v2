import { Bot, session } from 'grammy';
import { WELCOME, NON_VOICE_EXPLANATION, GENERIC_ERROR } from './utils/messages.js';
import { upsertUser } from './db/queries.js';
import { initDb, runMigrations } from './db/index.js';

/**
 * Returns the initial session state per the tech-spec contract.
 * Used by session middleware and exported for testing.
 */
export function getInitialSession() {
  return {
    awaitingFeedback: false,
    voiceRequestId: null,
    awaitingComment: false,
    awaitingConsent: false,
    pendingRating: null,
    pendingComment: null,
    inSurvey: false,
    surveyRetries: {},
    // Action button state (Tasks → Summary choice after transcription)
    awaitingAction: false,
    pendingAction: null,
    transcript: null,
  };
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
 * Create and configure the grammy Bot instance.
 * Does NOT start polling — caller must do that.
 * @param {string} token - Telegram bot token
 * @param {object} [options] - Optional grammy Bot options (e.g. botInfo for testing)
 * @returns {Bot} configured bot instance
 */
export function createBot(token, options = {}) {
  const bot = new Bot(token, options);

  // Session middleware (in-memory, per-chat)
  bot.use(session({ initial: getInitialSession }));

  // /start command handler — upsert user and send welcome
  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    const telegramUserId = ctx.from.id;
    const telegramUsername = ctx.from.username || null;
    const user = upsertUser(telegramUserId, telegramUsername);
    const remaining = user.trial_remaining;
    const welcomeText = WELCOME.replace('{TRIAL_REMAINING}', String(remaining));
    await ctx.reply(welcomeText);
  });

  // Non-voice message catch-all — covers text, photo, sticker, and every
  // other message type except voice (handled in Task 6).
  // Single handler avoids DRY violations and silently-unhandled new types.
  bot.on('message', async (ctx, next) => {
    // Pass voice/audio messages to Task 6 handler via next()
    if (ctx.message.voice || ctx.message.audio) return next();
    // Skip commands (already handled above)
    if (ctx.message.text && ctx.message.text.startsWith('/')) return next();
    // Pass through to feedback/survey handler when in active flow (Task 7, Task 8)
    if (ctx.session.awaitingComment || ctx.session.awaitingConsent || ctx.session.inSurvey) return next();
    await ctx.reply(NON_VOICE_EXPLANATION);
  });

  // Global error handler — Decision 13
  // Log error with timestamp, send generic message, do NOT crash
  bot.catch(async (err) => {
    const timestamp = new Date().toISOString();
    const chatId = err.ctx?.chat?.id ?? 'unknown';
    const errorMessage = sanitize(err.error?.message || err.message || 'Unknown error');
    const errorUrl = err.error?.url ? sanitize(err.error.url) : '';

    // Decision 12: log with timestamp, no PII/credentials
    const stackTrace = sanitize(err.error?.stack || err.stack || '');
    console.error(
      `[${timestamp}] Error in chat ${chatId}: ${errorMessage}${errorUrl ? ` URL: ${errorUrl}` : ''}${stackTrace ? `\n${stackTrace}` : ''}`
    );

    // Try to notify user — but don't crash if reply fails
    try {
      await err.ctx.reply(GENERIC_ERROR);
    } catch {
      console.error(`[${timestamp}] Failed to send error message to chat ${chatId}`);
    }
  });

  return bot;
}

/**
 * Main entry point — called when running bot.js directly.
 * Initializes DB, runs migrations, creates bot, starts polling.
 */
async function main() {
  // Load environment variables
  const dotenv = await import('dotenv');
  dotenv.config();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN environment variable is not set.');
    process.exit(1);
  }

  // SSRF protection: validate WHISPER_URL is a loopback address
  const whisperUrl = process.env.WHISPER_URL ?? 'http://localhost:8765';
  const { hostname } = new URL(whisperUrl);
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    console.error(`WHISPER_URL hostname '${hostname}' is not a loopback address. Aborting.`);
    process.exit(1);
  }

  // Initialize database
  initDb();
  runMigrations();
  console.log(`[${new Date().toISOString()}] Database initialized and migrations applied.`);

  // Create and start bot
  const bot = createBot(token);
  console.log(`[${new Date().toISOString()}] Bot starting...`);
  bot.start();
}

// Run main() only when executed directly (not imported)
// ESM detection: check if this file is the entry point
const isMain = process.argv[1] &&
  (process.argv[1].endsWith('bot.js') || process.argv[1].endsWith('bot'));

if (isMain) {
  main().catch((err) => {
    console.error(`[${new Date().toISOString()}] Fatal error:`, err.message);
    process.exit(1);
  });
}
