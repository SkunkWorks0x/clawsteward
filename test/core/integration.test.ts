// ClawSteward Integration Test — Full core flow end-to-end
// Register agent → create policy set → simulate (mock) → evaluate policy →
// append to Steward Log → compute Steward Score
//
// This is the Week 1 gate: all core modules connected.

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../../src/db/database.js";
import {
  registerAgent,
  getAgent,
  getAgentBySignerAddress,
  updateAgentPausedState,
} from "../../src/core/agent.js";
import { evaluatePolicy, parsePolicySet } from "../../src/core/policy-engine.js";
import { appendToStewardLog, verifyStewardLog } from "../../src/core/audit-log.js";
import { computeStewardScore } from "../../src/core/reputation.js";
import { getPolicySet, getLogEntriesByAgent, upsertStewardScore } from "../../src/db/queries.js";
import type { SimulationResult, PolicySet } from "../../src/core/types.js";
import type { RuleContext } from "../../src/core/policy-rules.js";

// ─── Helpers ─────────────────────────────────────────────────────

function makeSimulation(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    success: true,
    chain: "solana",
    estimated_usd_value: 500,
    estimated_slippage_pct: 0.5,
    counterparties: ["11111111111111111111111111111111"],
    assets_affected: [
      { asset: "So11111111111111111111111111111111111111112", symbol: "SOL", delta: -1, usd_value: 500 },
      { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", delta: 500, usd_value: 500 },
    ],
    raw_chain_payload: { mock: true },
    simulation_timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    volume_24h_usd: 0,
    tx_count_1h: 0,
    consecutive_violations: 0,
    portfolio_positions: {},
    agent_paused: false,
    ...overrides,
  };
}

const TEST_POLICY: PolicySet = parsePolicySet({
  id: "test-policy",
  name: "Test Policy",
  version: 1,
  rules: [
    { id: "r1", type: "max_usd_value", params: { max: 10000 }, severity: "critical", enabled: true },
    { id: "r2", type: "max_slippage_pct", params: { max: 3.0 }, severity: "high", enabled: true },
    { id: "r3", type: "velocity_24h_usd", params: { max: 50000 }, severity: "high", enabled: true },
    { id: "r4", type: "velocity_1h_count", params: { max: 20 }, severity: "medium", enabled: true },
  ],
});

// ─── Tests ───────────────────────────────────────────────────────

describe("Core Integration — Full Flow", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("register agent → evaluate compliant tx → log → score (full pipeline)", () => {
    // 1. Register agent
    const agent = registerAgent(db, {
      name: "IntegrationBot",
      chain: "solana",
      signer_address: "TestPubkey111111111111111111111111111111111",
    });
    expect(agent.id).toHaveLength(36);
    expect(agent.is_paused).toBe(false);

    // 2. Verify agent persisted
    const fetched = getAgent(db, agent.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("IntegrationBot");
    expect(fetched!.chain_signers["solana"]).toBe("TestPubkey111111111111111111111111111111111");

    // 3. Mock simulation (compliant tx)
    const simulation = makeSimulation({ estimated_usd_value: 500, estimated_slippage_pct: 0.5 });

    // 4. Evaluate policy
    const evaluation = evaluatePolicy(TEST_POLICY, simulation, makeRuleContext());
    expect(evaluation.passed).toBe(true);
    expect(evaluation.violations).toHaveLength(0);
    expect(evaluation.rules_evaluated).toBe(4);

    // 5. Append to Steward Log
    const logEntry = appendToStewardLog(db, {
      agent_id: agent.id,
      chain: "solana",
      action: evaluation.passed ? "approve" : "reject",
      policy_set_id: TEST_POLICY.id,
      rules_evaluated: evaluation.rules_evaluated,
      violations: evaluation.violations,
      compliance_score_delta: 0,
      estimated_usd_value: simulation.estimated_usd_value,
      estimated_slippage_pct: simulation.estimated_slippage_pct,
      counterparties: simulation.counterparties,
      chain_payload: simulation.raw_chain_payload,
    });
    expect(logEntry.action).toBe("approve");
    expect(logEntry.id).toHaveLength(36);

    // 6. Verify log integrity
    const verification = verifyStewardLog(db);
    expect(verification.valid).toBe(true);
    expect(verification.entries_checked).toBe(1);

    // 7. Compute Steward Score (< 10 evals → null score)
    const score = computeStewardScore(db, agent.id);
    expect(score.agent_id).toBe(agent.id);
    expect(score.score).toBeNull(); // insufficient data
    expect(score.total_evaluations).toBe(1);
    expect(score.total_violations).toBe(0);
  });

  it("register agent → evaluate violating tx → log rejection → verify integrity", () => {
    const agent = registerAgent(db, {
      name: "BadBot",
      chain: "solana",
      signer_address: "BadPubkey1111111111111111111111111111111111",
    });

    // Simulation that exceeds max_usd_value
    const simulation = makeSimulation({ estimated_usd_value: 50000 });
    const evaluation = evaluatePolicy(TEST_POLICY, simulation, makeRuleContext());

    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations.length).toBeGreaterThan(0);
    expect(evaluation.violations[0]!.rule_type).toBe("max_usd_value");

    // Log the rejection
    const logEntry = appendToStewardLog(db, {
      agent_id: agent.id,
      chain: "solana",
      action: "reject",
      policy_set_id: TEST_POLICY.id,
      rules_evaluated: evaluation.rules_evaluated,
      violations: evaluation.violations,
      compliance_score_delta: -1,
      estimated_usd_value: simulation.estimated_usd_value,
      estimated_slippage_pct: simulation.estimated_slippage_pct,
      counterparties: simulation.counterparties,
    });

    expect(logEntry.action).toBe("reject");
    expect(logEntry.violations.length).toBeGreaterThan(0);

    // Verify log integrity
    const verification = verifyStewardLog(db);
    expect(verification.valid).toBe(true);
  });

  it("10+ evaluations produce a non-null Steward Score", () => {
    const agent = registerAgent(db, {
      name: "ScoreBot",
      chain: "solana",
      signer_address: "ScorePubkey11111111111111111111111111111111",
    });

    const now = new Date("2026-03-09T12:00:00Z");

    // Create 12 compliant evaluations
    for (let i = 0; i < 12; i++) {
      const sim = makeSimulation({ estimated_usd_value: 100 + i });
      const evaluation = evaluatePolicy(TEST_POLICY, sim, makeRuleContext());
      expect(evaluation.passed).toBe(true);

      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: "approve",
        policy_set_id: TEST_POLICY.id,
        rules_evaluated: evaluation.rules_evaluated,
        violations: [],
        compliance_score_delta: 0,
        estimated_usd_value: sim.estimated_usd_value,
        estimated_slippage_pct: sim.estimated_slippage_pct,
        counterparties: sim.counterparties,
      });
    }

    const score = computeStewardScore(db, agent.id, now);
    expect(score.score).toBe(10.0); // Perfect score — zero violations
    expect(score.total_evaluations).toBe(12);
    expect(score.total_violations).toBe(0);
    expect(score.violation_rate).toBe(0);
  });

  it("mixed approvals and rejections produce correct intermediate score", () => {
    const agent = registerAgent(db, {
      name: "MixedBot",
      chain: "solana",
      signer_address: "MixedPubkey1111111111111111111111111111111",
    });

    const now = new Date("2026-03-09T12:00:00Z");

    // 8 compliant txs
    for (let i = 0; i < 8; i++) {
      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: "approve",
        policy_set_id: TEST_POLICY.id,
        rules_evaluated: 4,
        violations: [],
        compliance_score_delta: 0,
        estimated_usd_value: 500,
        estimated_slippage_pct: 0.5,
        counterparties: [],
      });
    }

    // 4 violations (high severity)
    for (let i = 0; i < 4; i++) {
      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: "reject",
        policy_set_id: TEST_POLICY.id,
        rules_evaluated: 4,
        violations: [
          {
            rule_id: "r2",
            rule_type: "max_slippage_pct",
            severity: "high",
            message: "Slippage exceeds 3%",
            actual_value: 5.0,
            threshold_value: 3.0,
          },
        ],
        compliance_score_delta: -0.6,
        estimated_usd_value: 1000,
        estimated_slippage_pct: 5.0,
        counterparties: [],
      });
    }

    const score = computeStewardScore(db, agent.id, now);
    expect(score.score).not.toBeNull();
    expect(score.score!).toBeGreaterThan(0);
    expect(score.score!).toBeLessThan(10);
    expect(score.total_evaluations).toBe(12);
    expect(score.total_violations).toBe(4);
    expect(score.violation_rate).toBeCloseTo(4 / 12);
  });

  it("hash chain remains valid across multiple evaluations", () => {
    const agent = registerAgent(db, {
      name: "ChainBot",
      chain: "solana",
      signer_address: "ChainPubkey1111111111111111111111111111111",
    });

    // Mix of approvals and rejections
    for (let i = 0; i < 5; i++) {
      const isViolation = i % 3 === 0;
      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: isViolation ? "reject" : "approve",
        policy_set_id: TEST_POLICY.id,
        rules_evaluated: 4,
        violations: isViolation
          ? [{ rule_id: "r1", rule_type: "max_usd_value", severity: "critical", message: "Over limit", actual_value: 15000, threshold_value: 10000 }]
          : [],
        compliance_score_delta: isViolation ? -1 : 0,
        estimated_usd_value: isViolation ? 15000 : 500,
        estimated_slippage_pct: 0.5,
        counterparties: [],
      });
    }

    const verification = verifyStewardLog(db);
    expect(verification.valid).toBe(true);
    expect(verification.entries_checked).toBe(5);
  });

  it("default policy set loads from schema", () => {
    const defaultPolicy = getPolicySet(db, "default");
    expect(defaultPolicy).toBeDefined();
    expect(defaultPolicy!.name).toBe("Default Steward Policy");
    expect(defaultPolicy!.rules.length).toBe(5);

    // Verify it can be used for evaluation
    const sim = makeSimulation({ estimated_usd_value: 500 });
    const parsed = parsePolicySet(defaultPolicy!);
    const evaluation = evaluatePolicy(parsed, sim, makeRuleContext());
    expect(evaluation.passed).toBe(true);
  });
});

describe("Agent Database Operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  it("registerAgent persists and returns agent with ID", () => {
    const agent = registerAgent(db, {
      name: "DBAgent",
      chain: "solana",
      signer_address: "DBPubkey111111111111111111111111111111111111",
    });

    expect(agent.id).toHaveLength(36);

    const fetched = getAgent(db, agent.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(agent.id);
    expect(fetched!.name).toBe("DBAgent");
  });

  it("getAgent returns undefined for non-existent ID", () => {
    const result = getAgent(db, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeUndefined();
  });

  it("getAgentBySignerAddress finds agent by chain + address", () => {
    const pubkey = "FindMePubkey111111111111111111111111111111";
    registerAgent(db, {
      name: "FindableAgent",
      chain: "solana",
      signer_address: pubkey,
    });

    const found = getAgentBySignerAddress(db, "solana", pubkey);
    expect(found).toBeDefined();
    expect(found!.name).toBe("FindableAgent");
    expect(found!.chain_signers["solana"]).toBe(pubkey);
  });

  it("getAgentBySignerAddress returns undefined for wrong chain", () => {
    registerAgent(db, {
      name: "SolOnly",
      chain: "solana",
      signer_address: "SolPubkey1111111111111111111111111111111111",
    });

    const found = getAgentBySignerAddress(db, "ethereum", "SolPubkey1111111111111111111111111111111111");
    expect(found).toBeUndefined();
  });

  it("getAgentBySignerAddress returns undefined for unknown address", () => {
    const found = getAgentBySignerAddress(db, "solana", "NonExistent11111111111111111111111111111");
    expect(found).toBeUndefined();
  });

  it("updateAgentPausedState pauses and unpauses agent", () => {
    const agent = registerAgent(db, {
      name: "PausableAgent",
      chain: "solana",
      signer_address: "PausePubkey111111111111111111111111111111111",
    });

    expect(getAgent(db, agent.id)!.is_paused).toBe(false);

    updateAgentPausedState(db, agent.id, true);
    expect(getAgent(db, agent.id)!.is_paused).toBe(true);

    updateAgentPausedState(db, agent.id, false);
    expect(getAgent(db, agent.id)!.is_paused).toBe(false);
  });

  it("paused agent returns frozen Steward Score", () => {
    const agent = registerAgent(db, {
      name: "FrozenBot",
      chain: "solana",
      signer_address: "FrozenPubkey1111111111111111111111111111111",
    });

    const now = new Date("2026-03-09T12:00:00Z");

    // Build up 12 evaluations for a score
    for (let i = 0; i < 12; i++) {
      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: "approve",
        policy_set_id: "default",
        rules_evaluated: 4,
        violations: [],
        compliance_score_delta: 0,
        estimated_usd_value: 100,
        estimated_slippage_pct: 0.1,
        counterparties: [],
      });
    }

    // Compute and cache score
    const activeScore = computeStewardScore(db, agent.id, now);
    expect(activeScore.score).toBe(10.0);
    upsertStewardScore(db, activeScore);

    // Pause agent
    updateAgentPausedState(db, agent.id, true);

    // Add more log entries (shouldn't affect frozen score)
    for (let i = 0; i < 3; i++) {
      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: "reject",
        policy_set_id: "default",
        rules_evaluated: 4,
        violations: [{ rule_id: "r1", rule_type: "max_usd_value", severity: "critical", message: "Over limit", actual_value: 99999, threshold_value: 10000 }],
        compliance_score_delta: -1,
        estimated_usd_value: 99999,
        estimated_slippage_pct: 10,
        counterparties: [],
      });
    }

    // Score should be frozen at 10.0
    const frozenScore = computeStewardScore(db, agent.id, now);
    expect(frozenScore.score).toBe(10.0);

    // Unpause → score recomputes with violations
    updateAgentPausedState(db, agent.id, false);
    const unfrozenScore = computeStewardScore(db, agent.id, now);
    expect(unfrozenScore.score).not.toBeNull();
    expect(unfrozenScore.score!).toBeLessThan(10.0);
    expect(unfrozenScore.total_evaluations).toBe(15);
  });

  it("registerAgent with custom metadata persists correctly", () => {
    const agent = registerAgent(db, {
      name: "MetaAgent",
      chain: "solana",
      signer_address: "MetaPubkey11111111111111111111111111111111",
      metadata: { strategy: "arbitrage", version: "2.0" },
    });

    const fetched = getAgent(db, agent.id);
    expect(fetched!.metadata).toEqual({ strategy: "arbitrage", version: "2.0" });
  });

  it("multiple agents can be registered and queried independently", () => {
    const agent1 = registerAgent(db, { name: "Bot1", chain: "solana", signer_address: "Pub1" });
    const agent2 = registerAgent(db, { name: "Bot2", chain: "solana", signer_address: "Pub2" });

    // Log entries for each
    appendToStewardLog(db, {
      agent_id: agent1.id, chain: "solana", action: "approve", policy_set_id: "default",
      rules_evaluated: 4, violations: [], compliance_score_delta: 0,
      estimated_usd_value: 100, estimated_slippage_pct: 0.1, counterparties: [],
    });
    appendToStewardLog(db, {
      agent_id: agent2.id, chain: "solana", action: "reject", policy_set_id: "default",
      rules_evaluated: 4,
      violations: [{ rule_id: "r1", rule_type: "max_usd_value", severity: "critical", message: "Over", actual_value: 99999, threshold_value: 10000 }],
      compliance_score_delta: -1, estimated_usd_value: 99999, estimated_slippage_pct: 0.1, counterparties: [],
    });

    const entries1 = getLogEntriesByAgent(db, agent1.id);
    const entries2 = getLogEntriesByAgent(db, agent2.id);

    expect(entries1).toHaveLength(1);
    expect(entries1[0]!.action).toBe("approve");
    expect(entries2).toHaveLength(1);
    expect(entries2[0]!.action).toBe("reject");

    // Both scores independent
    const score1 = computeStewardScore(db, agent1.id);
    const score2 = computeStewardScore(db, agent2.id);
    expect(score1.total_violations).toBe(0);
    expect(score2.total_violations).toBe(1);
  });
});
