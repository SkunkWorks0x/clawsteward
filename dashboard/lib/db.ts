import Database from "better-sqlite3";
import { join } from "node:path";

let _db: Database.Database | null = null;

/**
 * Get the shared SQLite database connection.
 * Reads from the same database as the core ClawSteward engine.
 */
export function getDatabase(): Database.Database {
  if (_db) return _db;

  const dbPath =
    process.env.STEWARD_DB_PATH ??
    join(process.cwd(), "..", "data", "clawsteward.db");

  _db = new Database(dbPath, { readonly: true });
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  return _db;
}

/**
 * Create an in-memory database for testing, with schema applied.
 */
export function createTestDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chain_signers TEXT NOT NULL DEFAULT '{}',
      registered_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      is_paused INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS policy_sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      rules TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steward_log (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      chain TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'error')),
      policy_set_id TEXT NOT NULL,
      rules_evaluated INTEGER NOT NULL,
      violations TEXT NOT NULL DEFAULT '[]',
      compliance_score_delta REAL NOT NULL DEFAULT 0,
      estimated_usd_value REAL,
      estimated_slippage_pct REAL,
      counterparties TEXT NOT NULL DEFAULT '[]',
      chain_payload TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_log_agent_time ON steward_log(agent_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_log_action ON steward_log(action);

    CREATE TABLE IF NOT EXISTS steward_scores (
      agent_id TEXT PRIMARY KEY,
      score REAL,
      total_evaluations INTEGER,
      total_violations INTEGER,
      violation_rate REAL,
      critical_violations_30d INTEGER,
      last_evaluation TEXT,
      score_trend TEXT CHECK (score_trend IN ('improving', 'stable', 'declining')),
      computed_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS log_integrity (
      entry_id TEXT PRIMARY KEY,
      prev_hash TEXT NOT NULL,
      integrity_hash TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES steward_log(id)
    );
  `);

  return db;
}
