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

export function getAgentScoreHistory(
  db: Database.Database,
  agentId: string,
  limit: number = 30
): Array<{ timestamp: string; score: number | null; action: string }> {
  // Derive score progression from log entries (running approval rate as proxy)
  const rows = db
    .prepare(
      `SELECT timestamp, action, compliance_score_delta
       FROM steward_log
       WHERE agent_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(agentId, limit) as Array<{
    timestamp: string;
    action: string;
    compliance_score_delta: number;
  }>;

  return rows.reverse().map((row) => ({
    timestamp: row.timestamp,
    score: row.compliance_score_delta,
    action: row.action,
  }));
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
