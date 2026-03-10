import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../../src/db/database.js";
import { insertAgent, upsertStewardScore, setAgentPaused } from "../../src/db/queries.js";
import { createAgent } from "../../src/core/agent.js";
import { appendToStewardLog } from "../../src/core/audit-log.js";
import type { PolicyViolation, StewardLogEntry } from "../../src/core/types.js";
import {
  computeStewardScore,
  computeStewardScoreFromEntries,
  computeWeightedViolationRate,
  computeScore,
  computeTrend,
  sumViolationWeights,
  countCriticalViolations30d,
} from "../../src/core/reputation.js";

let db: Database.Database;
let agentId: string;

// Fixed reference time for deterministic tests
const NOW = new Date("2026-03-09T12:00:00.000Z");

function makeViolation(severity: "critical" | "high" | "medium" | "low", id?: string): PolicyViolation {
  return {
    rule_id: id ?? `rule-${severity}`,
    rule_type: "max_usd_value",
    severity,
    message: `${severity} violation`,
    actual_value: 15000,
    threshold_value: 10000,
  };
}

function appendEntry(
  overrides: Partial<{
    action: "approve" | "reject" | "error";
    violations: PolicyViolation[];
    timestamp: string;
    estimated_usd_value: number;
  }> = {},
) {
  return appendToStewardLog(db, {
    agent_id: agentId,
    chain: "solana",
    action: overrides.action ?? "approve",
    policy_set_id: "default",
    rules_evaluated: 5,
    violations: overrides.violations ?? [],
    compliance_score_delta: 0,
    estimated_usd_value: overrides.estimated_usd_value ?? 100,
    estimated_slippage_pct: 0.5,
    counterparties: ["program111"],
  });
}

function makeLogEntry(
  overrides: Partial<StewardLogEntry> = {},
  index: number = 0,
): StewardLogEntry {
  const baseTime = new Date(NOW.getTime() - index * 60 * 60 * 1000); // 1 hour apart
  return {
    id: `entry-${index}`,
    agent_id: agentId,
    timestamp: overrides.timestamp ?? baseTime.toISOString(),
    chain: "solana",
    action: overrides.action ?? "approve",
    policy_set_id: "default",
    rules_evaluated: 5,
    violations: overrides.violations ?? [],
    compliance_score_delta: 0,
    estimated_usd_value: 100,
    estimated_slippage_pct: 0.5,
    counterparties: ["program111"],
    chain_payload: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createTestDatabase();
  const agent = createAgent({
    name: "TestAgent",
    chain: "solana",
    signer_address: "So11111111111111111111111111111111111111112",
  });
  agentId = agent.id;
  insertAgent(db, agent);
});

// ─── Pure Function Tests ─────────────────────────────────────────

describe("sumViolationWeights", () => {
  it("returns 0 for empty violations", () => {
    expect(sumViolationWeights([])).toBe(0);
  });

  it("weights critical at 1.0", () => {
    expect(sumViolationWeights([makeViolation("critical")])).toBe(1.0);
  });

  it("weights high at 0.6", () => {
    expect(sumViolationWeights([makeViolation("high")])).toBe(0.6);
  });

  it("weights medium at 0.3", () => {
    expect(sumViolationWeights([makeViolation("medium")])).toBe(0.3);
  });

  it("weights low at 0.1", () => {
    expect(sumViolationWeights([makeViolation("low")])).toBe(0.1);
  });

  it("sums multiple violations correctly", () => {
    const violations = [
      makeViolation("critical"),
      makeViolation("high"),
      makeViolation("low"),
    ];
    expect(sumViolationWeights(violations)).toBeCloseTo(1.7, 10);
  });
});

describe("computeScore", () => {
  it("returns 10.0 for zero violation rate", () => {
    expect(computeScore(0)).toBe(10.0);
  });

  it("returns 0.0 for violation rate of 1.0", () => {
    expect(computeScore(1.0)).toBe(0.0);
  });

  it("returns 5.0 for violation rate of 0.5", () => {
    expect(computeScore(0.5)).toBe(5.0);
  });

  it("clamps to 0.0 for rates > 1.0", () => {
    expect(computeScore(1.5)).toBe(0.0);
  });

  it("clamps to 10.0 for negative rates", () => {
    expect(computeScore(-0.5)).toBe(10.0);
  });
});

describe("computeWeightedViolationRate", () => {
  it("returns 0 for empty entries", () => {
    expect(computeWeightedViolationRate([], NOW)).toBe(0);
  });

  it("returns 0 for entries with no violations", () => {
    const entries = Array.from({ length: 20 }, (_, i) => makeLogEntry({}, i));
    expect(computeWeightedViolationRate(entries, NOW)).toBe(0);
  });

  it("computes correctly for all-critical violations", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry({ violations: [makeViolation("critical")] }, i),
    );
    // All entries are within last 100 and within 90 days → weight 3x
    // Each has violation weight 1.0
    // Rate = (10 * 1.0 * 3) / (10 * 3) = 1.0
    expect(computeWeightedViolationRate(entries, NOW)).toBe(1.0);
  });

  it("computes correctly for mixed severities", () => {
    // 5 clean entries + 5 entries with one high violation each
    const entries: StewardLogEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(makeLogEntry({}, i));
    }
    for (let i = 5; i < 10; i++) {
      entries.push(makeLogEntry({ violations: [makeViolation("high")] }, i));
    }
    // All within 100 recent, all within 90 days → weight 3x
    // Weighted violation sum = 5 * 0.6 * 3 = 9.0
    // Weighted eval sum = 10 * 3 = 30
    // Rate = 9.0 / 30 = 0.3
    expect(computeWeightedViolationRate(entries, NOW)).toBeCloseTo(0.3, 10);
  });

  it("applies 3x weight to last 100 evaluations", () => {
    // Create 150 entries: first 100 (newest) clean, last 50 with violations
    const entries: StewardLogEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push(makeLogEntry({}, i)); // clean, recent
    }
    for (let i = 100; i < 150; i++) {
      entries.push(makeLogEntry({ violations: [makeViolation("critical")] }, i));
    }
    // First 100: clean, weight 3x → violation sum = 0
    // Next 50: critical (1.0), weight 1x → violation sum = 50 * 1.0 * 1.0 = 50
    // Eval sum: 100 * 3 + 50 * 1 = 350
    // Rate = 50 / 350 ≈ 0.1429
    expect(computeWeightedViolationRate(entries, NOW)).toBeCloseTo(50 / 350, 10);
  });

  it("applies 0.5x weight to entries older than 90 days", () => {
    const oldDate = new Date(NOW.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const entries = [
      makeLogEntry({ timestamp: recentDate }, 0), // clean, recent, weight 3x
      makeLogEntry({ violations: [makeViolation("critical")], timestamp: oldDate }, 1), // old, weight 0.5x
    ];
    // Violation sum = 1.0 * 0.5 = 0.5
    // Eval sum = 3 + 0.5 = 3.5
    // Rate = 0.5 / 3.5 ≈ 0.1429
    expect(computeWeightedViolationRate(entries, NOW)).toBeCloseTo(0.5 / 3.5, 10);
  });
});

describe("computeTrend", () => {
  it("returns stable when no entries existed 7 days ago", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeLogEntry({ timestamp: new Date(NOW.getTime() - i * 60 * 60 * 1000).toISOString() }, i),
    );
    expect(computeTrend(10.0, entries, NOW)).toBe("stable");
  });

  it("returns improving when score increased significantly", () => {
    // Create entries where old ones had violations but recent ones are clean
    const entries: StewardLogEntry[] = [];
    // 10 clean entries in last 3 days
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeLogEntry({
          timestamp: new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
        }, i),
      );
    }
    // 15 entries with critical violations from 8-20 days ago
    for (let i = 0; i < 15; i++) {
      entries.push(
        makeLogEntry({
          violations: [makeViolation("critical")],
          timestamp: new Date(NOW.getTime() - (8 + i) * 24 * 60 * 60 * 1000).toISOString(),
        }, 10 + i),
      );
    }

    // Current score should be better than 7-day-ago score (which had more violations in recent window)
    const rate = computeWeightedViolationRate(entries, NOW);
    const currentScore = computeScore(rate);
    const trend = computeTrend(currentScore, entries, NOW);
    expect(trend).toBe("improving");
  });

  it("returns declining when score decreased significantly", () => {
    // Old entries were clean, recent entries have violations
    const entries: StewardLogEntry[] = [];
    // 10 entries with critical violations in last 3 days
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeLogEntry({
          violations: [makeViolation("critical")],
          timestamp: new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
        }, i),
      );
    }
    // 15 clean entries from 8-20 days ago
    for (let i = 0; i < 15; i++) {
      entries.push(
        makeLogEntry({
          timestamp: new Date(NOW.getTime() - (8 + i) * 24 * 60 * 60 * 1000).toISOString(),
        }, 10 + i),
      );
    }

    const rate = computeWeightedViolationRate(entries, NOW);
    const currentScore = computeScore(rate);
    const trend = computeTrend(currentScore, entries, NOW);
    expect(trend).toBe("declining");
  });

  it("returns stable when score is unchanged", () => {
    // All entries are clean, spread over 14 days
    const entries: StewardLogEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(
        makeLogEntry({
          timestamp: new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
        }, i),
      );
    }

    expect(computeTrend(10.0, entries, NOW)).toBe("stable");
  });
});

describe("countCriticalViolations30d", () => {
  it("returns 0 when no violations", () => {
    const entries = [makeLogEntry({}, 0)];
    expect(countCriticalViolations30d(entries, NOW)).toBe(0);
  });

  it("counts critical violations within 30 days", () => {
    const entries = [
      makeLogEntry({ violations: [makeViolation("critical"), makeViolation("critical")] }, 0),
      makeLogEntry({ violations: [makeViolation("critical")] }, 1),
    ];
    expect(countCriticalViolations30d(entries, NOW)).toBe(3);
  });

  it("excludes critical violations older than 30 days", () => {
    const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const entries = [
      makeLogEntry({ violations: [makeViolation("critical")] }, 0), // recent
      makeLogEntry({ violations: [makeViolation("critical")], timestamp: oldDate }, 1), // old
    ];
    expect(countCriticalViolations30d(entries, NOW)).toBe(1);
  });

  it("ignores non-critical violations", () => {
    const entries = [
      makeLogEntry({ violations: [makeViolation("high"), makeViolation("medium")] }, 0),
    ];
    expect(countCriticalViolations30d(entries, NOW)).toBe(0);
  });
});

// ─── computeStewardScoreFromEntries (pure, no DB) ────────────────

describe("computeStewardScoreFromEntries", () => {
  it("returns null score for < 10 evaluations", () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeLogEntry({}, i));
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.score).toBeNull();
    expect(result.score_trend).toBeNull();
    expect(result.total_evaluations).toBe(5);
  });

  it("returns 10.0 for 0 violations with 10+ entries", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeLogEntry({
        timestamp: new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
      }, i),
    );
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.score).toBe(10.0);
    expect(result.total_violations).toBe(0);
    expect(result.violation_rate).toBe(0);
  });

  it("computes correct score for mixed entries", () => {
    const entries: StewardLogEntry[] = [];
    // 8 clean entries
    for (let i = 0; i < 8; i++) {
      entries.push(makeLogEntry({}, i));
    }
    // 2 entries with high violations
    for (let i = 8; i < 10; i++) {
      entries.push(makeLogEntry({ violations: [makeViolation("high")] }, i));
    }

    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.score).not.toBeNull();
    // All within 100 recent, weight 3x
    // Violation sum = 2 * 0.6 * 3 = 3.6
    // Eval sum = 10 * 3 = 30
    // Rate = 3.6 / 30 = 0.12
    // Score = 10 * (1 - 0.12) = 8.8
    expect(result.score).toBeCloseTo(8.8, 1);
    expect(result.total_evaluations).toBe(10);
    expect(result.total_violations).toBe(2);
  });

  it("is deterministic — same input always gives same output", () => {
    const entries = Array.from({ length: 20 }, (_, i) => {
      const hasViolation = i % 3 === 0;
      return makeLogEntry(
        hasViolation ? { violations: [makeViolation("medium")] } : {},
        i,
      );
    });

    const result1 = computeStewardScoreFromEntries(agentId, entries, NOW);
    const result2 = computeStewardScoreFromEntries(agentId, entries, NOW);

    expect(result1.score).toBe(result2.score);
    expect(result1.total_evaluations).toBe(result2.total_evaluations);
    expect(result1.total_violations).toBe(result2.total_violations);
    expect(result1.violation_rate).toBe(result2.violation_rate);
    expect(result1.score_trend).toBe(result2.score_trend);
  });

  it("returns correct violation_rate", () => {
    const entries: StewardLogEntry[] = [];
    for (let i = 0; i < 8; i++) entries.push(makeLogEntry({}, i));
    for (let i = 8; i < 10; i++) {
      entries.push(makeLogEntry({ violations: [makeViolation("low")] }, i));
    }
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.violation_rate).toBeCloseTo(0.2, 10);
  });

  it("returns correct last_evaluation timestamp", () => {
    const newest = new Date(NOW.getTime() - 1000).toISOString();
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry({
        timestamp: new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000).toISOString(),
      }, i),
    );
    entries[3] = makeLogEntry({ timestamp: newest }, 3);

    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.last_evaluation).toBe(newest);
  });

  it("clamps score to 0.0 for extreme violation rates", () => {
    // All entries have multiple critical violations
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry({
        violations: [makeViolation("critical"), makeViolation("critical")],
      }, i),
    );
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    // Rate = 2.0 per entry → clamped
    expect(result.score).toBe(0.0);
  });

  it("handles entries with empty violations array as clean", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry({ action: "approve", violations: [] }, i),
    );
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.score).toBe(10.0);
    expect(result.total_violations).toBe(0);
  });
});

// ─── computeStewardScore (with DB) ───────────────────────────────

describe("computeStewardScore (DB integration)", () => {
  it("returns null score for agent with no evaluations", () => {
    const result = computeStewardScore(db, agentId, NOW);
    expect(result.score).toBeNull();
    expect(result.total_evaluations).toBe(0);
    expect(result.score_trend).toBeNull();
  });

  it("returns null score for agent with < 10 evaluations", () => {
    for (let i = 0; i < 9; i++) {
      appendEntry();
    }
    const result = computeStewardScore(db, agentId, NOW);
    expect(result.score).toBeNull();
    expect(result.total_evaluations).toBe(9);
  });

  it("returns 10.0 for agent with all clean evaluations", () => {
    for (let i = 0; i < 15; i++) {
      appendEntry();
    }
    const result = computeStewardScore(db, agentId, NOW);
    expect(result.score).toBe(10.0);
    expect(result.total_evaluations).toBe(15);
    expect(result.total_violations).toBe(0);
  });

  it("computes correct score with violations in DB", () => {
    // 8 clean + 2 high violations = 10 entries
    for (let i = 0; i < 8; i++) {
      appendEntry();
    }
    for (let i = 0; i < 2; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("high")] });
    }
    const result = computeStewardScore(db, agentId, NOW);
    expect(result.score).not.toBeNull();
    expect(result.total_evaluations).toBe(10);
    expect(result.total_violations).toBe(2);
    // Score should be around 8.8 (same math as pure test)
    expect(result.score!).toBeCloseTo(8.8, 1);
  });

  it("returns frozen score for paused agent with cached score", () => {
    // Insert a cached score
    upsertStewardScore(db, {
      agent_id: agentId,
      score: 7.5,
      total_evaluations: 50,
      total_violations: 10,
      violation_rate: 0.2,
      critical_violations_30d: 2,
      last_evaluation: "2026-03-08T00:00:00.000Z",
      score_trend: "stable",
      computed_at: "2026-03-08T12:00:00.000Z",
    });

    // Pause the agent
    setAgentPaused(db, agentId, true);

    // Add more entries (should be ignored since agent is paused)
    for (let i = 0; i < 5; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("critical")] });
    }

    const result = computeStewardScore(db, agentId, NOW);
    // Should return the frozen cached score, not recompute
    expect(result.score).toBe(7.5);
    expect(result.total_evaluations).toBe(50);
  });

  it("returns null score for paused agent with no cached score", () => {
    setAgentPaused(db, agentId, true);
    const result = computeStewardScore(db, agentId, NOW);
    expect(result.score).toBeNull();
  });

  it("counts critical violations in last 30 days", () => {
    for (let i = 0; i < 10; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("critical")] });
    }
    const result = computeStewardScore(db, agentId, NOW);
    expect(result.critical_violations_30d).toBe(10);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("exactly 10 evaluations returns a score (not null)", () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeLogEntry({}, i));
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.score).not.toBeNull();
  });

  it("9 evaluations returns null score", () => {
    const entries = Array.from({ length: 9 }, (_, i) => makeLogEntry({}, i));
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    expect(result.score).toBeNull();
  });

  it("single entry with multiple violations sums their weights", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry(
        i === 0
          ? { violations: [makeViolation("critical"), makeViolation("high"), makeViolation("low")] }
          : {},
        i,
      ),
    );
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    // violation weight = 1.0 + 0.6 + 0.1 = 1.7 for that one entry
    // Rate = (1.7 * 3) / (10 * 3) = 5.1 / 30 = 0.17
    // Score = 10 * (1 - 0.17) = 8.3
    expect(result.score).toBeCloseTo(8.3, 1);
  });

  it("handles error action entries (counted as evaluations)", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry({ action: "error" }, i),
    );
    const result = computeStewardScoreFromEntries(agentId, entries, NOW);
    // Error entries have no violations array populated → score 10.0
    expect(result.score).toBe(10.0);
  });

  it("time decay applies correctly at 90-day boundary", () => {
    const at89Days = new Date(NOW.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString();
    const at91Days = new Date(NOW.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString();

    // Entry at 89 days should get normal weight (3x if within first 100)
    // Entry at 91 days should get 0.5x weight
    const entries89 = [
      ...Array.from({ length: 9 }, (_, i) => makeLogEntry({}, i)),
      makeLogEntry({ violations: [makeViolation("critical")], timestamp: at89Days }, 9),
    ];
    const entries91 = [
      ...Array.from({ length: 9 }, (_, i) => makeLogEntry({}, i)),
      makeLogEntry({ violations: [makeViolation("critical")], timestamp: at91Days }, 9),
    ];

    const score89 = computeStewardScoreFromEntries(agentId, entries89, NOW);
    const score91 = computeStewardScoreFromEntries(agentId, entries91, NOW);

    // 91-day-old violation weighted less → higher score
    expect(score91.score!).toBeGreaterThan(score89.score!);
  });
});
