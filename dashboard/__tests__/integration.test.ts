import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../lib/db";
import {
  getLeaderboard,
  getAgentDetail,
  getAgentRecentEvaluations,
  getAgentViolationBreakdown,
  getAgentScoreHistory,
  getAgentIntegrityStatus,
} from "../lib/queries";

let db: Database.Database;

const GENESIS_HASH = "0".repeat(64);

const VALID_RULE_TYPES = [
  "max_usd_value",
  "max_slippage_pct",
  "velocity_24h_usd",
  "velocity_1h_count",
  "blacklist_counterparties",
  "whitelist_programs",
  "concentration_pct",
  "auto_pause_consecutive_violations",
  "max_position_usd",
  "custom",
];

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

function seedIntegrationData(db: Database.Database) {
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertScore = db.prepare(
    `INSERT INTO steward_scores (agent_id, score, total_evaluations, total_violations, violation_rate, critical_violations_30d, last_evaluation, score_trend, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // 1. alpha-trader — score 9.2, 50 evals, 98% approval, improving, verified
  insertAgent.run(
    "agent-alpha",
    "alpha-trader",
    '{"solana":"alpha111"}',
    "2025-01-01T00:00:00Z",
    "{}",
    0
  );
  insertScore.run(
    "agent-alpha",
    9.2,
    50,
    1,
    0.02,
    0,
    "2025-03-08T00:00:00Z",
    "improving",
    "2025-03-08T00:00:00Z"
  );

  // 2. degen-bot — score 3.1, 30 evals, 40% approval, declining, high-risk
  insertAgent.run(
    "agent-degen",
    "degen-bot",
    '{"solana":"degen222"}',
    "2025-01-05T00:00:00Z",
    "{}",
    0
  );
  insertScore.run(
    "agent-degen",
    3.1,
    30,
    18,
    0.60,
    4,
    "2025-03-07T00:00:00Z",
    "declining",
    "2025-03-07T00:00:00Z"
  );

  // 3. yield-optimizer — score 7.5, 80 evals, 85% approval, stable, under-review
  insertAgent.run(
    "agent-yield",
    "yield-optimizer",
    '{"solana":"yield333"}',
    "2025-01-10T00:00:00Z",
    "{}",
    0
  );
  insertScore.run(
    "agent-yield",
    7.5,
    80,
    12,
    0.15,
    1,
    "2025-03-08T00:00:00Z",
    "stable",
    "2025-03-08T00:00:00Z"
  );

  // 4. new-agent — no score entry, 0 evaluations, insufficient-data
  insertAgent.run(
    "agent-new",
    "new-agent",
    '{"solana":"new444"}',
    "2025-03-09T00:00:00Z",
    "{}",
    0
  );
  // No steward_scores entry for this agent

  // 5. paused-agent — score 4.0, 20 evals, paused, declining, high-risk
  insertAgent.run(
    "agent-paused",
    "paused-agent",
    '{"solana":"paused555"}',
    "2025-02-01T00:00:00Z",
    "{}",
    1
  );
  insertScore.run(
    "agent-paused",
    4.0,
    20,
    11,
    0.55,
    3,
    "2025-03-05T00:00:00Z",
    "declining",
    "2025-03-05T00:00:00Z"
  );

  // --- Log entries for alpha-trader (mostly approves, 1 reject with critical) ---
  let prevHash = GENESIS_HASH;
  prevHash = insertLogWithIntegrity(
    db,
    "log-a1",
    "agent-alpha",
    "2025-03-01T10:00:00Z",
    "approve",
    [],
    prevHash
  );
  prevHash = insertLogWithIntegrity(
    db,
    "log-a2",
    "agent-alpha",
    "2025-03-02T10:00:00Z",
    "approve",
    [],
    prevHash
  );
  prevHash = insertLogWithIntegrity(
    db,
    "log-a3",
    "agent-alpha",
    "2025-03-03T10:00:00Z",
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
    "log-a4",
    "agent-alpha",
    "2025-03-04T10:00:00Z",
    "approve",
    [],
    prevHash
  );
  insertLogWithIntegrity(
    db,
    "log-a5",
    "agent-alpha",
    "2025-03-05T10:00:00Z",
    "approve",
    [],
    prevHash
  );

  // --- Log entries for degen-bot (many rejects with various violations) ---
  let degenPrev = GENESIS_HASH;
  degenPrev = insertLogWithIntegrity(
    db,
    "log-d1",
    "agent-degen",
    "2025-03-01T10:00:00Z",
    "reject",
    [
      {
        rule_id: "r1",
        rule_type: "max_usd_value",
        severity: "critical",
        message: "Exceeded max value",
        actual_value: 25000,
        threshold_value: 10000,
      },
    ],
    degenPrev
  );
  degenPrev = insertLogWithIntegrity(
    db,
    "log-d2",
    "agent-degen",
    "2025-03-01T11:00:00Z",
    "reject",
    [
      {
        rule_id: "r2",
        rule_type: "max_slippage_pct",
        severity: "high",
        message: "Slippage too high",
        actual_value: 6.0,
        threshold_value: 3.0,
      },
    ],
    degenPrev
  );
  degenPrev = insertLogWithIntegrity(
    db,
    "log-d3",
    "agent-degen",
    "2025-03-02T10:00:00Z",
    "approve",
    [],
    degenPrev
  );
  degenPrev = insertLogWithIntegrity(
    db,
    "log-d4",
    "agent-degen",
    "2025-03-02T11:00:00Z",
    "reject",
    [
      {
        rule_id: "r4",
        rule_type: "velocity_1h_count",
        severity: "medium",
        message: "Too many txs",
        actual_value: 30,
        threshold_value: 20,
      },
      {
        rule_id: "r1",
        rule_type: "max_usd_value",
        severity: "critical",
        message: "Exceeded max value",
        actual_value: 20000,
        threshold_value: 10000,
      },
    ],
    degenPrev
  );
  degenPrev = insertLogWithIntegrity(
    db,
    "log-d5",
    "agent-degen",
    "2025-03-03T10:00:00Z",
    "reject",
    [
      {
        rule_id: "r2",
        rule_type: "max_slippage_pct",
        severity: "high",
        message: "Slippage too high",
        actual_value: 8.0,
        threshold_value: 3.0,
      },
    ],
    degenPrev
  );
  insertLogWithIntegrity(
    db,
    "log-d6",
    "agent-degen",
    "2025-03-04T10:00:00Z",
    "approve",
    [],
    degenPrev
  );
}

beforeEach(() => {
  db = createTestDatabase();
  seedIntegrationData(db);
});

// ─── Leaderboard Integration ──────────────────────────────────────

describe("Leaderboard Integration", () => {
  it("default sort returns agents ordered by score descending (null last)", () => {
    const entries = getLeaderboard(db);
    expect(entries.length).toBe(4); // new-agent has no score entry, won't appear
    expect(entries[0]!.agent_name).toBe("alpha-trader");
    expect(entries[0]!.score).toBe(9.2);
    expect(entries[1]!.agent_name).toBe("yield-optimizer");
    expect(entries[1]!.score).toBe(7.5);
    expect(entries[2]!.agent_name).toBe("paused-agent");
    expect(entries[2]!.score).toBe(4.0);
    expect(entries[3]!.agent_name).toBe("degen-bot");
    expect(entries[3]!.score).toBe(3.1);
  });

  it("min_score filter excludes agents below threshold", () => {
    const entries = getLeaderboard(db, { minScore: 5.0 });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.score !== null && e.score >= 5.0)).toBe(true);
    expect(entries[0]!.agent_name).toBe("alpha-trader");
    expect(entries[1]!.agent_name).toBe("yield-optimizer");
  });

  it("sort_by evaluations returns correct order", () => {
    const entries = getLeaderboard(db, { sortBy: "evaluations" });
    expect(entries[0]!.total_evaluations).toBeGreaterThanOrEqual(
      entries[1]!.total_evaluations
    );
    expect(entries[0]!.agent_name).toBe("yield-optimizer");
    expect(entries[0]!.total_evaluations).toBe(80);
  });

  it("all scored agents appear with correct badges", () => {
    const entries = getLeaderboard(db);
    const alpha = entries.find((e) => e.agent_name === "alpha-trader")!;
    const yield_ = entries.find((e) => e.agent_name === "yield-optimizer")!;
    const degen = entries.find((e) => e.agent_name === "degen-bot")!;
    const paused = entries.find((e) => e.agent_name === "paused-agent")!;

    expect(alpha.badge).toBe("verified");
    expect(yield_.badge).toBe("under-review");
    expect(degen.badge).toBe("high-risk");
    expect(paused.badge).toBe("high-risk");
  });

  it("paused agent still appears on leaderboard", () => {
    const entries = getLeaderboard(db);
    const paused = entries.find((e) => e.agent_name === "paused-agent");
    expect(paused).toBeDefined();
    expect(paused!.score).toBe(4.0);
  });
});

// ─── Agent Detail Integration ─────────────────────────────────────

describe("Agent Detail Integration", () => {
  it("alpha-trader returns ClawSteward-verified badge and score >= 8", () => {
    const detail = getAgentDetail(db, "agent-alpha");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("alpha-trader");
    expect(detail!.score).toBe(9.2);
    expect(detail!.score).toBeGreaterThanOrEqual(8);
    expect(detail!.badge).toBe("verified");
    expect(detail!.score_trend).toBe("improving");
    expect(detail!.approval_rate).toBe(98);
  });

  it("degen-bot shows High Risk badge and has violation breakdown entries", () => {
    const detail = getAgentDetail(db, "agent-degen");
    expect(detail).not.toBeNull();
    expect(detail!.score).toBe(3.1);
    expect(detail!.badge).toBe("high-risk");
    expect(detail!.score_trend).toBe("declining");

    const breakdown = getAgentViolationBreakdown(db, "agent-degen");
    expect(breakdown.total).toBeGreaterThan(0);
    expect(Object.keys(breakdown.by_rule_type).length).toBeGreaterThan(0);
  });

  it("new-agent returns null score, empty evaluations, Insufficient Data badge", () => {
    const detail = getAgentDetail(db, "agent-new");
    expect(detail).not.toBeNull();
    expect(detail!.score).toBeNull();
    expect(detail!.total_evaluations).toBe(0);
    expect(detail!.badge).toBe("insufficient-data");

    const evals = getAgentRecentEvaluations(db, "agent-new");
    expect(evals).toEqual([]);
  });

  it("paused-agent has is_paused=true in response", () => {
    const detail = getAgentDetail(db, "agent-paused");
    expect(detail).not.toBeNull();
    expect(detail!.is_paused).toBe(true);
    expect(detail!.score).toBe(4.0);
    expect(detail!.badge).toBe("high-risk");
  });

  it("non-existent agent ID returns null", () => {
    const detail = getAgentDetail(db, "agent-nonexistent-xyz");
    expect(detail).toBeNull();
  });
});

// ─── Score History Integration ────────────────────────────────────

describe("Score History Integration", () => {
  it("agent with multiple evaluations has chronological score history points", () => {
    const history = getAgentScoreHistory(db, "agent-alpha");
    expect(history.length).toBe(5);
    // Chronological order
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.computed_at >= history[i - 1]!.computed_at).toBe(true);
    }
  });

  it("score history values are between 0 and 10", () => {
    const alphaHistory = getAgentScoreHistory(db, "agent-alpha");
    const degenHistory = getAgentScoreHistory(db, "agent-degen");

    for (const point of alphaHistory) {
      expect(point.score).toBeGreaterThanOrEqual(0);
      expect(point.score).toBeLessThanOrEqual(10);
    }
    for (const point of degenHistory) {
      expect(point.score).toBeGreaterThanOrEqual(0);
      expect(point.score).toBeLessThanOrEqual(10);
    }
  });
});

// ─── Violation Breakdown Integration ──────────────────────────────

describe("Violation Breakdown Integration", () => {
  it("breakdown by severity sums to total violations count", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-degen");
    const severitySum = Object.values(breakdown.by_severity).reduce(
      (a, b) => a + b,
      0
    );
    expect(severitySum).toBe(breakdown.total);
  });

  it("breakdown by rule_type contains only valid rule type names", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-degen");
    for (const ruleType of Object.keys(breakdown.by_rule_type)) {
      expect(VALID_RULE_TYPES).toContain(ruleType);
    }
  });

  it("agent with zero violations returns empty breakdown arrays", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-new");
    expect(breakdown.total).toBe(0);
    expect(breakdown.by_severity).toEqual({});
    expect(breakdown.by_rule_type).toEqual({});
  });
});

// ─── Integrity Integration ────────────────────────────────────────

describe("Integrity Integration", () => {
  it("untampered log returns { valid: true }", () => {
    const alphaStatus = getAgentIntegrityStatus(db, "agent-alpha");
    expect(alphaStatus.valid).toBe(true);
    expect(alphaStatus.entries_checked).toBe(5);
    expect(alphaStatus.error).toBeUndefined();

    const degenStatus = getAgentIntegrityStatus(db, "agent-degen");
    expect(degenStatus.valid).toBe(true);
    expect(degenStatus.entries_checked).toBe(6);
    expect(degenStatus.error).toBeUndefined();
  });
});

// ─── Cross-cutting Integration ────────────────────────────────────

describe("Cross-cutting Integration", () => {
  it("leaderboard ranks match score ordering", () => {
    const entries = getLeaderboard(db);
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i]!.rank).toBe(i + 1);
    }
  });

  it("agent detail score matches leaderboard score for same agent", () => {
    const entries = getLeaderboard(db);
    for (const entry of entries) {
      const detail = getAgentDetail(db, entry.agent_id);
      expect(detail).not.toBeNull();
      expect(detail!.score).toBe(entry.score);
    }
  });

  it("recent evaluations count is consistent with log entries inserted", () => {
    const alphaEvals = getAgentRecentEvaluations(db, "agent-alpha");
    expect(alphaEvals.length).toBe(5);

    const degenEvals = getAgentRecentEvaluations(db, "agent-degen");
    expect(degenEvals.length).toBe(6);

    const newEvals = getAgentRecentEvaluations(db, "agent-new");
    expect(newEvals.length).toBe(0);
  });

  it("degen-bot violation breakdown has expected rule types and counts", () => {
    const breakdown = getAgentViolationBreakdown(db, "agent-degen");
    // 2x max_usd_value (critical), 2x max_slippage_pct (high), 1x velocity_1h_count (medium)
    expect(breakdown.by_rule_type["max_usd_value"]).toBe(2);
    expect(breakdown.by_rule_type["max_slippage_pct"]).toBe(2);
    expect(breakdown.by_rule_type["velocity_1h_count"]).toBe(1);
    expect(breakdown.total).toBe(5);

    expect(breakdown.by_severity["critical"]).toBe(2);
    expect(breakdown.by_severity["high"]).toBe(2);
    expect(breakdown.by_severity["medium"]).toBe(1);
  });
});
