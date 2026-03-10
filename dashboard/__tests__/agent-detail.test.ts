import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../lib/db";
import {
  getAgentDetail,
  getAgentRecentEvaluations,
  getAgentViolationBreakdown,
  getAgentScoreHistory,
  getAgentIntegrityStatus,
  getScoreBadge,
  getScoreColor,
} from "../lib/queries";

let db: Database.Database;

const GENESIS_HASH = "0".repeat(64);

function computeHash(
  prevHash: string,
  entryId: string,
  timestamp: string,
  action: string,
  violations: unknown[]
): string {
  const data =
    prevHash + entryId + timestamp + action + JSON.stringify(violations);
  return createHash("sha256").update(data).digest("hex");
}

function insertLogWithIntegrity(
  db: Database.Database,
  entryId: string,
  agentId: string,
  timestamp: string,
  action: string,
  violations: unknown[],
  prevHash: string
): string {
  db.prepare(
    `INSERT INTO steward_log (id, agent_id, timestamp, chain, action, policy_set_id, rules_evaluated, violations, compliance_score_delta, estimated_usd_value, estimated_slippage_pct, counterparties) VALUES (?, ?, ?, 'solana', ?, 'default', 5, ?, 0.0, 5000, 0.5, '["prog1"]')`
  ).run(entryId, agentId, timestamp, action, JSON.stringify(violations));

  const hash = computeHash(prevHash, entryId, timestamp, action, violations);
  db.prepare(
    `INSERT INTO log_integrity (entry_id, prev_hash, integrity_hash) VALUES (?, ?, ?)`
  ).run(entryId, prevHash, hash);

  return hash;
}

function seedFullAgent(db: Database.Database) {
  // Agent with scores and log entries
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "agent-full",
    "FullAgent",
    '{"solana":"7xKXabc123"}',
    "2025-02-01T00:00:00Z",
    "{}",
    0
  );

  db.prepare(
    `INSERT INTO steward_scores (agent_id, score, total_evaluations, total_violations, violation_rate, critical_violations_30d, last_evaluation, score_trend, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "agent-full",
    8.5,
    25,
    3,
    0.12,
    1,
    "2025-03-05T00:00:00Z",
    "improving",
    "2025-03-05T00:00:00Z"
  );

  // Insert log entries with integrity chain
  let prevHash = GENESIS_HASH;
  prevHash = insertLogWithIntegrity(
    db,
    "log-f1",
    "agent-full",
    "2025-03-01T10:00:00Z",
    "approve",
    [],
    prevHash
  );
  prevHash = insertLogWithIntegrity(
    db,
    "log-f2",
    "agent-full",
    "2025-03-02T10:00:00Z",
    "reject",
    [
      {
        rule_id: "r1",
        rule_type: "max_usd_value",
        severity: "critical",
        message: "Exceeded max value",
        actual_value: 15000,
        threshold_value: 10000,
      },
    ],
    prevHash
  );
  prevHash = insertLogWithIntegrity(
    db,
    "log-f3",
    "agent-full",
    "2025-03-03T10:00:00Z",
    "reject",
    [
      {
        rule_id: "r2",
        rule_type: "max_slippage_pct",
        severity: "high",
        message: "Slippage too high",
        actual_value: 5.0,
        threshold_value: 3.0,
      },
      {
        rule_id: "r4",
        rule_type: "velocity_1h_count",
        severity: "medium",
        message: "Too many txs",
        actual_value: 25,
        threshold_value: 20,
      },
    ],
    prevHash
  );
  insertLogWithIntegrity(
    db,
    "log-f4",
    "agent-full",
    "2025-03-04T10:00:00Z",
    "approve",
    [],
    prevHash
  );
}

function seedPausedAgent(db: Database.Database) {
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "agent-paused",
    "PausedBot",
    '{"solana":"xyz999"}',
    "2025-01-15T00:00:00Z",
    "{}",
    1
  );
  db.prepare(
    `INSERT INTO steward_scores (agent_id, score, total_evaluations, total_violations, violation_rate, critical_violations_30d, last_evaluation, score_trend, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "agent-paused",
    4.2,
    30,
    18,
    0.6,
    3,
    "2025-02-20T00:00:00Z",
    "declining",
    "2025-02-20T00:00:00Z"
  );
}

function seedEmptyAgent(db: Database.Database) {
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "agent-empty",
    "EmptyBot",
    '{"solana":"empty000"}',
    "2025-03-01T00:00:00Z",
    "{}",
    0
  );
}

beforeEach(() => {
  db = createTestDatabase();
  seedFullAgent(db);
  seedPausedAgent(db);
  seedEmptyAgent(db);
});

// ─── Agent Detail Shape ─────────────────────────────────────────

describe("getAgentDetail shape", () => {
  it("returns all required fields for a full agent", () => {
    const detail = getAgentDetail(db, "agent-full");
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      id: "agent-full",
      name: "FullAgent",
      chain_signers: { solana: "7xKXabc123" },
      registered_at: "2025-02-01T00:00:00Z",
      is_paused: false,
      score: 8.5,
      score_trend: "improving",
      badge: "verified",
      total_evaluations: 25,
      total_violations: 3,
      critical_violations_30d: 1,
      last_evaluation: "2025-03-05T00:00:00Z",
    });
    expect(detail!.approval_rate).toBe(88); // (1 - 0.12) * 100 rounded
  });

  it("returns null for nonexistent agent", () => {
    expect(getAgentDetail(db, "no-such-agent")).toBeNull();
  });
});

// ─── Score History ──────────────────────────────────────────────

describe("getAgentScoreHistory", () => {
  it("returns score history in chronological order", () => {
    const history = getAgentScoreHistory(db, "agent-full");
    expect(history.length).toBe(4);
    // Chronological: each timestamp should be >= previous
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.computed_at >= history[i - 1]!.computed_at).toBe(true);
    }
  });

  it("computes running scores with correct values", () => {
    const history = getAgentScoreHistory(db, "agent-full");
    // First entry: 1 approve, 0 violations → score 10.0
    expect(history[0]!.score).toBe(10);
    // Second entry: 1 approve, 1 reject with critical(1.0) → rate = 1.0/2 = 0.5 → score 5.0
    expect(history[1]!.score).toBe(5);
    // Third: 1 approve, 2 rejects (critical=1.0, high=0.6, medium=0.3) → weightedViol=1.9, total=3 → rate=1.9/3≈0.633 → score≈3.7
    expect(history[2]!.score).toBe(3.7);
    // Fourth: 2 approves, 2 rejects → rate ≈ 1.9/4 ≈ 0.475 → score ≈ 5.2 (FP rounding)
    expect(history[3]!.score).toBe(5.2);
  });

  it("returns empty array for agent with no evaluations", () => {
    const history = getAgentScoreHistory(db, "agent-empty");
    expect(history).toEqual([]);
  });

  it("respects limit parameter", () => {
    const history = getAgentScoreHistory(db, "agent-full", 2);
    expect(history.length).toBe(2);
    // Should return the LAST 2 points
    expect(history[0]!.computed_at).toBe("2025-03-03T10:00:00Z");
    expect(history[1]!.computed_at).toBe("2025-03-04T10:00:00Z");
  });
});

// ─── Violation Breakdown Aggregation ────────────────────────────

describe("getAgentViolationBreakdown", () => {
  it("aggregates violation counts by severity correctly", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-full");
    expect(breakdown.by_severity["critical"]).toBe(1);
    expect(breakdown.by_severity["high"]).toBe(1);
    expect(breakdown.by_severity["medium"]).toBe(1);
    expect(breakdown.total).toBe(3);
  });

  it("aggregates violation counts by rule_type correctly", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-full");
    expect(breakdown.by_rule_type["max_usd_value"]).toBe(1);
    expect(breakdown.by_rule_type["max_slippage_pct"]).toBe(1);
    expect(breakdown.by_rule_type["velocity_1h_count"]).toBe(1);
  });

  it("returns zeros for agent with no violations", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-empty");
    expect(breakdown.total).toBe(0);
    expect(breakdown.by_severity).toEqual({});
    expect(breakdown.by_rule_type).toEqual({});
  });
});

// ─── Integrity Status ──────────────────────────────────────────

describe("getAgentIntegrityStatus", () => {
  it("returns valid for untampered log with correct entry count", () => {
    const status = getAgentIntegrityStatus(db, "agent-full");
    expect(status.valid).toBe(true);
    expect(status.entries_checked).toBe(4);
    expect(status.error).toBeUndefined();
  });

  it("returns valid for agent with no entries", () => {
    const status = getAgentIntegrityStatus(db, "agent-empty");
    expect(status.valid).toBe(true);
    expect(status.entries_checked).toBe(0);
  });

  it("detects tampered integrity hash", () => {
    // Tamper with a hash
    db.prepare(
      `UPDATE log_integrity SET integrity_hash = 'deadbeef' WHERE entry_id = 'log-f2'`
    ).run();

    const status = getAgentIntegrityStatus(db, "agent-full");
    expect(status.valid).toBe(false);
    expect(status.tampered_entry_id).toBe("log-f2");
  });

  it("detects missing integrity entries", () => {
    // Delete an integrity entry
    db.prepare(`DELETE FROM log_integrity WHERE entry_id = 'log-f3'`).run();

    const status = getAgentIntegrityStatus(db, "agent-full");
    expect(status.valid).toBe(false);
    expect(status.error).toContain("3");
  });
});

// ─── Paused Agent ──────────────────────────────────────────────

describe("paused agent state", () => {
  it("returns is_paused true for paused agent", () => {
    const detail = getAgentDetail(db, "agent-paused");
    expect(detail).not.toBeNull();
    expect(detail!.is_paused).toBe(true);
    expect(detail!.score).toBe(4.2);
    expect(detail!.badge).toBe("high-risk");
    expect(detail!.score_trend).toBe("declining");
  });
});

// ─── Zero Evaluations Agent ────────────────────────────────────

describe("agent with zero evaluations", () => {
  it("returns null score and empty arrays", () => {
    const detail = getAgentDetail(db, "agent-empty");
    expect(detail).not.toBeNull();
    expect(detail!.score).toBeNull();
    expect(detail!.total_evaluations).toBe(0);
    expect(detail!.badge).toBe("insufficient-data");

    const evals = getAgentRecentEvaluations(db, "agent-empty");
    expect(evals).toEqual([]);

    const history = getAgentScoreHistory(db, "agent-empty");
    expect(history).toEqual([]);

    const breakdown = getAgentViolationBreakdown(db, "agent-empty");
    expect(breakdown.total).toBe(0);
  });
});

// ─── Recent Evaluations ────────────────────────────────────────

describe("getAgentRecentEvaluations for detail page", () => {
  it("returns evaluations with parsed violations", () => {
    const evals = getAgentRecentEvaluations(db, "agent-full", 20);
    expect(evals.length).toBe(4);
    // Newest first
    expect(evals[0]!.timestamp).toBe("2025-03-04T10:00:00Z");
    expect(evals[0]!.action).toBe("approve");
    expect(evals[0]!.violations).toEqual([]);

    const rejected = evals.find((e) => e.id === "log-f3")!;
    expect(rejected.violations.length).toBe(2);
    expect(rejected.violations[0]!.severity).toBe("high");
    expect(rejected.violations[1]!.rule_type).toBe("velocity_1h_count");
  });
});

// ─── Score Color and Badge helpers ─────────────────────────────

describe("score badge and color for detail page", () => {
  it("maps verified agent correctly", () => {
    expect(getScoreBadge(8.5, 25)).toBe("verified");
    expect(getScoreColor("verified")).toBe("#10B981");
  });

  it("maps insufficient data correctly", () => {
    expect(getScoreBadge(null, 0)).toBe("insufficient-data");
    expect(getScoreColor("insufficient-data")).toBe("#6B7280");
  });
});
