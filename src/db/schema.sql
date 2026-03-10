-- ClawSteward SQLite Schema
-- Steward Log is APPEND-ONLY — NEVER UPDATE OR DELETE rows from steward_log.

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  name TEXT NOT NULL,
  chain_signers TEXT NOT NULL DEFAULT '{}', -- JSON map
  registered_at TEXT NOT NULL,            -- ISO 8601
  metadata TEXT NOT NULL DEFAULT '{}',    -- JSON
  is_paused INTEGER NOT NULL DEFAULT 0
);

-- Policy sets
CREATE TABLE IF NOT EXISTS policy_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  rules TEXT NOT NULL,                    -- JSON array of PolicyRule
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Steward Log (append-only — NEVER UPDATE OR DELETE)
CREATE TABLE IF NOT EXISTS steward_log (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,                -- ISO 8601
  chain TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'error')),
  policy_set_id TEXT NOT NULL,
  rules_evaluated INTEGER NOT NULL,
  violations TEXT NOT NULL DEFAULT '[]',  -- JSON array
  compliance_score_delta REAL NOT NULL DEFAULT 0,
  estimated_usd_value REAL,
  estimated_slippage_pct REAL,
  counterparties TEXT NOT NULL DEFAULT '[]', -- JSON array
  chain_payload TEXT,                     -- JSON blob (chain-specific raw data)
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Indexes for Steward Score queries
CREATE INDEX IF NOT EXISTS idx_log_agent_time ON steward_log(agent_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_log_action ON steward_log(action);
CREATE INDEX IF NOT EXISTS idx_log_chain ON steward_log(chain);

-- Steward Score cache (recomputed periodically, not authoritative — log is source of truth)
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

-- Tamper evidence: hash chain on Steward Log
-- Each entry's integrity_hash = SHA-256(prev_hash + entry_id + timestamp + action + violations)
-- Verifiable by replaying from genesis
CREATE TABLE IF NOT EXISTS log_integrity (
  entry_id TEXT PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  integrity_hash TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES steward_log(id)
);

-- Default policy set (inserted on first run)
INSERT OR IGNORE INTO policy_sets (id, name, version, rules, created_at, updated_at)
VALUES (
  'default',
  'Default Steward Policy',
  1,
  '[
    {"id":"r1","type":"max_usd_value","params":{"max":10000},"severity":"critical","enabled":true},
    {"id":"r2","type":"max_slippage_pct","params":{"max":3.0},"severity":"high","enabled":true},
    {"id":"r3","type":"velocity_24h_usd","params":{"max":50000},"severity":"high","enabled":true},
    {"id":"r4","type":"velocity_1h_count","params":{"max":20},"severity":"medium","enabled":true},
    {"id":"r5","type":"auto_pause_consecutive_violations","params":{"threshold":3,"window_minutes":60},"severity":"critical","enabled":true}
  ]',
  datetime('now'),
  datetime('now')
);
