import 'dotenv/config';
import { initDb, getDb, runMigrations } from './db/index.js';
import { GigaChatProvider } from './services/llm/gigachat.js';
import { createTranscriber } from './services/transcription.js';
import { extractTasks } from './services/taskExtractor.js';
import { createBot } from './bot.js';
import { registerVoiceHandler } from './handlers/voice.js';
import {
  upsertUser,
  createVoiceRequest,
  updateVoiceRequest,
  decrementTrial,
} from './db/queries.js';

// ---------------------------------------------------------------------------
// 1. Validate required environment variables
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'GIGACHAT_AUTH_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WHISPER_URL = process.env.WHISPER_URL ?? 'http://localhost:8765';

// ---------------------------------------------------------------------------
// 2. fetchFile — downloads audio from Telegram CDN
//    Signature expected by voice.js: fetchFile(botToken, filePath) => Buffer
// ---------------------------------------------------------------------------

async function fetchFile(botToken, filePath) {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file from Telegram: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// 3. Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  // Initialize DB then run migrations
  initDb();
  runMigrations();
  console.log(`[${new Date().toISOString()}] Database initialized and migrations applied.`);

  // Build service instances
  const gigachat = new GigaChatProvider({
    authKey: process.env.GIGACHAT_AUTH_KEY,
    model: process.env.GIGACHAT_MODEL,
  });

  const transcribe = createTranscriber();

  // Create bot
  const bot = createBot(TELEGRAM_BOT_TOKEN);

  // Assemble deps bag — exact field names consumed by voice.js
  const deps = {
    // Download + transcribe
    transcribe,
    fetchFile,
    botToken: TELEGRAM_BOT_TOKEN,

    // Task extraction
    extractTasks,
    llmProvider: gigachat,

    // DB operations
    upsertUser,
    createVoiceRequest,
    updateVoiceRequest,
    decrementTrial,
    db: getDb(),
  };

  registerVoiceHandler(bot, deps);

  // Graceful shutdown
  function shutdown() {
    console.log(`[${new Date().toISOString()}] Shutting down...`);
    bot.stop();
    process.exit(0);
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Start polling
  await bot.start({
    onStart: (info) => {
      console.log(
        `[${new Date().toISOString()}] Bot @${info.username} (id=${info.id}) is running.`
      );
    },
  });
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, err.message);
  process.exit(1);
});
