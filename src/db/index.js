import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

/**
 * Initialize the database connection.
 * @param {string} [dbPath] - Path to the SQLite database file, or ':memory:' for in-memory.
 *   Defaults to DB_PATH env var or 'data/bot.db'.
 * @returns {Database} The database instance.
 */
export function initDb(dbPath) {
  if (db) {
    db.close();
    db = null;
  }

  const resolvedPath = dbPath || process.env.DB_PATH || 'data/bot.db';

  // Auto-create directory for file-based databases
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * Get the current database instance.
 * @returns {Database}
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Run all pending migrations from src/db/migrations/.
 * Tracks applied migrations in a _migrations table.
 */
export function runMigrations() {
  const currentDb = getDb();

  // Create migrations tracking table
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Read migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Get already applied migrations
  const applied = new Set(
    currentDb.prepare('SELECT name FROM _migrations').all().map(row => row.name)
  );

  // Apply new migrations in a transaction
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    const applyMigration = currentDb.transaction(() => {
      currentDb.exec(sql);
      currentDb.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });

    applyMigration();
  }
}
