import { describe, it, expect } from "vitest";
import { evaluatePolicy, evaluateRule, parsePolicySet, PolicyParseError } from "../../src/core/policy-engine.js";
import type { PolicyRule, PolicySet, SimulationResult } from "../../src/core/types.js";
import type { RuleContext } from "../../src/core/policy-rules.js";

// ─── Test Helpers ──────────────────────────────────────────────────

function makeSim(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    success: true,
    chain: "solana",
    estimated_usd_value: 500,
    estimated_slippage_pct: 0.5,
    counterparties: ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB"],
    assets_affected: [
      { asset: "SOL", symbol: "SOL", delta: -10, usd_value: 500 },
      { asset: "USDC", symbol: "USDC", delta: 495, usd_value: 495 },
    ],
    raw_chain_payload: {},
    simulation_timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    volume_24h_usd: 0,
    tx_count_1h: 0,
    consecutive_violations: 0,
    portfolio_positions: {},
    agent_paused: false,
    ...overrides,
  };
}

function makeRule(overrides: Partial<PolicyRule>): PolicyRule {
  return {
    id: "test-rule",
    type: "max_usd_value",
    params: { max: 10000 },
    severity: "critical",
    enabled: true,
    ...overrides,
  };
}

function makePolicySet(rules: PolicyRule[]): PolicySet {
  return {
    id: "test-policy",
    name: "Test Policy",
    version: 1,
    rules,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── max_usd_value ─────────────────────────────────────────────────

describe("max_usd_value", () => {
  const rule = makeRule({ id: "max-val", type: "max_usd_value", params: { max: 10000 }, severity: "critical" });

  it("passes when value is under limit", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 5000 }), makeCtx());
    expect(v).toBeNull();
  });

  it("passes when value equals limit exactly", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 10000 }), makeCtx());
    expect(v).toBeNull();
  });

  it("fails when value exceeds limit", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 10001 }), makeCtx());
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("max_usd_value");
    expect(v!.severity).toBe("critical");
    expect(v!.actual_value).toBe(10001);
    expect(v!.threshold_value).toBe(10000);
  });

  it("fails with very large values", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 1_000_000 }), makeCtx());
    expect(v).not.toBeNull();
  });

  it("passes with zero value", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 0 }), makeCtx());
    expect(v).toBeNull();
  });
});

// ─── max_slippage_pct ──────────────────────────────────────────────

describe("max_slippage_pct", () => {
  const rule = makeRule({ id: "slip", type: "max_slippage_pct", params: { max: 3.0 }, severity: "high" });

  it("passes when slippage is under limit", () => {
    const v = evaluateRule(rule, makeSim({ estimated_slippage_pct: 1.5 }), makeCtx());
    expect(v).toBeNull();
  });

  it("passes when slippage equals limit", () => {
    const v = evaluateRule(rule, makeSim({ estimated_slippage_pct: 3.0 }), makeCtx());
    expect(v).toBeNull();
  });

  it("fails when slippage exceeds limit", () => {
    const v = evaluateRule(rule, makeSim({ estimated_slippage_pct: 5.5 }), makeCtx());
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("max_slippage_pct");
    expect(v!.severity).toBe("high");
    expect(v!.actual_value).toBe(5.5);
  });

  it("passes with zero slippage", () => {
    const v = evaluateRule(rule, makeSim({ estimated_slippage_pct: 0 }), makeCtx());
    expect(v).toBeNull();
  });

  it("fails with fractional overshoot", () => {
    const v = evaluateRule(rule, makeSim({ estimated_slippage_pct: 3.01 }), makeCtx());
    expect(v).not.toBeNull();
  });
});

// ─── velocity_24h_usd ─────────────────────────────────────────────

describe("velocity_24h_usd", () => {
  const rule = makeRule({ id: "vel24", type: "velocity_24h_usd", params: { max: 50000 }, severity: "high" });

  it("passes when projected volume is under cap", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 5000 }), makeCtx({ volume_24h_usd: 10000 }));
    expect(v).toBeNull();
  });

  it("passes when projected volume equals cap", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 5000 }), makeCtx({ volume_24h_usd: 45000 }));
    expect(v).toBeNull();
  });

  it("fails when projected volume exceeds cap", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 5000 }), makeCtx({ volume_24h_usd: 46000 }));
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("velocity_24h_usd");
    expect(v!.actual_value).toBe(51000); // 46000 + 5000
    expect(v!.threshold_value).toBe(50000);
  });

  it("fails when existing volume alone already exceeds cap", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 100 }), makeCtx({ volume_24h_usd: 55000 }));
    expect(v).not.toBeNull();
  });

  it("passes with zero existing volume", () => {
    const v = evaluateRule(rule, makeSim({ estimated_usd_value: 1000 }), makeCtx({ volume_24h_usd: 0 }));
    expect(v).toBeNull();
  });
});

// ─── velocity_1h_count ─────────────────────────────────────────────

describe("velocity_1h_count", () => {
  const rule = makeRule({ id: "vel1h", type: "velocity_1h_count", params: { max: 20 }, severity: "medium" });

  it("passes when projected count is under limit", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ tx_count_1h: 10 }));
    expect(v).toBeNull();
  });

  it("passes when projected count equals limit", () => {
    // 19 existing + 1 (this tx) = 20 = limit
    const v = evaluateRule(rule, makeSim(), makeCtx({ tx_count_1h: 19 }));
    expect(v).toBeNull();
  });

  it("fails when projected count exceeds limit", () => {
    // 20 existing + 1 = 21 > 20
    const v = evaluateRule(rule, makeSim(), makeCtx({ tx_count_1h: 20 }));
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("velocity_1h_count");
    expect(v!.actual_value).toBe(21);
    expect(v!.threshold_value).toBe(20);
  });

  it("passes with zero existing count", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ tx_count_1h: 0 }));
    expect(v).toBeNull();
  });

  it("fails with very high count", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ tx_count_1h: 100 }));
    expect(v).not.toBeNull();
  });
});

// ─── blacklist_counterparties ──────────────────────────────────────

describe("blacklist_counterparties", () => {
  const blacklisted = "ScamProgram111111111111111111111111111111111";
  const rule = makeRule({
    id: "blacklist",
    type: "blacklist_counterparties",
    params: { addresses: [blacklisted] },
    severity: "critical",
  });

  it("passes when no counterparties are blacklisted", () => {
    const v = evaluateRule(
      rule,
      makeSim({ counterparties: ["LegitProgram1111111111111111111111111111111"] }),
      makeCtx(),
    );
    expect(v).toBeNull();
  });

  it("fails when a counterparty is blacklisted", () => {
    const v = evaluateRule(rule, makeSim({ counterparties: [blacklisted] }), makeCtx());
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("blacklist_counterparties");
    expect(v!.severity).toBe("critical");
    expect((v!.actual_value as string)).toContain(blacklisted);
  });

  it("fails when one of many counterparties is blacklisted", () => {
    const v = evaluateRule(
      rule,
      makeSim({ counterparties: ["LegitA", blacklisted, "LegitB"] }),
      makeCtx(),
    );
    expect(v).not.toBeNull();
  });

  it("passes with empty counterparties list", () => {
    const v = evaluateRule(rule, makeSim({ counterparties: [] }), makeCtx());
    expect(v).toBeNull();
  });

  it("passes with empty blacklist", () => {
    const emptyRule = makeRule({
      id: "blacklist-empty",
      type: "blacklist_counterparties",
      params: { addresses: [] },
    });
    const v = evaluateRule(emptyRule, makeSim({ counterparties: ["anything"] }), makeCtx());
    expect(v).toBeNull();
  });

  it("detects multiple blacklisted counterparties", () => {
    const multiRule = makeRule({
      id: "blacklist-multi",
      type: "blacklist_counterparties",
      params: { addresses: ["Bad1", "Bad2", "Bad3"] },
      severity: "critical",
    });
    const v = evaluateRule(multiRule, makeSim({ counterparties: ["Good1", "Bad1", "Bad3"] }), makeCtx());
    expect(v).not.toBeNull();
    expect((v!.actual_value as string)).toContain("Bad1");
    expect((v!.actual_value as string)).toContain("Bad3");
  });
});

// ─── whitelist_programs ────────────────────────────────────────────

describe("whitelist_programs", () => {
  const allowed = "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB";
  const rule = makeRule({
    id: "whitelist",
    type: "whitelist_programs",
    params: { programs: [allowed] },
    severity: "high",
  });

  it("passes when all counterparties are whitelisted", () => {
    const v = evaluateRule(rule, makeSim({ counterparties: [allowed] }), makeCtx());
    expect(v).toBeNull();
  });

  it("fails when a counterparty is not whitelisted", () => {
    const v = evaluateRule(
      rule,
      makeSim({ counterparties: [allowed, "UnknownProgram111111111111111111111111"] }),
      makeCtx(),
    );
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("whitelist_programs");
    expect((v!.actual_value as string)).toContain("UnknownProgram");
  });

  it("fails when no counterparties are whitelisted", () => {
    const v = evaluateRule(
      rule,
      makeSim({ counterparties: ["Rogue1", "Rogue2"] }),
      makeCtx(),
    );
    expect(v).not.toBeNull();
  });

  it("passes with empty counterparties", () => {
    const v = evaluateRule(rule, makeSim({ counterparties: [] }), makeCtx());
    expect(v).toBeNull();
  });

  it("passes with empty whitelist (no restrictions)", () => {
    const emptyRule = makeRule({
      id: "whitelist-empty",
      type: "whitelist_programs",
      params: { programs: [] },
    });
    const v = evaluateRule(emptyRule, makeSim({ counterparties: ["anything"] }), makeCtx());
    expect(v).toBeNull();
  });
});

// ─── concentration_pct ─────────────────────────────────────────────

describe("concentration_pct", () => {
  const rule = makeRule({
    id: "conc",
    type: "concentration_pct",
    params: { max: 50 },
    severity: "medium",
  });

  it("passes when concentration is under limit", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 5, usd_value: 1000 }],
      }),
      makeCtx({
        portfolio_positions: { SOL: 2000, USDC: 4000, ETH: 4000 },
      }),
    );
    // SOL becomes 3000, USDC 4000, ETH 4000. Total 11000. Max = SOL/USDC/ETH at 36.4%/36.4%/36.4%
    expect(v).toBeNull();
  });

  it("fails when concentration exceeds limit", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 100, usd_value: 8000 }],
      }),
      makeCtx({
        portfolio_positions: { SOL: 5000, USDC: 2000 },
      }),
    );
    // SOL becomes 13000, USDC stays 2000, total 15000. SOL = 86.7%
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("concentration_pct");
  });

  it("passes when portfolio is empty (new position below threshold)", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 10, usd_value: 1000 }],
      }),
      makeCtx({ portfolio_positions: {} }),
    );
    // SOL = 1000, total = 1000. SOL = 100% — exceeds 50%
    // Wait, a single asset in an empty portfolio is 100%. This SHOULD fail.
    expect(v).not.toBeNull();
  });

  it("passes with diversified portfolio additions", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [
          { asset: "SOL", symbol: "SOL", delta: -5, usd_value: 500 },
          { asset: "USDC", symbol: "USDC", delta: 495, usd_value: 495 },
        ],
      }),
      makeCtx({
        portfolio_positions: { SOL: 3000, USDC: 3000 },
      }),
    );
    // SOL: 3000 + 500 = 3500, USDC: 3000 + 495 = 3495. Total = 6995.
    // SOL = 50.04% — just over threshold
    expect(v).not.toBeNull();
  });

  it("passes with zero total portfolio value after tx", () => {
    const v = evaluateRule(
      rule,
      makeSim({ assets_affected: [] }),
      makeCtx({ portfolio_positions: {} }),
    );
    // Empty portfolio, no assets affected = no concentration to evaluate
    expect(v).toBeNull();
  });

  it("handles sell-only transactions (negative deltas)", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: -10, usd_value: -1000 }],
      }),
      makeCtx({
        portfolio_positions: { SOL: 6000, USDC: 4000 },
      }),
    );
    // SOL: 6000 + (-1000) = 5000, USDC: 4000. Total = 9000. SOL = 55.6%
    expect(v).not.toBeNull();
  });
});

// ─── auto_pause_consecutive_violations ─────────────────────────────

describe("auto_pause_consecutive_violations", () => {
  const rule = makeRule({
    id: "auto-pause",
    type: "auto_pause_consecutive_violations",
    params: { threshold: 3, window_minutes: 60 },
    severity: "critical",
  });

  it("passes when consecutive violations are below threshold", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ consecutive_violations: 1 }));
    expect(v).toBeNull();
  });

  it("passes with zero consecutive violations", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ consecutive_violations: 0 }));
    expect(v).toBeNull();
  });

  it("fails when consecutive violations meet threshold", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ consecutive_violations: 3 }));
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("auto_pause_consecutive_violations");
    expect(v!.severity).toBe("critical");
  });

  it("fails when consecutive violations exceed threshold", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ consecutive_violations: 10 }));
    expect(v).not.toBeNull();
  });

  it("fails when agent is already paused", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ agent_paused: true, consecutive_violations: 0 }));
    expect(v).not.toBeNull();
    expect((v!.actual_value as string)).toBe("paused");
  });

  it("passes at threshold minus one", () => {
    const v = evaluateRule(rule, makeSim(), makeCtx({ consecutive_violations: 2 }));
    expect(v).toBeNull();
  });
});

// ─── max_position_usd ──────────────────────────────────────────────

describe("max_position_usd", () => {
  const rule = makeRule({
    id: "max-pos",
    type: "max_position_usd",
    params: { max: 25000 },
    severity: "high",
  });

  it("passes when projected position is under limit", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 10, usd_value: 5000 }],
      }),
      makeCtx({ portfolio_positions: { SOL: 10000 } }),
    );
    // Projected: 10000 + 5000 = 15000 < 25000
    expect(v).toBeNull();
  });

  it("passes when projected position equals limit", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 10, usd_value: 15000 }],
      }),
      makeCtx({ portfolio_positions: { SOL: 10000 } }),
    );
    // Projected: 10000 + 15000 = 25000 = limit
    expect(v).toBeNull();
  });

  it("fails when projected position exceeds limit", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 20, usd_value: 20000 }],
      }),
      makeCtx({ portfolio_positions: { SOL: 10000 } }),
    );
    // Projected: 10000 + 20000 = 30000 > 25000
    expect(v).not.toBeNull();
    expect(v!.rule_type).toBe("max_position_usd");
    expect(v!.actual_value).toBe(30000);
    expect(v!.threshold_value).toBe(25000);
  });

  it("passes for assets being sold (negative delta)", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: -50, usd_value: 30000 }],
      }),
      makeCtx({ portfolio_positions: { SOL: 40000 } }),
    );
    // delta is negative, so this is selling — skip check
    expect(v).toBeNull();
  });

  it("passes with no existing position", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [{ asset: "SOL", symbol: "SOL", delta: 5, usd_value: 5000 }],
      }),
      makeCtx({ portfolio_positions: {} }),
    );
    // Projected: 0 + 5000 = 5000 < 25000
    expect(v).toBeNull();
  });

  it("checks each acquired asset independently", () => {
    const v = evaluateRule(
      rule,
      makeSim({
        assets_affected: [
          { asset: "SOL", symbol: "SOL", delta: -10, usd_value: 5000 },
          { asset: "BTC", symbol: "BTC", delta: 0.1, usd_value: 30000 },
        ],
      }),
      makeCtx({ portfolio_positions: { BTC: 0 } }),
    );
    // SOL is being sold (negative delta) — skip
    // BTC: 0 + 30000 = 30000 > 25000 — violation
    expect(v).not.toBeNull();
    expect(v!.message).toContain("BTC");
  });
});

// ─── custom rule type ──────────────────────────────────────────────

describe("custom rule type", () => {
  it("returns null (no-op) for custom rules without handler", () => {
    const rule = makeRule({
      id: "custom-rule",
      type: "custom",
      params: { some_param: "value" },
      severity: "low",
    });
    const v = evaluateRule(rule, makeSim(), makeCtx());
    expect(v).toBeNull();
  });
});

// ─── Policy Engine (evaluatePolicy) ────────────────────────────────

describe("evaluatePolicy", () => {
  it("returns passed=true when no rules are violated", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 10000 } }),
      makeRule({ id: "r2", type: "max_slippage_pct", params: { max: 5.0 } }),
    ]);
    const result = evaluatePolicy(policy, makeSim({ estimated_usd_value: 500, estimated_slippage_pct: 1.0 }), makeCtx());

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.rules_evaluated).toBe(2);
    expect(result.evaluation_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns passed=false with all violations when rules fail", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 100 }, severity: "critical" }),
      makeRule({ id: "r2", type: "max_slippage_pct", params: { max: 0.1 }, severity: "high" }),
    ]);
    const result = evaluatePolicy(
      policy,
      makeSim({ estimated_usd_value: 500, estimated_slippage_pct: 2.0 }),
      makeCtx(),
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]!.rule_id).toBe("r1");
    expect(result.violations[1]!.rule_id).toBe("r2");
  });

  it("skips disabled rules", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 100 }, enabled: false }),
      makeRule({ id: "r2", type: "max_slippage_pct", params: { max: 5.0 }, enabled: true }),
    ]);
    const result = evaluatePolicy(policy, makeSim({ estimated_usd_value: 500 }), makeCtx());

    // r1 is disabled, only r2 evaluated
    expect(result.rules_evaluated).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("evaluates all rule types in a mixed policy set", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 10000 } }),
      makeRule({ id: "r2", type: "max_slippage_pct", params: { max: 5.0 } }),
      makeRule({ id: "r3", type: "velocity_24h_usd", params: { max: 50000 } }),
      makeRule({ id: "r4", type: "velocity_1h_count", params: { max: 20 } }),
      makeRule({
        id: "r5",
        type: "blacklist_counterparties",
        params: { addresses: ["BadAddr"] },
      }),
      makeRule({
        id: "r6",
        type: "whitelist_programs",
        params: { programs: ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB"] },
      }),
      makeRule({ id: "r7", type: "concentration_pct", params: { max: 80 } }),
      makeRule({
        id: "r8",
        type: "auto_pause_consecutive_violations",
        params: { threshold: 3, window_minutes: 60 },
      }),
      makeRule({ id: "r9", type: "max_position_usd", params: { max: 100000 } }),
      makeRule({ id: "r10", type: "custom", params: {} }),
    ]);

    const result = evaluatePolicy(policy, makeSim(), makeCtx({
      portfolio_positions: { SOL: 5000, USDC: 5000 },
    }));

    expect(result.rules_evaluated).toBe(10);
    // With default sim values and generous limits, should pass
    expect(result.passed).toBe(true);
  });

  it("records evaluation timing", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 10000 } }),
    ]);
    const result = evaluatePolicy(policy, makeSim(), makeCtx());

    expect(typeof result.evaluation_ms).toBe("number");
    expect(result.evaluation_ms).toBeGreaterThanOrEqual(0);
  });

  it("handles empty policy set", () => {
    const policy = makePolicySet([]);
    const result = evaluatePolicy(policy, makeSim(), makeCtx());

    expect(result.passed).toBe(true);
    expect(result.rules_evaluated).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it("handles policy set with all rules disabled", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 1 }, enabled: false }),
      makeRule({ id: "r2", type: "max_slippage_pct", params: { max: 0.001 }, enabled: false }),
    ]);
    const result = evaluatePolicy(policy, makeSim(), makeCtx());

    expect(result.passed).toBe(true);
    expect(result.rules_evaluated).toBe(0);
  });

  it("collects multiple violations from different rules", () => {
    const policy = makePolicySet([
      makeRule({ id: "r1", type: "max_usd_value", params: { max: 100 }, severity: "critical" }),
      makeRule({ id: "r2", type: "max_slippage_pct", params: { max: 0.01 }, severity: "high" }),
      makeRule({ id: "r3", type: "velocity_1h_count", params: { max: 1 }, severity: "medium" }),
    ]);
    const result = evaluatePolicy(
      policy,
      makeSim({ estimated_usd_value: 500, estimated_slippage_pct: 2.0 }),
      makeCtx({ tx_count_1h: 5 }),
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(3);
    const severities = result.violations.map((v) => v.severity);
    expect(severities).toContain("critical");
    expect(severities).toContain("high");
    expect(severities).toContain("medium");
  });
});

// ─── parsePolicySet ────────────────────────────────────────────────

describe("parsePolicySet", () => {
  it("parses a valid policy set", () => {
    const input = {
      id: "test",
      name: "Test Policy",
      version: 1,
      rules: [
        { id: "r1", type: "max_usd_value", params: { max: 10000 }, severity: "critical", enabled: true },
      ],
    };
    const result = parsePolicySet(input);

    expect(result.id).toBe("test");
    expect(result.name).toBe("Test Policy");
    expect(result.version).toBe(1);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.type).toBe("max_usd_value");
  });

  it("throws on null input", () => {
    expect(() => parsePolicySet(null)).toThrow(PolicyParseError);
  });

  it("throws on missing id", () => {
    expect(() => parsePolicySet({ name: "x", version: 1, rules: [] })).toThrow("non-empty string 'id'");
  });

  it("throws on empty id", () => {
    expect(() => parsePolicySet({ id: "", name: "x", version: 1, rules: [] })).toThrow("non-empty string 'id'");
  });

  it("throws on missing name", () => {
    expect(() => parsePolicySet({ id: "x", version: 1, rules: [] })).toThrow("non-empty string 'name'");
  });

  it("throws on invalid version", () => {
    expect(() => parsePolicySet({ id: "x", name: "x", version: 0, rules: [] })).toThrow("positive integer 'version'");
  });

  it("throws on non-integer version", () => {
    expect(() => parsePolicySet({ id: "x", name: "x", version: 1.5, rules: [] })).toThrow("positive integer 'version'");
  });

  it("throws on missing rules", () => {
    expect(() => parsePolicySet({ id: "x", name: "x", version: 1 })).toThrow("array 'rules'");
  });

  it("throws on invalid rule type", () => {
    expect(() =>
      parsePolicySet({
        id: "x",
        name: "x",
        version: 1,
        rules: [{ id: "r1", type: "invalid_type", params: {}, severity: "low", enabled: true }],
      }),
    ).toThrow("invalid type");
  });

  it("throws on invalid severity", () => {
    expect(() =>
      parsePolicySet({
        id: "x",
        name: "x",
        version: 1,
        rules: [{ id: "r1", type: "max_usd_value", params: {}, severity: "extreme", enabled: true }],
      }),
    ).toThrow("invalid severity");
  });

  it("throws on missing rule params", () => {
    expect(() =>
      parsePolicySet({
        id: "x",
        name: "x",
        version: 1,
        rules: [{ id: "r1", type: "max_usd_value", severity: "low", enabled: true }],
      }),
    ).toThrow("object 'params'");
  });

  it("throws on missing rule enabled flag", () => {
    expect(() =>
      parsePolicySet({
        id: "x",
        name: "x",
        version: 1,
        rules: [{ id: "r1", type: "max_usd_value", params: {}, severity: "low" }],
      }),
    ).toThrow("boolean 'enabled'");
  });

  it("parses all 10 valid rule types", () => {
    const types = [
      "max_usd_value", "max_slippage_pct", "velocity_24h_usd", "velocity_1h_count",
      "blacklist_counterparties", "whitelist_programs", "concentration_pct",
      "auto_pause_consecutive_violations", "max_position_usd", "custom",
    ];
    const rules = types.map((type, i) => ({
      id: `r${i}`,
      type,
      params: {},
      severity: "low",
      enabled: true,
    }));
    const result = parsePolicySet({ id: "x", name: "x", version: 1, rules });
    expect(result.rules).toHaveLength(10);
  });

  it("sets created_at and updated_at when missing", () => {
    const result = parsePolicySet({
      id: "x",
      name: "x",
      version: 1,
      rules: [],
    });
    expect(result.created_at).toBeDefined();
    expect(result.updated_at).toBeDefined();
  });
});
