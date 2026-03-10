// ClawSteward Database Queries — Prepared query functions
// All database access goes through here. No raw SQL in other modules.

import type Database from "better-sqlite3";
import type {
  Agent,
  LogIntegrityEntry,
  PolicySet,
  PolicyViolation,
  StewardLogEntry,
  StewardScore,
} from "../core/types.js";

// ─── Agent Queries ─────────────────────────────────────────────────

export function insertAgent(db: Database.Database, agent: Agent): void {
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    agent.id,
    agent.name,
    JSON.stringify(agent.chain_signers),
    agent.registered_at,
    JSON.stringify(agent.metadata),
    agent.is_paused ? 1 : 0,
  );
}

export function getAgent(db: Database.Database, id: string): Agent | undefined {
  const stmt = db.prepare("SELECT * FROM agents WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return deserializeAgent(row);
}

export function getAllAgents(db: Database.Database): Agent[] {
  const stmt = db.prepare("SELECT * FROM agents ORDER BY registered_at DESC");
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(deserializeAgent);
}

export function setAgentPaused(db: Database.Database, id: string, paused: boolean): void {
  const stmt = db.prepare("UPDATE agents SET is_paused = ? WHERE id = ?");
  stmt.run(paused ? 1 : 0, id);
}

function deserializeAgent(row: Record<string, unknown>): Agent {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    chain_signers: JSON.parse(row["chain_signers"] as string),
    registered_at: row["registered_at"] as string,
    metadata: JSON.parse(row["metadata"] as string),
    is_paused: (row["is_paused"] as number) === 1,
  };
}

// ─── Policy Set Queries ────────────────────────────────────────────

export function getPolicySet(db: Database.Database, id: string): PolicySet | undefined {
  const stmt = db.prepare("SELECT * FROM policy_sets WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return deserializePolicySet(row);
}

export function insertPolicySet(db: Database.Database, policySet: PolicySet): void {
  const stmt = db.prepare(`
    INSERT INTO policy_sets (id, name, version, rules, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    policySet.id,
    policySet.name,
    policySet.version,
    JSON.stringify(policySet.rules),
    policySet.created_at,
    policySet.updated_at,
  );
}

function deserializePolicySet(row: Record<string, unknown>): PolicySet {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    version: row["version"] as number,
    rules: JSON.parse(row["rules"] as string),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

// ─── Steward Log Queries ───────────────────────────────────────────
// APPEND-ONLY: Only insert, never update or delete.

export function insertLogEntry(db: Database.Database, entry: StewardLogEntry): void {
  const stmt = db.prepare(`
    INSERT INTO steward_log (
      id, agent_id, timestamp, chain, action, policy_set_id,
      rules_evaluated, violations, compliance_score_delta,
      estimated_usd_value, estimated_slippage_pct, counterparties, chain_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.id,
    entry.agent_id,
    entry.timestamp,
    entry.chain,
    entry.action,
    entry.policy_set_id,
    entry.rules_evaluated,
    JSON.stringify(entry.violations),
    entry.compliance_score_delta,
    entry.estimated_usd_value,
    entry.estimated_slippage_pct,
    JSON.stringify(entry.counterparties),
    entry.chain_payload ? JSON.stringify(entry.chain_payload) : null,
  );
}

export function getLogEntriesByAgent(
  db: Database.Database,
  agentId: string,
  limit?: number,
): StewardLogEntry[] {
  const sql = limit
    ? "SELECT * FROM steward_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?"
    : "SELECT * FROM steward_log WHERE agent_id = ? ORDER BY timestamp DESC";
  const stmt = db.prepare(sql);
  const rows = (limit ? stmt.all(agentId, limit) : stmt.all(agentId)) as Record<string, unknown>[];
  return rows.map(deserializeLogEntry);
}

export function getLogEntryCount(db: Database.Database, agentId: string): number {
  const stmt = db.prepare("SELECT COUNT(*) as count FROM steward_log WHERE agent_id = ?");
  const row = stmt.get(agentId) as { count: number };
  return row.count;
}

export function getViolationCount(db: Database.Database, agentId: string): number {
  const stmt = db.prepare(
    "SELECT COUNT(*) as count FROM steward_log WHERE agent_id = ? AND action = 'reject'",
  );
  const row = stmt.get(agentId) as { count: number };
  return row.count;
}

export function getRecentViolations(
  db: Database.Database,
  agentId: string,
  sinceTimestamp: string,
  severity?: string,
): StewardLogEntry[] {
  let sql =
    "SELECT * FROM steward_log WHERE agent_id = ? AND action = 'reject' AND timestamp >= ?";
  const params: unknown[] = [agentId, sinceTimestamp];

  if (severity) {
    // Filter by severity within the violations JSON
    sql += " AND violations LIKE ?";
    params.push(`%"severity":"${severity}"%`);
  }

  sql += " ORDER BY timestamp DESC";
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Record<string, unknown>[];
  return rows.map(deserializeLogEntry);
}

export function getLogEntriesSince(
  db: Database.Database,
  agentId: string,
  sinceTimestamp: string,
): StewardLogEntry[] {
  const stmt = db.prepare(
    "SELECT * FROM steward_log WHERE agent_id = ? AND timestamp >= ? ORDER BY timestamp DESC",
  );
  const rows = stmt.all(agentId, sinceTimestamp) as Record<string, unknown>[];
  return rows.map(deserializeLogEntry);
}

export function getConsecutiveViolations(
  db: Database.Database,
  agentId: string,
  windowMinutes: number,
): number {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const stmt = db.prepare(
    "SELECT action FROM steward_log WHERE agent_id = ? AND timestamp >= ? ORDER BY timestamp DESC",
  );
  const rows = stmt.all(agentId, windowStart) as { action: string }[];

  let consecutive = 0;
  for (const row of rows) {
    if (row.action === "reject") {
      consecutive++;
    } else {
      break;
    }
  }
  return consecutive;
}

function deserializeLogEntry(row: Record<string, unknown>): StewardLogEntry {
  return {
    id: row["id"] as string,
    agent_id: row["agent_id"] as string,
    timestamp: row["timestamp"] as string,
    chain: row["chain"] as string,
    action: row["action"] as "approve" | "reject" | "error",
    policy_set_id: row["policy_set_id"] as string,
    rules_evaluated: row["rules_evaluated"] as number,
    violations: JSON.parse(row["violations"] as string) as PolicyViolation[],
    compliance_score_delta: row["compliance_score_delta"] as number,
    estimated_usd_value: row["estimated_usd_value"] as number,
    estimated_slippage_pct: row["estimated_slippage_pct"] as number,
    counterparties: JSON.parse(row["counterparties"] as string),
    chain_payload: row["chain_payload"] ? JSON.parse(row["chain_payload"] as string) : null,
  };
}

// ─── Steward Score Cache Queries ───────────────────────────────────

export function upsertStewardScore(db: Database.Database, score: StewardScore): void {
  const stmt = db.prepare(`
    INSERT INTO steward_scores (
      agent_id, score, total_evaluations, total_violations,
      violation_rate, critical_violations_30d, last_evaluation,
      score_trend, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      score = excluded.score,
      total_evaluations = excluded.total_evaluations,
      total_violations = excluded.total_violations,
      violation_rate = excluded.violation_rate,
      critical_violations_30d = excluded.critical_violations_30d,
      last_evaluation = excluded.last_evaluation,
      score_trend = excluded.score_trend,
      computed_at = excluded.computed_at
  `);
  stmt.run(
    score.agent_id,
    score.score,
    score.total_evaluations,
    score.total_violations,
    score.violation_rate,
    score.critical_violations_30d,
    score.last_evaluation,
    score.score_trend,
    score.computed_at,
  );
}

export function getStewardScore(db: Database.Database, agentId: string): StewardScore | undefined {
  const stmt = db.prepare("SELECT * FROM steward_scores WHERE agent_id = ?");
  const row = stmt.get(agentId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return deserializeStewardScore(row);
}

export function getLeaderboard(
  db: Database.Database,
  limit: number = 50,
  minEvaluations: number = 10,
): StewardScore[] {
  const stmt = db.prepare(`
    SELECT * FROM steward_scores
    WHERE total_evaluations >= ? AND score IS NOT NULL
    ORDER BY score DESC
    LIMIT ?
  `);
  const rows = stmt.all(minEvaluations, limit) as Record<string, unknown>[];
  return rows.map(deserializeStewardScore);
}

function deserializeStewardScore(row: Record<string, unknown>): StewardScore {
  return {
    agent_id: row["agent_id"] as string,
    score: row["score"] as number | null,
    total_evaluations: row["total_evaluations"] as number,
    total_violations: row["total_violations"] as number,
    violation_rate: row["violation_rate"] as number,
    critical_violations_30d: row["critical_violations_30d"] as number,
    last_evaluation: row["last_evaluation"] as string | null,
    score_trend: row["score_trend"] as "improving" | "stable" | "declining" | null,
    computed_at: row["computed_at"] as string,
  };
}

// ─── Log Integrity Queries ─────────────────────────────────────────

export function insertLogIntegrity(db: Database.Database, entry: LogIntegrityEntry): void {
  const stmt = db.prepare(`
    INSERT INTO log_integrity (entry_id, prev_hash, integrity_hash)
    VALUES (?, ?, ?)
  `);
  stmt.run(entry.entry_id, entry.prev_hash, entry.integrity_hash);
}

export function getLogIntegrity(
  db: Database.Database,
  entryId: string,
): LogIntegrityEntry | undefined {
  const stmt = db.prepare("SELECT * FROM log_integrity WHERE entry_id = ?");
  const row = stmt.get(entryId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    entry_id: row["entry_id"] as string,
    prev_hash: row["prev_hash"] as string,
    integrity_hash: row["integrity_hash"] as string,
  };
}

export function getLatestIntegrityHash(db: Database.Database): string | undefined {
  // Get the most recent integrity hash by joining with steward_log for timestamp ordering
  const stmt = db.prepare(`
    SELECT li.integrity_hash FROM log_integrity li
    JOIN steward_log sl ON li.entry_id = sl.id
    ORDER BY sl.timestamp DESC
    LIMIT 1
  `);
  const row = stmt.get() as { integrity_hash: string } | undefined;
  return row?.integrity_hash;
}

export function getAllLogIntegrity(db: Database.Database): LogIntegrityEntry[] {
  const stmt = db.prepare(`
    SELECT li.* FROM log_integrity li
    JOIN steward_log sl ON li.entry_id = sl.id
    ORDER BY sl.timestamp ASC
  `);
  return stmt.all() as LogIntegrityEntry[];
}
