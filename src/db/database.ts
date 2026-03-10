// ClawSteward Database — SQLite connection + migrations
// Uses better-sqlite3 for synchronous, zero-config local storage.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = join(process.cwd(), "data", "clawsteward.db");

let _db: Database.Database | null = null;

/**
 * Get or create the database connection.
 * Call initDatabase() first to run migrations.
 */
export function getDatabase(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath ?? process.env["DATABASE_PATH"] ?? DEFAULT_DB_PATH;

  // Ensure the directory exists
  mkdirSync(dirname(resolvedPath), { recursive: true });

  _db = new Database(resolvedPath);

  // SQLite pragmas for performance + safety
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  return _db;
}

/**
 * Initialize the database: run schema migrations.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function initDatabase(dbPath?: string): Database.Database {
  const db = getDatabase(dbPath);

  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  // Execute schema as a single transaction
  db.exec(schema);

  return db;
}

/**
 * Close the database connection.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Create an in-memory database for testing.
 * Returns a fresh database with schema applied.
 */
export function createTestDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  return db;
}
