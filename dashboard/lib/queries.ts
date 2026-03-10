import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// ─── Types ──────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  agent_id: string;
  agent_name: string;
  score: number | null;
  score_trend: "improving" | "stable" | "declining" | null;
  badge: "verified" | "under-review" | "high-risk" | "insufficient-data";
  total_evaluations: number;
  total_violations: number;
  approval_rate: number;
}

export interface AgentDetail {
  id: string;
  name: string;
  chain_signers: Record<string, string>;
  registered_at: string;
  is_paused: boolean;
  score: number | null;
  score_trend: "improving" | "stable" | "declining" | null;
  badge: "verified" | "under-review" | "high-risk" | "insufficient-data";
  total_evaluations: number;
  total_violations: number;
  approval_rate: number;
  critical_violations_30d: number;
  last_evaluation: string | null;
}

export interface EvaluationEntry {
  id: string;
  timestamp: string;
  chain: string;
  action: "approve" | "reject" | "error";
  rules_evaluated: number;
  violations: PolicyViolation[];
  estimated_usd_value: number | null;
  estimated_slippage_pct: number | null;
}

export interface PolicyViolation {
  rule_id: string;
  rule_type: string;
  severity: string;
  message: string;
  actual_value: number | string;
  threshold_value: number | string;
}

export interface ViolationBreakdown {
  by_severity: Record<string, number>;
  by_rule_type: Record<string, number>;
  total: number;
}

export interface ScoreHistoryPoint {
  score: number;
  computed_at: string;
}

export interface IntegrityStatus {
  valid: boolean;
  entries_checked: number;
  error?: string;
  tampered_entry_id?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

export function getScoreBadge(
  score: number | null,
  totalEvaluations: number
): LeaderboardEntry["badge"] {
  if (score === null || totalEvaluations < 10) return "insufficient-data";
  if (score >= 8) return "verified";
  if (score >= 5) return "under-review";
  return "high-risk";
}

export function getScoreColor(badge: LeaderboardEntry["badge"]): string {
  switch (badge) {
    case "verified":
      return "#10B981";
    case "under-review":
      return "#F59E0B";
    case "high-risk":
      return "#EF4444";
    case "insufficient-data":
      return "#6B7280";
  }
}

// ─── Query Functions ────────────────────────────────────────────────

export function getLeaderboard(
  db: Database.Database,
  options: {
    limit?: number;
    minScore?: number;
    sortBy?: "score" | "evaluations" | "approval_rate";
  } = {}
): LeaderboardEntry[] {
  const { limit = 50, minScore, sortBy = "score" } = options;

  let orderClause: string;
  switch (sortBy) {
    case "evaluations":
      orderClause = "ss.total_evaluations DESC";
      break;
    case "approval_rate":
      orderClause = "(1.0 - ss.violation_rate) DESC";
      break;
    default:
      orderClause = "ss.score DESC NULLS LAST";
  }

  let whereClause = "WHERE ss.total_evaluations >= 1";
  const params: unknown[] = [];

  if (minScore !== undefined) {
    whereClause += " AND ss.score >= ?";
    params.push(minScore);
  }

  const sql = `
    SELECT
      a.id AS agent_id,
      a.name AS agent_name,
      ss.score,
      ss.score_trend,
      ss.total_evaluations,
      ss.total_violations,
      ss.violation_rate
    FROM steward_scores ss
    JOIN agents a ON ss.agent_id = a.id
    ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    agent_id: string;
    agent_name: string;
    score: number | null;
    score_trend: string | null;
    total_evaluations: number;
    total_violations: number;
    violation_rate: number;
  }>;

  return rows.map((row, index) => ({
    rank: index + 1,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    score: row.score,
    score_trend: row.score_trend as LeaderboardEntry["score_trend"],
    badge: getScoreBadge(row.score, row.total_evaluations),
    total_evaluations: row.total_evaluations,
    total_violations: row.total_violations,
    approval_rate:
      row.total_evaluations > 0
        ? Math.round((1 - row.violation_rate) * 100)
        : 0,
  }));
}

export function getAgentDetail(
  db: Database.Database,
  agentId: string
): AgentDetail | null {
  const agentRow = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(agentId) as Record<string, unknown> | undefined;

  if (!agentRow) return null;

  // Get score from cache
  const scoreRow = db
    .prepare("SELECT * FROM steward_scores WHERE agent_id = ?")
    .get(agentId) as Record<string, unknown> | undefined;

  const totalEvaluations = (scoreRow?.total_evaluations as number) ?? 0;
  const totalViolations = (scoreRow?.total_violations as number) ?? 0;
  const score = (scoreRow?.score as number | null) ?? null;
  const violationRate = (scoreRow?.violation_rate as number) ?? 0;

  return {
    id: agentRow.id as string,
    name: agentRow.name as string,
    chain_signers: JSON.parse(agentRow.chain_signers as string),
    registered_at: agentRow.registered_at as string,
    is_paused: (agentRow.is_paused as number) === 1,
    score,
    score_trend: (scoreRow?.score_trend as AgentDetail["score_trend"]) ?? null,
    badge: getScoreBadge(score, totalEvaluations),
    total_evaluations: totalEvaluations,
    total_violations: totalViolations,
    approval_rate:
      totalEvaluations > 0
        ? Math.round((1 - violationRate) * 100)
        : 0,
    critical_violations_30d:
      (scoreRow?.critical_violations_30d as number) ?? 0,
    last_evaluation: (scoreRow?.last_evaluation as string) ?? null,
  };
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 1.0,
  high: 0.6,
  medium: 0.3,
  low: 0.1,
};

export function getAgentScoreHistory(
  db: Database.Database,
  agentId: string,
  limit: number = 30
): ScoreHistoryPoint[] {
  // Fetch all entries chronologically to compute running score
  const rows = db
    .prepare(
      `SELECT timestamp, action, violations
       FROM steward_log
       WHERE agent_id = ?
       ORDER BY timestamp ASC`
    )
    .all(agentId) as Array<{
    timestamp: string;
    action: string;
    violations: string;
  }>;

  if (rows.length === 0) return [];

  // Compute running weighted score at each evaluation point
  const points: ScoreHistoryPoint[] = [];
  let totalWeight = 0;
  let violationWeight = 0;

  for (const row of rows) {
    totalWeight += 1;
    if (row.action === "reject") {
      const violations = JSON.parse(row.violations) as PolicyViolation[];
      for (const v of violations) {
        violationWeight += SEVERITY_WEIGHTS[v.severity] ?? 0.1;
      }
    }
    const rate = totalWeight > 0 ? violationWeight / totalWeight : 0;
    const score = Math.max(0, Math.min(10, 10 * (1 - rate)));
    points.push({ score: Math.round(score * 10) / 10, computed_at: row.timestamp });
  }

  // Return the last `limit` points
  return points.slice(-limit);
}

// ─── Integrity Verification ───────────────────────────────────────

const GENESIS_HASH = "0".repeat(64);

function computeIntegrityHash(
  prevHash: string,
  entryId: string,
  timestamp: string,
  action: string,
  violations: PolicyViolation[]
): string {
  const data = prevHash + entryId + timestamp + action + JSON.stringify(violations);
  return createHash("sha256").update(data).digest("hex");
}

export function getAgentIntegrityStatus(
  db: Database.Database,
  agentId: string
): IntegrityStatus {
  const logEntries = db
    .prepare(
      `SELECT sl.id, sl.timestamp, sl.action, sl.violations
       FROM steward_log sl
       WHERE sl.agent_id = ?
       ORDER BY sl.rowid ASC`
    )
    .all(agentId) as Array<{
    id: string;
    timestamp: string;
    action: string;
    violations: string;
  }>;

  if (logEntries.length === 0) {
    return { valid: true, entries_checked: 0 };
  }

  // Get integrity entries for this agent's log entries
  const integrityRows = db
    .prepare(
      `SELECT li.entry_id, li.prev_hash, li.integrity_hash
       FROM log_integrity li
       JOIN steward_log sl ON li.entry_id = sl.id
       WHERE sl.agent_id = ?
       ORDER BY sl.rowid ASC`
    )
    .all(agentId) as Array<{
    entry_id: string;
    prev_hash: string;
    integrity_hash: string;
  }>;

  const integrityMap = new Map(integrityRows.map((r) => [r.entry_id, r]));

  if (logEntries.length !== integrityRows.length) {
    return {
      valid: false,
      entries_checked: 0,
      error: `Log has ${logEntries.length} entries but integrity table has ${integrityRows.length}`,
    };
  }

  // We need to find the prev_hash for the first entry of this agent.
  // The hash chain is global, not per-agent. We verify per-agent entries
  // have valid hashes by recomputing each entry individually.
  for (let i = 0; i < logEntries.length; i++) {
    const entry = logEntries[i]!;
    const integrity = integrityMap.get(entry.id);

    if (!integrity) {
      return {
        valid: false,
        entries_checked: i,
        error: `Missing integrity entry for log entry ${entry.id}`,
        tampered_entry_id: entry.id,
      };
    }

    const violations = JSON.parse(entry.violations) as PolicyViolation[];
    const expectedHash = computeIntegrityHash(
      integrity.prev_hash,
      entry.id,
      entry.timestamp,
      entry.action,
      violations
    );

    if (integrity.integrity_hash !== expectedHash) {
      return {
        valid: false,
        entries_checked: i,
        error: `Tampered entry detected: ${entry.id}`,
        tampered_entry_id: entry.id,
      };
    }
  }

  return { valid: true, entries_checked: logEntries.length };
}

export function getAgentRecentEvaluations(
  db: Database.Database,
  agentId: string,
  limit: number = 50
): EvaluationEntry[] {
  const rows = db
    .prepare(
      `SELECT id, timestamp, chain, action, rules_evaluated,
              violations, estimated_usd_value, estimated_slippage_pct
       FROM steward_log
       WHERE agent_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(agentId, limit) as Array<{
    id: string;
    timestamp: string;
    chain: string;
    action: string;
    rules_evaluated: number;
    violations: string;
    estimated_usd_value: number | null;
    estimated_slippage_pct: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    chain: row.chain,
    action: row.action as EvaluationEntry["action"],
    rules_evaluated: row.rules_evaluated,
    violations: JSON.parse(row.violations) as PolicyViolation[],
    estimated_usd_value: row.estimated_usd_value,
    estimated_slippage_pct: row.estimated_slippage_pct,
  }));
}

export function getAgentViolationBreakdown(
  db: Database.Database,
  agentId: string
): ViolationBreakdown {
  const rows = db
    .prepare(
      `SELECT violations
       FROM steward_log
       WHERE agent_id = ? AND action = 'reject'
       ORDER BY timestamp DESC`
    )
    .all(agentId) as Array<{ violations: string }>;

  const bySeverity: Record<string, number> = {};
  const byRuleType: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    const violations = JSON.parse(row.violations) as PolicyViolation[];
    for (const v of violations) {
      bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
      byRuleType[v.rule_type] = (byRuleType[v.rule_type] ?? 0) + 1;
      total++;
    }
  }

  return { by_severity: bySeverity, by_rule_type: byRuleType, total };
}
