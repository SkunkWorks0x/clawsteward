// ClawSteward MCP Handlers — Test Suite
// Tests all 5 handlers with in-memory SQLite. Minimum 20 tests.

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../../src/db/database.js";
import {
  handleEvaluate,
  handleRegister,
  handleScore,
  handleLeaderboard,
  handleScan,
  ErrorCode,
  type HandlerDeps,
} from "../../src/mcp/handlers.js";
import type { ChainSimulator } from "../../src/chain/simulator.js";
import type { AssetDelta, SimulationContext, SimulationResult } from "../../src/core/types.js";
import { registerAgent } from "../../src/core/agent.js";
import { appendToStewardLog } from "../../src/core/audit-log.js";
import { computeStewardScore } from "../../src/core/reputation.js";
import { upsertStewardScore } from "../../src/db/queries.js";

// ─── Mock Simulator ─────────────────────────────────────────────

function createMockSimulator(
  overrides: Partial<SimulationResult> = {},
): ChainSimulator {
  return {
    chain: "solana",
    async simulate(
      _tx: unknown,
      _ctx: SimulationContext,
    ): Promise<SimulationResult> {
      return {
        success: true,
        chain: "solana",
        estimated_usd_value: 500,
        estimated_slippage_pct: 0.5,
        counterparties: ["11111111111111111111111111111111"],
        assets_affected: [],
        raw_chain_payload: { logs: [], unitsConsumed: 100, accountsAccessed: [], err: null },
        simulation_timestamp: new Date().toISOString(),
        ...overrides,
      };
    },
    validateAddress(_addr: string): boolean {
      return true;
    },
    async estimateUsdValue(_assets: AssetDelta[]): Promise<number> {
      return overrides.estimated_usd_value ?? 500;
    },
  };
}

function createFailingSimulator(error: string): ChainSimulator {
  return {
    chain: "solana",
    async simulate(): Promise<SimulationResult> {
      return {
        success: false,
        chain: "solana",
        estimated_usd_value: 0,
        estimated_slippage_pct: 0,
        counterparties: [],
        assets_affected: [],
        raw_chain_payload: null,
        simulation_timestamp: new Date().toISOString(),
        error,
      };
    },
    validateAddress(): boolean {
      return true;
    },
    async estimateUsdValue(): Promise<number> {
      return 0;
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function makeDeps(
  db: Database.Database,
  simulator?: ChainSimulator,
): HandlerDeps {
  return {
    db,
    getSimulator: (chain: string) =>
      chain === "solana" ? (simulator ?? createMockSimulator()) : undefined,
  };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

function registerTestAgent(db: Database.Database, name = "TestAgent") {
  return registerAgent(db, {
    name,
    chain: "solana",
    signer_address: "So11111111111111111111111111111111111111112",
  });
}

/** Add N approve log entries for an agent */
function addApproveEntries(db: Database.Database, agentId: string, count: number) {
  for (let i = 0; i < count; i++) {
    appendToStewardLog(db, {
      agent_id: agentId,
      chain: "solana",
      action: "approve",
      policy_set_id: "default",
      rules_evaluated: 5,
      violations: [],
      compliance_score_delta: 0,
      estimated_usd_value: 100,
      estimated_slippage_pct: 0.1,
      counterparties: ["11111111111111111111111111111111"],
    });
  }
}

/** Add a reject log entry with a violation */
function addRejectEntry(
  db: Database.Database,
  agentId: string,
  severity: "critical" | "high" | "medium" | "low" = "high",
) {
  appendToStewardLog(db, {
    agent_id: agentId,
    chain: "solana",
    action: "reject",
    policy_set_id: "default",
    rules_evaluated: 5,
    violations: [
      {
        rule_id: "r1",
        rule_type: "max_usd_value",
        severity,
        message: `Test ${severity} violation`,
        actual_value: 20000,
        threshold_value: 10000,
      },
    ],
    compliance_score_delta: -1,
    estimated_usd_value: 20000,
    estimated_slippage_pct: 0.5,
    counterparties: ["11111111111111111111111111111111"],
  });
}

// ─── Tests ──────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = createTestDatabase();
});

// ─── handleEvaluate ─────────────────────────────────────────────

describe("handleEvaluate", () => {
  it("should approve a compliant transaction", async () => {
    const agent = registerTestAgent(db);
    const deps = makeDeps(db);

    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
      policy_set_id: "default",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(true);
    expect(data["violations"]).toEqual([]);
    expect(data["evaluation_id"]).toBeDefined();
    expect(data["steward_score"]).toBeDefined();
  });

  it("should reject a transaction that violates max_usd_value", async () => {
    const agent = registerTestAgent(db);
    // Simulate high-value tx that exceeds default $10k cap
    const simulator = createMockSimulator({ estimated_usd_value: 15000 });
    const deps = makeDeps(db, simulator);

    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);
    const violations = data["violations"] as Array<Record<string, unknown>>;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v["rule_type"] === "max_usd_value")).toBe(true);
  });

  it("should reject a transaction that violates max_slippage_pct", async () => {
    const agent = registerTestAgent(db);
    // Slippage above 3% default
    const simulator = createMockSimulator({ estimated_slippage_pct: 5.0 });
    const deps = makeDeps(db, simulator);

    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);
    const violations = data["violations"] as Array<Record<string, unknown>>;
    expect(violations.some((v) => v["rule_type"] === "max_slippage_pct")).toBe(true);
  });

  it("should return AGENT_NOT_FOUND for nonexistent agent", async () => {
    const deps = makeDeps(db);

    const result = await handleEvaluate(deps, {
      agent_id: "nonexistent-id",
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_NOT_FOUND);
  });

  it("should return AGENT_PAUSED for a paused agent", async () => {
    const agent = registerTestAgent(db);
    // Pause the agent
    db.prepare("UPDATE agents SET is_paused = 1 WHERE id = ?").run(agent.id);

    const deps = makeDeps(db);
    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_PAUSED);
  });

  it("should return POLICY_SET_NOT_FOUND for nonexistent policy", async () => {
    const agent = registerTestAgent(db);
    const deps = makeDeps(db);

    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
      policy_set_id: "nonexistent-policy",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.POLICY_SET_NOT_FOUND);
  });

  it("should return SIMULATION_FAILED when simulation errors", async () => {
    const agent = registerTestAgent(db);
    const simulator = createFailingSimulator("RPC timeout");
    const deps = makeDeps(db, simulator);

    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.SIMULATION_FAILED);
  });

  it("should recompute and cache steward score after evaluation", async () => {
    const agent = registerTestAgent(db);
    const deps = makeDeps(db);

    await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Score should now be cached
    const cached = db
      .prepare("SELECT * FROM steward_scores WHERE agent_id = ?")
      .get(agent.id) as Record<string, unknown> | undefined;
    expect(cached).toBeDefined();
  });

  it("should use default policy set when none specified", async () => {
    const agent = registerTestAgent(db);
    const deps = makeDeps(db);

    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBeDefined();
  });

  it("should append to steward log with chain_payload", async () => {
    const agent = registerTestAgent(db);
    const deps = makeDeps(db);

    await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const entries = db
      .prepare("SELECT * FROM steward_log WHERE agent_id = ?")
      .all(agent.id) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["chain_payload"]).not.toBeNull();
  });
});

// ─── handleRegister ─────────────────────────────────────────────

describe("handleRegister", () => {
  it("should register a new agent and return agent_id", () => {
    const deps = makeDeps(db);

    const result = handleRegister(deps, {
      name: "NewAgent",
      chain_signers: [
        { chain: "solana", address: "So11111111111111111111111111111111111111112" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["agent_id"]).toBeDefined();
    expect(data["name"]).toBe("NewAgent");
    expect(data["registered"]).toBe(true);
    expect(data["registered_at"]).toBeDefined();
    expect(data["chain_signers"]).toEqual({
      solana: "So11111111111111111111111111111111111111112",
    });
  });

  it("should register and return null score with 0 evaluations", () => {
    const deps = makeDeps(db);

    const regResult = handleRegister(deps, {
      name: "FreshAgent",
      chain_signers: [
        { chain: "solana", address: "FreshAddr111111111111111111111111111111111" },
      ],
    });

    const regData = parseResult(regResult) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // Now check score
    const scoreResult = handleScore(deps, { agent_id: agentId });
    const scoreData = parseResult(scoreResult) as Record<string, unknown>;
    expect(scoreData["score"]).toBeNull();
    expect(scoreData["total_evaluations"]).toBe(0);
    expect(scoreData["badge"]).toBe("Insufficient Data");
  });

  it("should allow duplicate names (IDs are unique)", () => {
    const deps = makeDeps(db);

    const result1 = handleRegister(deps, {
      name: "SameName",
      chain_signers: [
        { chain: "solana", address: "Addr1111111111111111111111111111111111111111" },
      ],
    });
    const result2 = handleRegister(deps, {
      name: "SameName",
      chain_signers: [
        { chain: "solana", address: "Addr2222222222222222222222222222222222222222" },
      ],
    });

    expect(result1.isError).toBeUndefined();
    expect(result2.isError).toBeUndefined();

    const data1 = parseResult(result1) as Record<string, unknown>;
    const data2 = parseResult(result2) as Record<string, unknown>;
    expect(data1["agent_id"]).not.toBe(data2["agent_id"]);
    expect(data1["name"]).toBe(data2["name"]);
  });

  it("should associate optional policy_set_id in metadata", () => {
    const deps = makeDeps(db);

    const result = handleRegister(deps, {
      name: "PolicyAgent",
      chain_signers: [
        { chain: "solana", address: "PolAddr11111111111111111111111111111111111" },
      ],
      policy_set_id: "custom-policy",
    });

    const data = parseResult(result) as Record<string, unknown>;
    const agentId = data["agent_id"] as string;

    // Verify metadata stored
    const agent = db
      .prepare("SELECT metadata FROM agents WHERE id = ?")
      .get(agentId) as { metadata: string };
    const metadata = JSON.parse(agent.metadata);
    expect(metadata["default_policy_set"]).toBe("custom-policy");
  });
});

// ─── handleScore ────────────────────────────────────────────────

describe("handleScore", () => {
  it("should return null score for agent with < 10 evaluations", () => {
    const agent = registerTestAgent(db);
    addApproveEntries(db, agent.id, 5);

    const deps = makeDeps(db);
    const result = handleScore(deps, { agent_id: agent.id });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["score"]).toBeNull();
    expect(data["total_evaluations"]).toBe(5);
    expect(data["badge"]).toBe("Insufficient Data");
  });

  it("should return perfect score for agent with 0 violations", () => {
    const agent = registerTestAgent(db);
    addApproveEntries(db, agent.id, 15);

    const deps = makeDeps(db);
    const result = handleScore(deps, { agent_id: agent.id });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["score"]).toBe(10.0);
    expect(data["total_evaluations"]).toBe(15);
    expect(data["violation_rate"]).toBe(0);
    expect(data["badge"]).toBe("ClawSteward-verified");
  });

  it("should return AGENT_NOT_FOUND for nonexistent agent", () => {
    const deps = makeDeps(db);
    const result = handleScore(deps, { agent_id: "nonexistent" });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_NOT_FOUND);
  });

  it("should compute score with violations and return correct badge", () => {
    const agent = registerTestAgent(db);
    addApproveEntries(db, agent.id, 8);
    addRejectEntry(db, agent.id, "high");
    addRejectEntry(db, agent.id, "medium");
    addApproveEntries(db, agent.id, 5);

    const deps = makeDeps(db);
    const result = handleScore(deps, { agent_id: agent.id });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["score"]).not.toBeNull();
    const score = data["score"] as number;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(10);
    expect(data["total_evaluations"]).toBe(15);
    expect(data["total_violations"]).toBe(2);
  });

  it("should include agent name in response", () => {
    const agent = registerTestAgent(db, "NamedAgent");
    addApproveEntries(db, agent.id, 12);

    const deps = makeDeps(db);
    const result = handleScore(deps, { agent_id: agent.id });
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["name"]).toBe("NamedAgent");
  });
});

// ─── handleLeaderboard ──────────────────────────────────────────

describe("handleLeaderboard", () => {
  it("should return empty leaderboard when no scores exist", () => {
    const deps = makeDeps(db);
    const result = handleLeaderboard(deps, { limit: 20 });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["total"]).toBe(0);
    expect(data["leaderboard"]).toEqual([]);
  });

  it("should return agents ordered by score descending", () => {
    // Create two agents with different scores
    const agent1 = registerTestAgent(db, "Agent1");
    const agent2 = registerTestAgent(db, "Agent2");

    // Agent1: perfect record
    addApproveEntries(db, agent1.id, 15);
    const score1 = computeStewardScore(db, agent1.id);
    upsertStewardScore(db, score1);

    // Agent2: some violations
    addApproveEntries(db, agent2.id, 10);
    addRejectEntry(db, agent2.id, "high");
    addRejectEntry(db, agent2.id, "critical");
    addApproveEntries(db, agent2.id, 3);
    const score2 = computeStewardScore(db, agent2.id);
    upsertStewardScore(db, score2);

    const deps = makeDeps(db);
    const result = handleLeaderboard(deps, { limit: 20 });
    const data = parseResult(result) as Record<string, unknown>;
    const leaderboard = data["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard).toHaveLength(2);
    expect(leaderboard[0]!["rank"]).toBe(1);
    expect(leaderboard[0]!["name"]).toBe("Agent1");
    expect(leaderboard[0]!["score"]).toBe(10.0);
    expect(leaderboard[1]!["rank"]).toBe(2);
    expect(leaderboard[1]!["name"]).toBe("Agent2");
    expect((leaderboard[1]!["score"] as number)).toBeLessThan(10.0);
  });

  it("should filter by min_score", () => {
    const agent1 = registerTestAgent(db, "HighScore");
    const agent2 = registerTestAgent(db, "LowScore");

    addApproveEntries(db, agent1.id, 15);
    const s1 = computeStewardScore(db, agent1.id);
    upsertStewardScore(db, s1);

    addApproveEntries(db, agent2.id, 10);
    addRejectEntry(db, agent2.id, "critical");
    addRejectEntry(db, agent2.id, "critical");
    addRejectEntry(db, agent2.id, "critical");
    const s2 = computeStewardScore(db, agent2.id);
    upsertStewardScore(db, s2);

    const deps = makeDeps(db);
    const result = handleLeaderboard(deps, { limit: 20, min_score: 9.0 });
    const data = parseResult(result) as Record<string, unknown>;
    const leaderboard = data["leaderboard"] as Array<Record<string, unknown>>;

    // Only the perfect-score agent should appear
    expect(leaderboard.length).toBe(1);
    expect(leaderboard[0]!["name"]).toBe("HighScore");
  });

  it("should respect limit parameter", () => {
    // Create 5 agents with scores
    for (let i = 0; i < 5; i++) {
      const a = registerTestAgent(db, `Agent${i}`);
      addApproveEntries(db, a.id, 12);
      const s = computeStewardScore(db, a.id);
      upsertStewardScore(db, s);
    }

    const deps = makeDeps(db);
    const result = handleLeaderboard(deps, { limit: 3 });
    const data = parseResult(result) as Record<string, unknown>;
    const leaderboard = data["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard.length).toBeLessThanOrEqual(3);
  });

  it("should include badge in leaderboard entries", () => {
    const agent = registerTestAgent(db, "BadgeAgent");
    addApproveEntries(db, agent.id, 15);
    const s = computeStewardScore(db, agent.id);
    upsertStewardScore(db, s);

    const deps = makeDeps(db);
    const result = handleLeaderboard(deps, { limit: 20 });
    const data = parseResult(result) as Record<string, unknown>;
    const leaderboard = data["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard[0]!["badge"]).toBe("ClawSteward-verified");
  });

  it("should exclude agents with < 10 evaluations", () => {
    const agent = registerTestAgent(db, "NewbieAgent");
    addApproveEntries(db, agent.id, 5);
    const s = computeStewardScore(db, agent.id);
    upsertStewardScore(db, s);

    const deps = makeDeps(db);
    const result = handleLeaderboard(deps, { limit: 20 });
    const data = parseResult(result) as Record<string, unknown>;
    const leaderboard = data["leaderboard"] as Array<Record<string, unknown>>;

    // Agent with null score (< 10 evals) should not appear
    expect(leaderboard.length).toBe(0);
  });
});

// ─── handleScan ─────────────────────────────────────────────────

describe("handleScan", () => {
  it("should return scan with mixed approve/reject results", () => {
    const agent = registerTestAgent(db);
    addApproveEntries(db, agent.id, 5);
    addRejectEntry(db, agent.id, "critical");
    addRejectEntry(db, agent.id, "high");
    addApproveEntries(db, agent.id, 3);

    const deps = makeDeps(db);
    const result = handleScan(deps, { agent_id: agent.id, days: 30 });
    const data = parseResult(result) as Record<string, unknown>;

    const summary = data["summary"] as Record<string, unknown>;
    expect(summary["total_evaluations"]).toBe(10);
    expect(summary["approvals"]).toBe(8);
    expect(summary["rejections"]).toBe(2);
    expect(summary["approval_rate"]).toBe(80.0);

    const breakdown = data["violation_breakdown_by_severity"] as Record<string, number>;
    expect(breakdown["critical"]).toBe(1);
    expect(breakdown["high"]).toBe(1);
  });

  it("should return empty scan for agent with no evaluations", () => {
    const agent = registerTestAgent(db);
    const deps = makeDeps(db);

    const result = handleScan(deps, { agent_id: agent.id, days: 30 });
    const data = parseResult(result) as Record<string, unknown>;

    const summary = data["summary"] as Record<string, unknown>;
    expect(summary["total_evaluations"]).toBe(0);
    expect(summary["approvals"]).toBe(0);
    expect(summary["rejections"]).toBe(0);
    expect(summary["approval_rate"]).toBeNull();

    const recentEntries = data["recent_entries"] as unknown[];
    expect(recentEntries).toHaveLength(0);
  });

  it("should return AGENT_NOT_FOUND for nonexistent agent", () => {
    const deps = makeDeps(db);
    const result = handleScan(deps, { agent_id: "nonexistent", days: 30 });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_NOT_FOUND);
  });

  it("should include recent_entries limited to 10", () => {
    const agent = registerTestAgent(db);
    addApproveEntries(db, agent.id, 15);

    const deps = makeDeps(db);
    const result = handleScan(deps, { agent_id: agent.id, days: 30 });
    const data = parseResult(result) as Record<string, unknown>;

    const recentEntries = data["recent_entries"] as unknown[];
    expect(recentEntries.length).toBeLessThanOrEqual(10);
  });

  it("should include violation breakdown by type", () => {
    const agent = registerTestAgent(db);
    addRejectEntry(db, agent.id, "high");
    addRejectEntry(db, agent.id, "critical");

    const deps = makeDeps(db);
    const result = handleScan(deps, { agent_id: agent.id, days: 30 });
    const data = parseResult(result) as Record<string, unknown>;

    const byType = data["violations_by_type"] as Record<string, number>;
    expect(byType["max_usd_value"]).toBe(2);
  });

  it("should report is_paused status", () => {
    const agent = registerTestAgent(db);
    db.prepare("UPDATE agents SET is_paused = 1 WHERE id = ?").run(agent.id);

    const deps = makeDeps(db);
    const result = handleScan(deps, { agent_id: agent.id, days: 30 });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["is_paused"]).toBe(true);
  });

  it("should respect custom days parameter", () => {
    const agent = registerTestAgent(db);
    addApproveEntries(db, agent.id, 5);

    const deps = makeDeps(db);
    const result = handleScan(deps, { agent_id: agent.id, days: 7 });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["scan_window_days"]).toBe(7);
  });
});

// ─── Cross-handler Integration ──────────────────────────────────

describe("cross-handler integration", () => {
  it("register → evaluate → score full flow", async () => {
    const deps = makeDeps(db);

    // Register
    const regResult = handleRegister(deps, {
      name: "FlowAgent",
      chain_signers: [
        { chain: "solana", address: "FlowAddr1111111111111111111111111111111111" },
      ],
    });
    const regData = parseResult(regResult) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // Evaluate (should approve — $500 < $10k cap)
    const evalResult = await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    const evalData = parseResult(evalResult) as Record<string, unknown>;
    expect(evalData["approved"]).toBe(true);

    // Score (only 1 eval, should be null)
    const scoreResult = handleScore(deps, { agent_id: agentId });
    const scoreData = parseResult(scoreResult) as Record<string, unknown>;
    expect(scoreData["score"]).toBeNull();
    expect(scoreData["total_evaluations"]).toBe(1);
  });

  it("evaluate should auto-pause agent after consecutive violations", async () => {
    const agent = registerTestAgent(db);
    // High-value simulator that always triggers max_usd_value violation
    const simulator = createMockSimulator({ estimated_usd_value: 15000 });
    const deps = makeDeps(db, simulator);

    // The default policy has auto_pause with threshold=3
    // Send 3 failing evaluations to trigger auto-pause
    for (let i = 0; i < 3; i++) {
      await handleEvaluate(deps, {
        agent_id: agent.id,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    // Agent should now be paused
    const agentRow = db
      .prepare("SELECT is_paused FROM agents WHERE id = ?")
      .get(agent.id) as { is_paused: number };
    expect(agentRow.is_paused).toBe(1);

    // Next evaluation should return AGENT_PAUSED
    const result = await handleEvaluate(deps, {
      agent_id: agent.id,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_PAUSED);
  });
});
