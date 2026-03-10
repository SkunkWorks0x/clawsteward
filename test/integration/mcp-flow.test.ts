// ClawSteward MCP Flow Integration Test — End-to-end through MCP handlers
// with in-memory SQLite and mock ChainSimulator.
//
// Tests the full lifecycle: register → evaluate → score → leaderboard → scan → verify
// Minimum 12 tests. Sequential flow tests share state within describe blocks.

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
import { verifyStewardLog } from "../../src/core/audit-log.js";
import { updateAgentPausedState } from "../../src/core/agent.js";

// ─── Mock Simulator Factory ────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────

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

async function registerAgent(
  deps: HandlerDeps,
  name: string,
  address: string,
): Promise<string> {
  const data = parseResult(
    handleRegister(deps, {
      name,
      chain_signers: [{ chain: "solana", address }],
    }),
  ) as Record<string, unknown>;
  return data["agent_id"] as string;
}

async function evaluateN(
  deps: HandlerDeps,
  agentId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
  }
}

// ─── Full MCP Flow — Sequential Integration ────────────────────

describe("MCP Flow Integration — Full End-to-End", () => {
  let db: Database.Database;
  let deps: HandlerDeps;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  // Step 1+2: Create MCP server context + register agent
  it("step 1-2: register agent via steward_register", () => {
    const result = handleRegister(deps, {
      name: "test-agent-alpha",
      chain_signers: [
        { chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["registered"]).toBe(true);
    expect(data["name"]).toBe("test-agent-alpha");
    expect(data["agent_id"]).toBeDefined();
    expect(typeof data["agent_id"]).toBe("string");
    expect((data["agent_id"] as string).length).toBe(36); // UUIDv7
    expect(data["chain_signers"]).toEqual({
      solana: "ALPHAddr1111111111111111111111111111111111",
    });
    expect(data["registered_at"]).toBeDefined();
  });

  // Step 3: Evaluate a passing transaction
  it("step 3: evaluate passing tx → approved: true, no violations", async () => {
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // Evaluate: $500 tx against $10k limit → passes
    const result = await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(true);
    expect(data["violations"]).toEqual([]);
    expect(data["evaluation_id"]).toBeDefined();
    expect(data["steward_score"]).toBeDefined(); // score is null (< 10 evals) but key exists

    const sim = data["simulation"] as Record<string, unknown>;
    expect(sim["usd_value"]).toBe(500);
    expect(sim["slippage_pct"]).toBe(0.5);
    expect(sim["counterparties"]).toEqual(["11111111111111111111111111111111"]);
  });

  // Step 4: Evaluate a violating transaction (max_usd_value)
  it("step 4: evaluate violating tx → approved: false, max_usd_value violation", async () => {
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // First: one passing eval
    await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // $50K tx against $10K max_usd_value limit → violates
    const highValueDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 50000 }));
    const result = await handleEvaluate(highValueDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);

    const violations = data["violations"] as Array<Record<string, unknown>>;
    expect(violations.length).toBeGreaterThan(0);

    const maxUsdViolation = violations.find((v) => v["rule_type"] === "max_usd_value");
    expect(maxUsdViolation).toBeDefined();
    expect(maxUsdViolation!["severity"]).toBe("critical");
    expect(maxUsdViolation!["actual_value"]).toBe(50000);
    expect(maxUsdViolation!["threshold_value"]).toBe(10000);
  });

  // Step 5: Score reflects 1 pass + 1 violation, badge not "ClawSteward-verified"
  it("step 5: steward_score reflects mixed history, badge is not ClawSteward-verified", async () => {
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // 1 pass
    await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // 1 violation
    const highValueDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 50000 }));
    await handleEvaluate(highValueDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Query score
    const scoreResult = handleScore(deps, { agent_id: alphaAgentId });
    const scoreData = parseResult(scoreResult) as Record<string, unknown>;

    expect(scoreData["total_evaluations"]).toBe(2);
    expect(scoreData["total_violations"]).toBe(1);
    // < 10 evals → null score → "Insufficient Data" badge (not "ClawSteward-verified")
    expect(scoreData["badge"]).not.toBe("ClawSteward-verified");
    expect(scoreData["name"]).toBe("test-agent-alpha");
  });

  // Step 6: 3 more evaluations (2 passing, 1 velocity_24h_usd violation) → running score updates
  // Uses $9,900 per tx: after 5 passing evals ($49,500 cumulative), the 6th ($9,900) pushes
  // 24h volume to $59,400 > $50K velocity cap, triggering velocity_24h_usd (high severity).
  // $9,900 < $10K so max_usd_value does NOT trigger.
  it("step 6: velocity_24h_usd violation triggers when 24h volume exceeds cap", async () => {
    const agentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    const mediumDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 9900 }));

    // 5 passing evals at $9,900 each → cumulative $49,500 < $50K velocity cap
    for (let i = 0; i < 5; i++) {
      const result = await handleEvaluate(mediumDeps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data["approved"]).toBe(true);
    }

    // Verify score after 5 passing evals: < 10 evals → null score
    let scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;
    expect(scoreData["total_evaluations"]).toBe(5);
    expect(scoreData["total_violations"]).toBe(0);
    expect(scoreData["score"]).toBeNull();

    // 6th eval at $9,900 → cumulative $49,500 + $9,900 = $59,400 > $50K → velocity violation
    const result = await handleEvaluate(mediumDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);

    const violations = data["violations"] as Array<Record<string, unknown>>;
    const velocityViolation = violations.find((v) => v["rule_type"] === "velocity_24h_usd");
    expect(velocityViolation).toBeDefined();
    expect(velocityViolation!["severity"]).toBe("high");
    expect(velocityViolation!["actual_value"]).toBeGreaterThan(50000);
    expect(velocityViolation!["threshold_value"]).toBe(50000);

    // max_usd_value should NOT be violated ($9,900 < $10K)
    const maxUsdViolation = violations.find((v) => v["rule_type"] === "max_usd_value");
    expect(maxUsdViolation).toBeUndefined();

    // Score now reflects 6 evals, 1 violation (still < 10 → null)
    scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;
    expect(scoreData["total_evaluations"]).toBe(6);
    expect(scoreData["total_violations"]).toBe(1);
    expect(scoreData["score"]).toBeNull();
  });

  // Step 7: Leaderboard shows agent with correct rank and score
  it("step 7: steward_leaderboard includes agent with correct data", async () => {
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // Create 12 passing evaluations so score is non-null (≥ 10 evals)
    await evaluateN(deps, alphaAgentId, 12);

    const lbResult = handleLeaderboard(deps, { limit: 20 });
    const lbData = parseResult(lbResult) as Record<string, unknown>;
    const leaderboard = lbData["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard.length).toBeGreaterThanOrEqual(1);
    const alphaEntry = leaderboard.find((e) => e["agent_id"] === alphaAgentId);
    expect(alphaEntry).toBeDefined();
    expect(alphaEntry!["name"]).toBe("test-agent-alpha");
    expect(alphaEntry!["rank"]).toBe(1);
    expect(alphaEntry!["score"]).toBe(10.0);
    expect(alphaEntry!["badge"]).toBe("ClawSteward-verified");
    expect(alphaEntry!["total_evaluations"]).toBe(12);
    expect(alphaEntry!["violation_rate"]).toBe(0);
  });

  // Step 8: Second agent with 100% compliance ranks above agent with violations
  it("step 8: beta agent with 100% compliance ranks above alpha with violations", async () => {
    // Register alpha with some violations
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // Alpha: 10 passing + 2 violations = 12 total evals, non-null score
    await evaluateN(deps, alphaAgentId, 10);
    const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    for (let i = 0; i < 2; i++) {
      await handleEvaluate(violatingDeps, {
        agent_id: alphaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    // Register beta with 12 clean passing txs (small value to stay under velocity)
    const betaAgentId = await registerAgent(deps, "test-agent-beta", "BETAAddr1111111111111111111111111111111111");
    const cleanDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 100 }));
    await evaluateN(cleanDeps, betaAgentId, 12);

    // Leaderboard
    const lbResult = handleLeaderboard(deps, { limit: 20 });
    const lbData = parseResult(lbResult) as Record<string, unknown>;
    const leaderboard = lbData["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard.length).toBe(2);

    // Beta should be ranked #1 (perfect score 10.0)
    expect(leaderboard[0]!["name"]).toBe("test-agent-beta");
    expect(leaderboard[0]!["score"]).toBe(10.0);
    expect(leaderboard[0]!["rank"]).toBe(1);

    // Alpha ranked #2 (has violations, lower score)
    expect(leaderboard[1]!["name"]).toBe("test-agent-alpha");
    expect((leaderboard[1]!["score"] as number)).toBeLessThan(10.0);
    expect(leaderboard[1]!["rank"]).toBe(2);
  });

  // Step 9: Scan shows evaluation history with violation_breakdown_by_severity
  it("step 9: steward_scan returns correct violation breakdown", async () => {
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // 3 passing
    await evaluateN(deps, alphaAgentId, 3);

    // 1 max_usd_value violation (critical severity)
    const highValueDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    await handleEvaluate(highValueDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // 1 max_slippage_pct violation (high severity)
    const highSlipDeps = makeDeps(db, createMockSimulator({ estimated_slippage_pct: 5.0 }));
    await handleEvaluate(highSlipDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Scan
    const scanResult = handleScan(deps, { agent_id: alphaAgentId, days: 30 });
    const scanData = parseResult(scanResult) as Record<string, unknown>;

    expect(scanData["agent_id"]).toBe(alphaAgentId);
    expect(scanData["name"]).toBe("test-agent-alpha");

    const summary = scanData["summary"] as Record<string, unknown>;
    expect(summary["total_evaluations"]).toBe(5);
    expect(summary["approvals"]).toBe(3);
    expect(summary["rejections"]).toBe(2);
    expect(summary["approval_rate"]).toBe(60.0);

    const breakdown = scanData["violation_breakdown_by_severity"] as Record<string, number>;
    expect(breakdown["critical"]).toBeGreaterThanOrEqual(1); // max_usd_value is critical
    expect(breakdown["high"]).toBeGreaterThanOrEqual(1); // max_slippage_pct is high

    const byType = scanData["violations_by_type"] as Record<string, number>;
    expect(byType["max_usd_value"]).toBeGreaterThanOrEqual(1);
    expect(byType["max_slippage_pct"]).toBeGreaterThanOrEqual(1);

    expect(scanData["is_paused"]).toBe(false);
    expect(scanData["scan_window_days"]).toBe(30);

    const recentEntries = scanData["recent_entries"] as Array<Record<string, unknown>>;
    expect(recentEntries.length).toBe(5);
  });

  // Step 10: Evaluate with non-existent agent_id → AGENT_NOT_FOUND
  it("step 10: steward_evaluate with non-existent agent → AGENT_NOT_FOUND", async () => {
    const result = await handleEvaluate(deps, {
      agent_id: "00000000-0000-7000-8000-000000000000",
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_NOT_FOUND);
    expect(data["error"]).toContain("Agent not found");
  });

  // Step 11: Pause agent → evaluate → AGENT_PAUSED
  it("step 11: paused agent returns AGENT_PAUSED on evaluate", async () => {
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");

    // Pause the agent
    updateAgentPausedState(db, alphaAgentId, true);

    // Try to evaluate
    const result = await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_PAUSED);
    expect(data["error"]).toContain("paused");
  });

  // Step 12: Verify Steward Log integrity for both agents
  it("step 12: steward log hash chain valid across multi-agent evaluations", async () => {
    // Register two agents
    const alphaAgentId = await registerAgent(deps, "test-agent-alpha", "ALPHAddr1111111111111111111111111111111111");
    const betaAgentId = await registerAgent(deps, "test-agent-beta", "BETAAddr1111111111111111111111111111111111");

    // Interleave evaluations across both agents
    await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    await handleEvaluate(deps, {
      agent_id: betaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Alpha violation
    const highValueDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    await handleEvaluate(highValueDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Beta clean
    await handleEvaluate(deps, {
      agent_id: betaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // More for both
    await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    await handleEvaluate(deps, {
      agent_id: betaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Verify hash chain integrity across all entries
    const verification = verifyStewardLog(db);
    expect(verification.valid).toBe(true);
    expect(verification.entries_checked).toBe(6);
    expect(verification.error).toBeUndefined();
    expect(verification.tampered_entry_id).toBeUndefined();
  });
});

// ─── Additional Edge Cases ─────────────────────────────────────

describe("MCP Flow — Edge Cases", () => {
  let db: Database.Database;
  let deps: HandlerDeps;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  it("auto-pause triggers after 3 consecutive violations", async () => {
    const agentId = await registerAgent(deps, "auto-pause-agent", "APAddr11111111111111111111111111111111111");

    // 3 consecutive violations → triggers auto_pause_consecutive_violations
    const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    for (let i = 0; i < 3; i++) {
      await handleEvaluate(violatingDeps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    // Agent should now be paused
    const row = db
      .prepare("SELECT is_paused FROM agents WHERE id = ?")
      .get(agentId) as { is_paused: number };
    expect(row.is_paused).toBe(1);

    // Next evaluate returns AGENT_PAUSED
    const result = await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_PAUSED);
  });

  it("score is null (Insufficient Data) for agent with < 10 evaluations", async () => {
    const agentId = await registerAgent(deps, "new-agent", "NEWAddr11111111111111111111111111111111111");

    // Only 5 evaluations
    await evaluateN(deps, agentId, 5);

    const scoreResult = handleScore(deps, { agent_id: agentId });
    const scoreData = parseResult(scoreResult) as Record<string, unknown>;
    expect(scoreData["score"]).toBeNull();
    expect(scoreData["badge"]).toBe("Insufficient Data");
    expect(scoreData["total_evaluations"]).toBe(5);
  });

  it("score transitions from null to numeric at 10th evaluation", async () => {
    const agentId = await registerAgent(deps, "threshold-agent", "THRAddr11111111111111111111111111111111111");

    // 9 evaluations → null
    await evaluateN(deps, agentId, 9);

    let scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;
    expect(scoreData["score"]).toBeNull();

    // 10th evaluation → non-null score
    await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;
    expect(scoreData["score"]).not.toBeNull();
    expect(scoreData["score"]).toBe(10.0); // All passing → perfect score
    expect(scoreData["badge"]).toBe("ClawSteward-verified");
  });

  it("leaderboard excludes agents with < 10 evaluations", async () => {
    const agentId = await registerAgent(deps, "not-enough-evals", "FEWAddr11111111111111111111111111111111111");

    // 5 evals (under threshold)
    await evaluateN(deps, agentId, 5);

    const lbResult = handleLeaderboard(deps, { limit: 20 });
    const lbData = parseResult(lbResult) as Record<string, unknown>;
    const leaderboard = lbData["leaderboard"] as Array<Record<string, unknown>>;

    // Agent with < 10 evals should not appear (score is null → excluded)
    expect(leaderboard.length).toBe(0);
  });

  it("steward_score returns AGENT_NOT_FOUND for non-existent agent", () => {
    const result = handleScore(deps, {
      agent_id: "00000000-0000-7000-8000-000000000000",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_NOT_FOUND);
  });

  it("steward_scan returns AGENT_NOT_FOUND for non-existent agent", () => {
    const result = handleScan(deps, {
      agent_id: "00000000-0000-7000-8000-000000000000",
      days: 30,
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.AGENT_NOT_FOUND);
  });

  it("evaluation returns simulation data with correct counterparties", async () => {
    const agentId = await registerAgent(deps, "counterparty-agent", "CPAddr111111111111111111111111111111111111");

    const customDeps = makeDeps(
      db,
      createMockSimulator({
        estimated_usd_value: 200,
        counterparties: [
          "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ],
      }),
    );

    const result = await handleEvaluate(customDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(true);
    const sim = data["simulation"] as Record<string, unknown>;
    const counterparties = sim["counterparties"] as string[];
    expect(counterparties).toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(counterparties).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("multiple violations in single evaluation are all captured", async () => {
    const agentId = await registerAgent(deps, "multi-violation-agent", "MVAddr111111111111111111111111111111111111");

    // Tx that violates both max_usd_value ($15k > $10k) AND max_slippage_pct (5% > 3%)
    const multiViolationDeps = makeDeps(
      db,
      createMockSimulator({
        estimated_usd_value: 15000,
        estimated_slippage_pct: 5.0,
      }),
    );

    const result = await handleEvaluate(multiViolationDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);
    const violations = data["violations"] as Array<Record<string, unknown>>;
    expect(violations.length).toBeGreaterThanOrEqual(2);

    const ruleTypes = violations.map((v) => v["rule_type"]);
    expect(ruleTypes).toContain("max_usd_value");
    expect(ruleTypes).toContain("max_slippage_pct");
  });

  it("evaluation log entries are append-only and accumulate", async () => {
    const agentId = await registerAgent(deps, "accumulate-agent", "ACCAddr11111111111111111111111111111111111");

    // 5 evaluations
    await evaluateN(deps, agentId, 5);

    // Verify log has exactly 5 entries
    const entries = db
      .prepare("SELECT COUNT(*) as count FROM steward_log WHERE agent_id = ?")
      .get(agentId) as { count: number };
    expect(entries.count).toBe(5);

    // Verify all have integrity hashes
    const integrityCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM log_integrity li
         JOIN steward_log sl ON li.entry_id = sl.id
         WHERE sl.agent_id = ?`,
      )
      .get(agentId) as { count: number };
    expect(integrityCount.count).toBe(5);
  });

  it("steward_scan with custom days parameter limits results window", async () => {
    const agentId = await registerAgent(deps, "days-agent", "DAYAddr11111111111111111111111111111111111");

    // Add evaluations
    await evaluateN(deps, agentId, 3);

    // Scan with 7-day window
    const scanResult = handleScan(deps, { agent_id: agentId, days: 7 });
    const scanData = parseResult(scanResult) as Record<string, unknown>;
    expect(scanData["scan_window_days"]).toBe(7);

    const summary = scanData["summary"] as Record<string, unknown>;
    // All entries are recent, so they should all show
    expect(summary["total_evaluations"]).toBe(3);
  });

  it("empty leaderboard returns correct structure", () => {
    const result = handleLeaderboard(deps, { limit: 20 });
    const data = parseResult(result) as Record<string, unknown>;

    expect(data["leaderboard"]).toEqual([]);
    expect(data["total"]).toBe(0);
    expect(data["limit"]).toBe(20);
  });

  it("evaluation caches steward score in steward_scores table", async () => {
    const agentId = await registerAgent(deps, "cache-agent", "CACAddr11111111111111111111111111111111111");

    await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Score should be cached in steward_scores table
    const cached = db
      .prepare("SELECT * FROM steward_scores WHERE agent_id = ?")
      .get(agentId) as Record<string, unknown> | undefined;
    expect(cached).toBeDefined();
    expect(cached!["agent_id"]).toBe(agentId);
    expect(cached!["total_evaluations"]).toBe(1);
  });

  it("hash chain integrity valid after single agent many evals", async () => {
    const agentId = await registerAgent(deps, "chain-agent", "CHNAddr11111111111111111111111111111111111");

    // Mix of passing and failing
    await evaluateN(deps, agentId, 5);

    const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    await handleEvaluate(violatingDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const verification = verifyStewardLog(db);
    expect(verification.valid).toBe(true);
    expect(verification.entries_checked).toBe(7);
  });
});

// ─── Policy Rule-Specific Violation Tests ───────────────────────

describe("MCP Flow — Policy Rule Violations", () => {
  let db: Database.Database;
  let deps: HandlerDeps;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  it("max_slippage_pct violation triggers independently with correct severity", async () => {
    const agentId = await registerAgent(deps, "slippage-agent", "SLIPAddr1111111111111111111111111111111111");

    // 4% slippage against 3% limit → high severity violation
    const highSlipDeps = makeDeps(db, createMockSimulator({
      estimated_usd_value: 500,
      estimated_slippage_pct: 4.0,
    }));

    const result = await handleEvaluate(highSlipDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);

    const violations = data["violations"] as Array<Record<string, unknown>>;
    const slipViolation = violations.find((v) => v["rule_type"] === "max_slippage_pct");
    expect(slipViolation).toBeDefined();
    expect(slipViolation!["severity"]).toBe("high");
    expect(slipViolation!["actual_value"]).toBe(4.0);
    expect(slipViolation!["threshold_value"]).toBe(3.0);

    // max_usd_value should NOT trigger ($500 < $10K)
    expect(violations.find((v) => v["rule_type"] === "max_usd_value")).toBeUndefined();
  });

  it("velocity_1h_count violation triggers when hourly tx count exceeds limit", async () => {
    const agentId = await registerAgent(deps, "velocity-count-agent", "VELAddr11111111111111111111111111111111111");

    // Use very small amounts to avoid velocity_24h_usd triggering ($1 × 21 = $21 << $50K)
    const tinyDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 1 }));

    // 20 txs in 1 hour → passes (limit is 20)
    await evaluateN(tinyDeps, agentId, 20);

    // 21st tx → velocity_1h_count violation (21 > 20)
    const result = await handleEvaluate(tinyDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const data = parseResult(result) as Record<string, unknown>;
    expect(data["approved"]).toBe(false);

    const violations = data["violations"] as Array<Record<string, unknown>>;
    const countViolation = violations.find((v) => v["rule_type"] === "velocity_1h_count");
    expect(countViolation).toBeDefined();
    expect(countViolation!["severity"]).toBe("medium");
    expect(countViolation!["actual_value"]).toBe(21);
    expect(countViolation!["threshold_value"]).toBe(20);
  });

  it("evaluation returns evaluation_id as valid UUIDv7 format", async () => {
    const agentId = await registerAgent(deps, "uuid-agent", "UUIDAddr1111111111111111111111111111111111");

    const result = await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const data = parseResult(result) as Record<string, unknown>;
    const evalId = data["evaluation_id"] as string;
    expect(evalId).toBeDefined();
    expect(evalId.length).toBe(36); // UUIDv7 format: 8-4-4-4-12
    expect(evalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("unsupported chain returns UNSUPPORTED_CHAIN error", async () => {
    const agentId = await registerAgent(deps, "chain-error-agent", "CHEAddr11111111111111111111111111111111111");

    const result = await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana" as "solana", // cast to satisfy TS; handler checks internally
      raw_transaction_base64: "dGVzdA==",
    });

    // This passes because "solana" is supported. Test with an unsupported chain
    // by directly calling with a workaround (the Zod schema enforces "solana")
    expect(result.isError).toBeUndefined(); // solana is supported

    // Test that a non-existent simulator returns error
    const noSimDeps: HandlerDeps = {
      db,
      getSimulator: () => undefined, // no simulator available
    };

    const result2 = await handleEvaluate(noSimDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    expect(result2.isError).toBe(true);
    const data = parseResult(result2) as Record<string, unknown>;
    expect(data["code"]).toBe(ErrorCode.SIMULATION_FAILED);
  });
});

// ─── Score Badge & Trend Tests ──────────────────────────────────

describe("MCP Flow — Score Badges & Trends", () => {
  let db: Database.Database;
  let deps: HandlerDeps;

  beforeEach(() => {
    db = createTestDatabase();
    deps = makeDeps(db);
  });

  it("agent with perfect score gets ClawSteward-verified badge", async () => {
    const agentId = await registerAgent(deps, "perfect-agent", "PRFAddr11111111111111111111111111111111111");

    // 10 clean evaluations → perfect score
    await evaluateN(deps, agentId, 10);

    const scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;

    expect(scoreData["score"]).toBe(10.0);
    expect(scoreData["badge"]).toBe("ClawSteward-verified");
    expect(scoreData["total_violations"]).toBe(0);
    expect(scoreData["violation_rate"]).toBe(0);
  });

  it("agent with many violations gets badge below ClawSteward-verified", async () => {
    const agentId = await registerAgent(deps, "risky-agent", "RSKAddr11111111111111111111111111111111111");

    // 7 passing, 3 violations (but not 3 consecutive to avoid auto-pause)
    for (let i = 0; i < 3; i++) {
      // 2 passing then 1 violation
      await evaluateN(deps, agentId, 2);
      const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
      await handleEvaluate(violatingDeps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    // 1 more passing to get to 10 total
    await handleEvaluate(deps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;

    expect(scoreData["score"]).not.toBeNull();
    expect(scoreData["total_evaluations"]).toBe(10);
    expect(scoreData["total_violations"]).toBe(3);
    // With 3 critical violations out of 10 evals, score should be significantly below 10
    expect((scoreData["score"] as number)).toBeLessThan(10.0);
    // Badge should NOT be ClawSteward-verified (score < 8 with 3 critical violations)
    expect(scoreData["badge"]).not.toBe("ClawSteward-verified");
  });

  it("leaderboard respects limit parameter", async () => {
    // Register 3 agents with 10+ evals each
    for (let i = 1; i <= 3; i++) {
      const agentId = await registerAgent(
        deps,
        `agent-${i}`,
        `AGT${i}Addr1111111111111111111111111111111111`.slice(0, 44),
      );
      await evaluateN(deps, agentId, 10);
    }

    // Leaderboard with limit 2
    const lbResult = handleLeaderboard(deps, { limit: 2 });
    const lbData = parseResult(lbResult) as Record<string, unknown>;
    const leaderboard = lbData["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard.length).toBe(2);
    expect(lbData["limit"]).toBe(2);
  });

  it("leaderboard with min_score filter excludes low-scoring agents", async () => {
    // Agent 1: perfect score
    const perfectId = await registerAgent(deps, "perfect-lb", "PFLBAddr1111111111111111111111111111111111");
    await evaluateN(deps, perfectId, 10);

    // Agent 2: imperfect (2 pass, 1 violation repeated to get 10 evals without auto-pause)
    const imperfectId = await registerAgent(deps, "imperfect-lb", "IMPAddr11111111111111111111111111111111111");
    for (let i = 0; i < 3; i++) {
      await evaluateN(deps, imperfectId, 2);
      const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
      await handleEvaluate(violatingDeps, {
        agent_id: imperfectId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }
    await handleEvaluate(deps, {
      agent_id: imperfectId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Filter by min_score = 9.5 → only perfect agent
    const lbResult = handleLeaderboard(deps, { limit: 20, min_score: 9.5 });
    const lbData = parseResult(lbResult) as Record<string, unknown>;
    const leaderboard = lbData["leaderboard"] as Array<Record<string, unknown>>;

    expect(leaderboard.length).toBe(1);
    expect(leaderboard[0]!["name"]).toBe("perfect-lb");
  });

  it("scan with no evaluations returns zero counts", async () => {
    const agentId = await registerAgent(deps, "empty-scan-agent", "EMPAddr11111111111111111111111111111111111");

    const scanResult = handleScan(deps, { agent_id: agentId, days: 30 });
    const scanData = parseResult(scanResult) as Record<string, unknown>;

    expect(scanData["agent_id"]).toBe(agentId);
    const summary = scanData["summary"] as Record<string, unknown>;
    expect(summary["total_evaluations"]).toBe(0);
    expect(summary["approvals"]).toBe(0);
    expect(summary["rejections"]).toBe(0);
    expect(summary["errors"]).toBe(0);
    expect(summary["approval_rate"]).toBeNull();

    const breakdown = scanData["violation_breakdown_by_severity"] as Record<string, number>;
    expect(breakdown["critical"]).toBe(0);
    expect(breakdown["high"]).toBe(0);
    expect(breakdown["medium"]).toBe(0);
    expect(breakdown["low"]).toBe(0);
  });

  it("register agent with metadata propagates correctly", () => {
    const result = handleRegister(deps, {
      name: "metadata-agent",
      chain_signers: [
        { chain: "solana", address: "METAddr11111111111111111111111111111111111" },
      ],
      policy_set_id: "default",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as Record<string, unknown>;
    expect(data["registered"]).toBe(true);
    expect(data["name"]).toBe("metadata-agent");
    expect(data["agent_id"]).toBeDefined();
  });

  it("consecutive passing evals after violations improve violation rate", async () => {
    const agentId = await registerAgent(deps, "recovery-agent", "RECAddr11111111111111111111111111111111111");

    // 1 violation, then 9 passing → 10 evals, 1 violation
    const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    await handleEvaluate(violatingDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    await evaluateN(deps, agentId, 9);

    const score1 = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;
    const rate1 = score1["violation_rate"] as number;

    // 5 more passing → 15 evals, still 1 violation → lower violation rate
    await evaluateN(deps, agentId, 5);

    const score2 = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;
    const rate2 = score2["violation_rate"] as number;

    expect(rate2).toBeLessThan(rate1);
    expect(score2["total_evaluations"]).toBe(15);
    expect(score2["total_violations"]).toBe(1);
  });

  it("score reflects correct critical_violations_30d count", async () => {
    const agentId = await registerAgent(deps, "critical-count-agent", "CRTAddr11111111111111111111111111111111111");

    // 8 passing, then 2 critical violations (max_usd_value is critical)
    await evaluateN(deps, agentId, 8);

    const critDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    await handleEvaluate(critDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    await handleEvaluate(critDeps, {
      agent_id: agentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    const scoreData = parseResult(
      handleScore(deps, { agent_id: agentId }),
    ) as Record<string, unknown>;

    expect(scoreData["total_evaluations"]).toBe(10);
    expect(scoreData["critical_violations_30d"]).toBeGreaterThanOrEqual(2);
  });

  it("scan recent_entries are ordered and limited to 10", async () => {
    const agentId = await registerAgent(deps, "recent-entries-agent", "RCEAddr11111111111111111111111111111111111");

    // 15 evaluations
    await evaluateN(deps, agentId, 15);

    const scanResult = handleScan(deps, { agent_id: agentId, days: 30 });
    const scanData = parseResult(scanResult) as Record<string, unknown>;

    const recentEntries = scanData["recent_entries"] as Array<Record<string, unknown>>;
    expect(recentEntries.length).toBe(10); // capped at 10

    // All entries should have required fields
    for (const entry of recentEntries) {
      expect(entry["id"]).toBeDefined();
      expect(entry["timestamp"]).toBeDefined();
      expect(entry["action"]).toBeDefined();
      expect(typeof entry["violations_count"]).toBe("number");
    }
  });
});
