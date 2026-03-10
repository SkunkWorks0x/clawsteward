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

// ─── Full MCP Flow — Sequential Integration ────────────────────

describe("MCP Flow Integration — Full End-to-End", () => {
  let db: Database.Database;
  let deps: HandlerDeps;
  let alphaAgentId: string;
  let betaAgentId: string;

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
    // Register
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

    // First: one passing eval
    await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Now: $50K tx against $10K limit → violates max_usd_value
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
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

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

  // Step 6: 3 more evaluations (2 passing, 1 max_usd_value violation) → running score updates
  it("step 6: multiple evaluations update running score correctly", async () => {
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

    // 1 pass, 1 violation
    await handleEvaluate(deps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });
    const highValueDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    await handleEvaluate(highValueDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // 2 more passing
    for (let i = 0; i < 2; i++) {
      await handleEvaluate(deps, {
        agent_id: alphaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    // Score after 4 evals: < 10 → null
    let scoreData = parseResult(
      handleScore(deps, { agent_id: alphaAgentId }),
    ) as Record<string, unknown>;
    expect(scoreData["total_evaluations"]).toBe(4);
    expect(scoreData["total_violations"]).toBe(1);
    expect(scoreData["score"]).toBeNull(); // < 10 evals

    // 1 more max_usd_value violation
    await handleEvaluate(highValueDeps, {
      agent_id: alphaAgentId,
      chain: "solana",
      raw_transaction_base64: "dGVzdA==",
    });

    // Score after 5 evals: still < 10 → null, but violations = 2
    scoreData = parseResult(
      handleScore(deps, { agent_id: alphaAgentId }),
    ) as Record<string, unknown>;
    expect(scoreData["total_evaluations"]).toBe(5);
    expect(scoreData["total_violations"]).toBe(2);
    expect(scoreData["score"]).toBeNull(); // still < 10 evals
  });

  // Step 7: Leaderboard shows agent with correct rank and score
  it("step 7: steward_leaderboard includes agent with correct data", async () => {
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

    // Create 12 passing evaluations so score is non-null
    for (let i = 0; i < 12; i++) {
      await handleEvaluate(deps, {
        agent_id: alphaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regAlpha = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regAlpha["agent_id"] as string;

    // Alpha: 10 passing + 2 violations = 12 total evals, non-null score
    for (let i = 0; i < 10; i++) {
      await handleEvaluate(deps, {
        agent_id: alphaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }
    const violatingDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 15000 }));
    for (let i = 0; i < 2; i++) {
      await handleEvaluate(violatingDeps, {
        agent_id: alphaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    // Register beta
    const regBeta = parseResult(
      handleRegister(deps, {
        name: "test-agent-beta",
        chain_signers: [{ chain: "solana", address: "BETAAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    betaAgentId = regBeta["agent_id"] as string;

    // Beta: 12 clean passing txs (use a fresh simulator to avoid velocity issues)
    const cleanDeps = makeDeps(db, createMockSimulator({ estimated_usd_value: 100 }));
    for (let i = 0; i < 12; i++) {
      await handleEvaluate(cleanDeps, {
        agent_id: betaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

    // 3 passing
    for (let i = 0; i < 3; i++) {
      await handleEvaluate(deps, {
        agent_id: alphaAgentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regData["agent_id"] as string;

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
    const regAlpha = parseResult(
      handleRegister(deps, {
        name: "test-agent-alpha",
        chain_signers: [{ chain: "solana", address: "ALPHAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    alphaAgentId = regAlpha["agent_id"] as string;

    const regBeta = parseResult(
      handleRegister(deps, {
        name: "test-agent-beta",
        chain_signers: [{ chain: "solana", address: "BETAAddr1111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    betaAgentId = regBeta["agent_id"] as string;

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "auto-pause-agent",
        chain_signers: [{ chain: "solana", address: "APAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "new-agent",
        chain_signers: [{ chain: "solana", address: "NEWAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // Only 5 evaluations
    for (let i = 0; i < 5; i++) {
      await handleEvaluate(deps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

    const scoreResult = handleScore(deps, { agent_id: agentId });
    const scoreData = parseResult(scoreResult) as Record<string, unknown>;
    expect(scoreData["score"]).toBeNull();
    expect(scoreData["badge"]).toBe("Insufficient Data");
    expect(scoreData["total_evaluations"]).toBe(5);
  });

  it("score transitions from null to numeric at 10th evaluation", async () => {
    const regData = parseResult(
      handleRegister(deps, {
        name: "threshold-agent",
        chain_signers: [{ chain: "solana", address: "THRAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // 9 evaluations → null
    for (let i = 0; i < 9; i++) {
      await handleEvaluate(deps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "not-enough-evals",
        chain_signers: [{ chain: "solana", address: "FEWAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // 5 evals (under threshold)
    for (let i = 0; i < 5; i++) {
      await handleEvaluate(deps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "counterparty-agent",
        chain_signers: [{ chain: "solana", address: "CPAddr111111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "multi-violation-agent",
        chain_signers: [{ chain: "solana", address: "MVAddr111111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "accumulate-agent",
        chain_signers: [{ chain: "solana", address: "ACCAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // 5 evaluations
    for (let i = 0; i < 5; i++) {
      await handleEvaluate(deps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "days-agent",
        chain_signers: [{ chain: "solana", address: "DAYAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // Add evaluations
    for (let i = 0; i < 3; i++) {
      await handleEvaluate(deps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "cache-agent",
        chain_signers: [{ chain: "solana", address: "CACAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

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
    const regData = parseResult(
      handleRegister(deps, {
        name: "chain-agent",
        chain_signers: [{ chain: "solana", address: "CHNAddr11111111111111111111111111111111111" }],
      }),
    ) as Record<string, unknown>;
    const agentId = regData["agent_id"] as string;

    // Mix of passing and failing
    for (let i = 0; i < 5; i++) {
      await handleEvaluate(deps, {
        agent_id: agentId,
        chain: "solana",
        raw_transaction_base64: "dGVzdA==",
      });
    }

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
