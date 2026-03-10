import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../lib/db";
import {
  getLeaderboard,
  getAgentDetail,
  getAgentRecentEvaluations,
  getAgentViolationBreakdown,
  getAgentScoreHistory,
  getScoreBadge,
  getScoreColor,
} from "../lib/queries";

let db: Database.Database;

function seedTestData(db: Database.Database) {
  // Insert 3 agents
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("agent-001", "AlphaBot", '{"solana":"abc123"}', "2025-01-01T00:00:00Z", "{}", 0);
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("agent-002", "BetaTrader", '{"solana":"def456"}', "2025-01-02T00:00:00Z", "{}", 0);
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("agent-003", "GammaArb", '{"solana":"ghi789"}', "2025-01-03T00:00:00Z", "{}", 1);

  // Insert steward_scores
  const insertScore = db.prepare(
    `INSERT INTO steward_scores (agent_id, score, total_evaluations, total_violations, violation_rate, critical_violations_30d, last_evaluation, score_trend, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertScore.run("agent-001", 9.2, 100, 5, 0.05, 0, "2025-03-01T00:00:00Z", "improving", "2025-03-01T00:00:00Z");
  insertScore.run("agent-002", 6.5, 50, 15, 0.30, 2, "2025-03-01T00:00:00Z", "stable", "2025-03-01T00:00:00Z");
  insertScore.run("agent-003", 3.1, 30, 20, 0.67, 5, "2025-02-28T00:00:00Z", "declining", "2025-02-28T00:00:00Z");

  // Insert steward_log entries for agent-001
  const insertLog = db.prepare(
    `INSERT INTO steward_log (id, agent_id, timestamp, chain, action, policy_set_id, rules_evaluated, violations, compliance_score_delta, estimated_usd_value, estimated_slippage_pct, counterparties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertLog.run("log-001", "agent-001", "2025-03-01T10:00:00Z", "solana", "approve", "default", 5, "[]", 0.1, 5000, 0.5, '["prog1"]');
  insertLog.run("log-002", "agent-001", "2025-03-01T11:00:00Z", "solana", "reject", "default", 5, '[{"rule_id":"r1","rule_type":"max_usd_value","severity":"critical","message":"Exceeded max value","actual_value":15000,"threshold_value":10000}]', -0.5, 15000, 1.2, '["prog2"]');
  insertLog.run("log-003", "agent-001", "2025-03-01T12:00:00Z", "solana", "approve", "default", 5, "[]", 0.1, 2000, 0.3, '["prog1"]');

  // Log entries for agent-002 with multiple violation types
  insertLog.run("log-004", "agent-002", "2025-03-01T10:00:00Z", "solana", "reject", "default", 5, '[{"rule_id":"r2","rule_type":"max_slippage_pct","severity":"high","message":"Slippage too high","actual_value":5.0,"threshold_value":3.0}]', -0.3, 8000, 5.0, '["prog3"]');
  insertLog.run("log-005", "agent-002", "2025-03-01T11:00:00Z", "solana", "reject", "default", 5, '[{"rule_id":"r1","rule_type":"max_usd_value","severity":"critical","message":"Exceeded max value","actual_value":20000,"threshold_value":10000},{"rule_id":"r4","rule_type":"velocity_1h_count","severity":"medium","message":"Too many txs","actual_value":25,"threshold_value":20}]', -0.8, 20000, 2.0, '["prog4"]');
  insertLog.run("log-006", "agent-002", "2025-03-01T12:00:00Z", "solana", "approve", "default", 5, "[]", 0.1, 3000, 0.8, '["prog1"]');
}

beforeEach(() => {
  db = createTestDatabase();
  seedTestData(db);
});

// ─── Score Badge Tests ────────────────────────────────────────────

describe("getScoreBadge", () => {
  it("returns 'verified' for score >= 8 with sufficient evals", () => {
    expect(getScoreBadge(9.2, 100)).toBe("verified");
    expect(getScoreBadge(8.0, 10)).toBe("verified");
  });

  it("returns 'under-review' for score 5-7.9", () => {
    expect(getScoreBadge(6.5, 50)).toBe("under-review");
    expect(getScoreBadge(5.0, 10)).toBe("under-review");
  });

  it("returns 'high-risk' for score < 5", () => {
    expect(getScoreBadge(3.1, 30)).toBe("high-risk");
    expect(getScoreBadge(0, 10)).toBe("high-risk");
  });

  it("returns 'insufficient-data' for null score or < 10 evals", () => {
    expect(getScoreBadge(null, 0)).toBe("insufficient-data");
    expect(getScoreBadge(9.5, 5)).toBe("insufficient-data");
    expect(getScoreBadge(null, 100)).toBe("insufficient-data");
  });
});

// ─── Score Color Tests ──────────────────────────────────────────

describe("getScoreColor", () => {
  it("returns correct hex colors for each badge", () => {
    expect(getScoreColor("verified")).toBe("#10B981");
    expect(getScoreColor("under-review")).toBe("#F59E0B");
    expect(getScoreColor("high-risk")).toBe("#EF4444");
    expect(getScoreColor("insufficient-data")).toBe("#6B7280");
  });
});

// ─── Leaderboard Tests ──────────────────────────────────────────

describe("getLeaderboard", () => {
  it("returns agents sorted by score descending by default", () => {
    const entries = getLeaderboard(db);
    expect(entries.length).toBe(3);
    expect(entries[0]!.agent_name).toBe("AlphaBot");
    expect(entries[0]!.score).toBe(9.2);
    expect(entries[0]!.rank).toBe(1);
    expect(entries[1]!.agent_name).toBe("BetaTrader");
    expect(entries[2]!.agent_name).toBe("GammaArb");
  });

  it("respects limit parameter", () => {
    const entries = getLeaderboard(db, { limit: 2 });
    expect(entries.length).toBe(2);
  });

  it("filters by minScore", () => {
    const entries = getLeaderboard(db, { minScore: 5.0 });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.score !== null && e.score >= 5.0)).toBe(true);
  });

  it("sorts by evaluations when requested", () => {
    const entries = getLeaderboard(db, { sortBy: "evaluations" });
    expect(entries[0]!.total_evaluations).toBeGreaterThanOrEqual(
      entries[1]!.total_evaluations
    );
  });

  it("sorts by approval_rate when requested", () => {
    const entries = getLeaderboard(db, { sortBy: "approval_rate" });
    expect(entries[0]!.approval_rate).toBeGreaterThanOrEqual(
      entries[1]!.approval_rate
    );
  });

  it("returns correct badge assignments", () => {
    const entries = getLeaderboard(db);
    expect(entries[0]!.badge).toBe("verified");
    expect(entries[1]!.badge).toBe("under-review");
    expect(entries[2]!.badge).toBe("high-risk");
  });

  it("calculates approval_rate correctly", () => {
    const entries = getLeaderboard(db);
    const alpha = entries.find((e) => e.agent_name === "AlphaBot")!;
    expect(alpha.approval_rate).toBe(95); // 1 - 0.05 = 0.95 => 95%
  });

  it("returns empty array for empty database", () => {
    const emptyDb = createTestDatabase();
    const entries = getLeaderboard(emptyDb);
    expect(entries).toEqual([]);
  });
});

// ─── Agent Detail Tests ─────────────────────────────────────────

describe("getAgentDetail", () => {
  it("returns full agent detail for existing agent", () => {
    const detail = getAgentDetail(db, "agent-001");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("AlphaBot");
    expect(detail!.score).toBe(9.2);
    expect(detail!.badge).toBe("verified");
    expect(detail!.score_trend).toBe("improving");
    expect(detail!.chain_signers).toEqual({ solana: "abc123" });
    expect(detail!.is_paused).toBe(false);
  });

  it("returns null for nonexistent agent", () => {
    expect(getAgentDetail(db, "nonexistent")).toBeNull();
  });

  it("reflects paused status", () => {
    const detail = getAgentDetail(db, "agent-003");
    expect(detail!.is_paused).toBe(true);
  });
});

// ─── Recent Evaluations Tests ───────────────────────────────────

describe("getAgentRecentEvaluations", () => {
  it("returns evaluations in reverse chronological order", () => {
    const evals = getAgentRecentEvaluations(db, "agent-001");
    expect(evals.length).toBe(3);
    expect(evals[0]!.timestamp > evals[1]!.timestamp).toBe(true);
  });

  it("respects limit parameter", () => {
    const evals = getAgentRecentEvaluations(db, "agent-001", 1);
    expect(evals.length).toBe(1);
  });

  it("parses violations JSON correctly", () => {
    const evals = getAgentRecentEvaluations(db, "agent-001");
    const rejected = evals.find((e) => e.action === "reject")!;
    expect(rejected.violations.length).toBe(1);
    expect(rejected.violations[0]!.rule_type).toBe("max_usd_value");
    expect(rejected.violations[0]!.severity).toBe("critical");
  });

  it("returns empty array for agent with no evaluations", () => {
    const evals = getAgentRecentEvaluations(db, "agent-003");
    expect(evals).toEqual([]);
  });
});

// ─── Violation Breakdown Tests ──────────────────────────────────

describe("getAgentViolationBreakdown", () => {
  it("aggregates violations by severity correctly", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-002");
    expect(breakdown.by_severity["high"]).toBe(1);
    expect(breakdown.by_severity["critical"]).toBe(1);
    expect(breakdown.by_severity["medium"]).toBe(1);
    expect(breakdown.total).toBe(3);
  });

  it("aggregates violations by rule_type correctly", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-002");
    expect(breakdown.by_rule_type["max_slippage_pct"]).toBe(1);
    expect(breakdown.by_rule_type["max_usd_value"]).toBe(1);
    expect(breakdown.by_rule_type["velocity_1h_count"]).toBe(1);
  });

  it("returns zeros for agent with no violations", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-003");
    expect(breakdown.total).toBe(0);
    expect(breakdown.by_severity).toEqual({});
    expect(breakdown.by_rule_type).toEqual({});
  });
});

// ─── Score History Tests ────────────────────────────────────────

describe("getAgentScoreHistory", () => {
  it("returns score history in chronological order", () => {
    const history = getAgentScoreHistory(db, "agent-001");
    expect(history.length).toBe(3);
    expect(history[0]!.timestamp < history[1]!.timestamp).toBe(true);
  });

  it("respects limit parameter", () => {
    const history = getAgentScoreHistory(db, "agent-001", 2);
    expect(history.length).toBe(2);
  });
});
