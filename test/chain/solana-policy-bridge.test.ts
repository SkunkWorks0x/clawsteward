import { describe, it, expect } from "vitest";
import {
  solanaToPolicyContext,
  resolveProgramName,
  resolveCounterparties,
} from "../../src/chain/solana-policy-bridge.js";
import { evaluatePolicy } from "../../src/core/policy-engine.js";
import type { RuleContext } from "../../src/core/policy-rules.js";
import type { AssetDelta, PolicySet, SimulationResult } from "../../src/core/types.js";
import type { SolanaSimulationPayload, TransactionMeta } from "../../src/chain/types.js";

// ─── Helpers ──────────────────────────────────────────────────────

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const UNKNOWN_PROGRAM = "UnknownProgramXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1";

function makeSimResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  const payload: SolanaSimulationPayload = {
    logs: [
      "Program 11111111111111111111111111111111 invoke [1]",
      "Program 11111111111111111111111111111111 success",
    ],
    unitsConsumed: 450,
    accountsAccessed: ["acct1", "acct2", "acct3"],
    err: null,
  };

  return {
    success: true,
    chain: "solana",
    estimated_usd_value: 0,
    estimated_slippage_pct: 0,
    counterparties: [SYSTEM_PROGRAM],
    assets_affected: [],
    raw_chain_payload: payload,
    simulation_timestamp: "2026-03-09T12:00:00.000Z",
    ...overrides,
  };
}

function makeTransferMeta(): TransactionMeta {
  return {
    programIds: [SYSTEM_PROGRAM],
    accounts: ["payerPubkey", "recipientPubkey", SYSTEM_PROGRAM],
    signers: ["payerPubkey"],
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    numInstructions: 1,
  };
}

function makeSwapMeta(): TransactionMeta {
  return {
    programIds: [JUPITER_V6, TOKEN_PROGRAM, ASSOCIATED_TOKEN],
    accounts: [
      "walletPubkey",
      JUPITER_V6,
      TOKEN_PROGRAM,
      ASSOCIATED_TOKEN,
      "solMint",
      "usdcMint",
      "poolAccount",
    ],
    signers: ["walletPubkey"],
    recentBlockhash: "ABCxyz123456789",
    numInstructions: 3,
  };
}

const defaultRuleContext: RuleContext = {
  volume_24h_usd: 0,
  tx_count_1h: 0,
  consecutive_violations: 0,
  portfolio_positions: {},
  agent_paused: false,
};

const defaultPolicySet: PolicySet = {
  id: "default",
  name: "Default Steward Policy",
  version: 1,
  rules: [
    { id: "max-tx-value", type: "max_usd_value", params: { max: 10000 }, severity: "critical", enabled: true },
    { id: "slippage-guard", type: "max_slippage_pct", params: { max: 3.0 }, severity: "high", enabled: true },
    { id: "daily-volume-cap", type: "velocity_24h_usd", params: { max: 50000 }, severity: "high", enabled: true },
    { id: "hourly-tx-limit", type: "velocity_1h_count", params: { max: 20 }, severity: "medium", enabled: true },
    { id: "blacklist", type: "blacklist_counterparties", params: { addresses: ["BLOCKED_ADDR"] }, severity: "critical", enabled: true },
  ],
  created_at: "2026-03-09T00:00:00Z",
  updated_at: "2026-03-09T00:00:00Z",
};

// ─── Tests ────────────────────────────────────────────────────────

describe("resolveProgramName", () => {
  it("resolves System Program", () => {
    expect(resolveProgramName(SYSTEM_PROGRAM)).toBe("System Program");
  });

  it("resolves Token Program", () => {
    expect(resolveProgramName(TOKEN_PROGRAM)).toBe("Token Program");
  });

  it("resolves Associated Token Program", () => {
    expect(resolveProgramName(ASSOCIATED_TOKEN)).toBe("Associated Token Program");
  });

  it("resolves Jupiter Aggregator v6", () => {
    expect(resolveProgramName(JUPITER_V6)).toBe("Jupiter Aggregator v6");
  });

  it("resolves Raydium AMM", () => {
    expect(resolveProgramName(RAYDIUM_AMM)).toBe("Raydium AMM");
  });

  it("returns raw address for unknown program", () => {
    expect(resolveProgramName(UNKNOWN_PROGRAM)).toBe(UNKNOWN_PROGRAM);
  });
});

describe("resolveCounterparties", () => {
  it("resolves mixed known and unknown programs", () => {
    const result = resolveCounterparties([SYSTEM_PROGRAM, UNKNOWN_PROGRAM, JUPITER_V6]);
    expect(result).toEqual([
      { address: SYSTEM_PROGRAM, name: "System Program" },
      { address: UNKNOWN_PROGRAM, name: UNKNOWN_PROGRAM },
      { address: JUPITER_V6, name: "Jupiter Aggregator v6" },
    ]);
  });
});

describe("solanaToPolicyContext", () => {
  describe("SOL transfer mapping", () => {
    it("bridges a simple SOL transfer with correct USD value", () => {
      const sim = makeSimResult();
      const meta = makeTransferMeta();
      const usd = 500;

      const { simulation, auditPayload } = solanaToPolicyContext(sim, meta, usd, "agent-001");

      expect(simulation.chain).toBe("solana");
      expect(simulation.estimated_usd_value).toBe(500);
      expect(simulation.success).toBe(true);
      expect(simulation.counterparties).toEqual([SYSTEM_PROGRAM]);
      expect(auditPayload.programIds).toEqual([
        { address: SYSTEM_PROGRAM, name: "System Program" },
      ]);
    });

    it("preserves simulation timestamp", () => {
      const sim = makeSimResult({ simulation_timestamp: "2026-03-09T15:30:00.000Z" });
      const meta = makeTransferMeta();

      const { simulation } = solanaToPolicyContext(sim, meta, 100, "agent-001");
      expect(simulation.simulation_timestamp).toBe("2026-03-09T15:30:00.000Z");
    });
  });

  describe("token swap mapping", () => {
    it("bridges a Jupiter swap with multiple programs", () => {
      const swapPayload: SolanaSimulationPayload = {
        logs: [
          "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
          "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
        ],
        unitsConsumed: 125000,
        accountsAccessed: ["walletPubkey", "poolAccount", "solMint", "usdcMint"],
        err: null,
      };

      const sim = makeSimResult({
        counterparties: [JUPITER_V6, TOKEN_PROGRAM, ASSOCIATED_TOKEN],
        raw_chain_payload: swapPayload,
      });
      const meta = makeSwapMeta();
      const assets: AssetDelta[] = [
        { asset: "solMint", symbol: "SOL", delta: -2.0, usd_value: 300 },
        { asset: "usdcMint", symbol: "USDC", delta: 295, usd_value: 295 },
      ];

      const { simulation, auditPayload } = solanaToPolicyContext(
        sim, meta, 300, "agent-swap",
        { slippagePct: 1.67, assetsAffected: assets },
      );

      expect(simulation.estimated_usd_value).toBe(300);
      expect(simulation.estimated_slippage_pct).toBe(1.67);
      expect(simulation.assets_affected).toHaveLength(2);
      expect(simulation.counterparties).toContain(JUPITER_V6);

      expect(auditPayload.programIds).toEqual([
        { address: JUPITER_V6, name: "Jupiter Aggregator v6" },
        { address: TOKEN_PROGRAM, name: "Token Program" },
        { address: ASSOCIATED_TOKEN, name: "Associated Token Program" },
      ]);
      expect(auditPayload.unitsConsumed).toBe(125000);
      expect(auditPayload.logs).toHaveLength(4);
    });
  });

  describe("unknown program handling", () => {
    it("passes through unknown program IDs as counterparties", () => {
      const meta: TransactionMeta = {
        programIds: [UNKNOWN_PROGRAM, SYSTEM_PROGRAM],
        accounts: ["acct1", UNKNOWN_PROGRAM, SYSTEM_PROGRAM],
        signers: ["acct1"],
        recentBlockhash: "hash123",
        numInstructions: 2,
      };
      const sim = makeSimResult({ counterparties: meta.programIds });

      const { simulation, auditPayload } = solanaToPolicyContext(sim, meta, 0, "agent-x");

      expect(simulation.counterparties).toContain(UNKNOWN_PROGRAM);
      expect(auditPayload.programIds[0]).toEqual({
        address: UNKNOWN_PROGRAM,
        name: UNKNOWN_PROGRAM,
      });
      expect(auditPayload.programIds[1]).toEqual({
        address: SYSTEM_PROGRAM,
        name: "System Program",
      });
    });
  });

  describe("USD value passthrough", () => {
    it("passes zero USD for non-value transfers", () => {
      const { simulation } = solanaToPolicyContext(makeSimResult(), makeTransferMeta(), 0, "agent-001");
      expect(simulation.estimated_usd_value).toBe(0);
    });

    it("passes large USD values accurately", () => {
      const { simulation } = solanaToPolicyContext(makeSimResult(), makeTransferMeta(), 99999.99, "agent-001");
      expect(simulation.estimated_usd_value).toBe(99999.99);
    });
  });

  describe("JSONB audit payload", () => {
    it("contains raw Solana logs", () => {
      const { auditPayload } = solanaToPolicyContext(makeSimResult(), makeTransferMeta(), 100, "agent-001");
      expect(auditPayload.logs).toHaveLength(2);
      expect(auditPayload.logs[0]).toContain("invoke [1]");
    });

    it("contains unitsConsumed", () => {
      const { auditPayload } = solanaToPolicyContext(makeSimResult(), makeTransferMeta(), 100, "agent-001");
      expect(auditPayload.unitsConsumed).toBe(450);
    });

    it("contains accounts, signers, blockhash, instruction count", () => {
      const meta = makeTransferMeta();
      const { auditPayload } = solanaToPolicyContext(makeSimResult(), meta, 100, "agent-001");

      expect(auditPayload.accountsAccessed).toEqual(["acct1", "acct2", "acct3"]);
      expect(auditPayload.signers).toEqual(["payerPubkey"]);
      expect(auditPayload.recentBlockhash).toBe("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
      expect(auditPayload.numInstructions).toBe(1);
      expect(auditPayload.chain).toBe("solana");
    });

    it("is JSON-serializable", () => {
      const { auditPayload } = solanaToPolicyContext(makeSimResult(), makeTransferMeta(), 100, "agent-001");
      const json = JSON.stringify(auditPayload);
      const parsed = JSON.parse(json);
      expect(parsed.chain).toBe("solana");
      expect(parsed.unitsConsumed).toBe(450);
    });

    it("includes simulation error when present", () => {
      const errorPayload: SolanaSimulationPayload = {
        logs: ["Program failed"],
        unitsConsumed: 10,
        accountsAccessed: [],
        err: { InstructionError: [0, { Custom: 6001 }] },
      };
      const sim = makeSimResult({
        success: false,
        raw_chain_payload: errorPayload,
        error: "InstructionError",
      });

      const { auditPayload } = solanaToPolicyContext(sim, makeTransferMeta(), 0, "agent-001");
      expect(auditPayload.simulationError).toEqual({ InstructionError: [0, { Custom: 6001 }] });
    });

    it("falls back to meta.accounts when raw payload is null", () => {
      const sim = makeSimResult({ raw_chain_payload: null });
      const meta = makeTransferMeta();

      const { auditPayload } = solanaToPolicyContext(sim, meta, 0, "agent-001");
      expect(auditPayload.accountsAccessed).toEqual(meta.accounts);
      expect(auditPayload.logs).toEqual([]);
      expect(auditPayload.unitsConsumed).toBe(0);
    });
  });

  describe("failed simulation bridging", () => {
    it("preserves error info through the bridge", () => {
      const sim = makeSimResult({
        success: false,
        error: "Simulation RPC error: timeout",
      });

      const { simulation } = solanaToPolicyContext(sim, makeTransferMeta(), 0, "agent-001");
      expect(simulation.success).toBe(false);
      expect(simulation.error).toBe("Simulation RPC error: timeout");
    });
  });
});

describe("integration: Solana bridge → policy engine", () => {
  it("approves a compliant SOL transfer under all limits", () => {
    const sim = makeSimResult();
    const meta = makeTransferMeta();
    const { simulation } = solanaToPolicyContext(sim, meta, 500, "agent-001");

    const result = evaluatePolicy(defaultPolicySet, simulation, defaultRuleContext);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.rules_evaluated).toBe(5);
  });

  it("rejects a transfer exceeding max_usd_value", () => {
    const sim = makeSimResult();
    const meta = makeTransferMeta();
    const { simulation } = solanaToPolicyContext(sim, meta, 15000, "agent-001");

    const result = evaluatePolicy(defaultPolicySet, simulation, defaultRuleContext);

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule_type).toBe("max_usd_value");
    expect(result.violations[0]!.severity).toBe("critical");
  });

  it("rejects a swap with excessive slippage", () => {
    const sim = makeSimResult({ counterparties: [JUPITER_V6, TOKEN_PROGRAM] });
    const meta = makeSwapMeta();
    const { simulation } = solanaToPolicyContext(sim, meta, 1000, "agent-001", { slippagePct: 5.5 });

    const result = evaluatePolicy(defaultPolicySet, simulation, defaultRuleContext);

    expect(result.passed).toBe(false);
    const slippageViolation = result.violations.find((v) => v.rule_type === "max_slippage_pct");
    expect(slippageViolation).toBeDefined();
    expect(slippageViolation!.actual_value).toBe(5.5);
  });

  it("rejects when 24h velocity cap would be exceeded", () => {
    const sim = makeSimResult();
    const meta = makeTransferMeta();
    const { simulation } = solanaToPolicyContext(sim, meta, 5000, "agent-001");

    const ctx: RuleContext = {
      ...defaultRuleContext,
      volume_24h_usd: 48000, // 48k + 5k = 53k > 50k cap
    };

    const result = evaluatePolicy(defaultPolicySet, simulation, ctx);

    expect(result.passed).toBe(false);
    const velocityViolation = result.violations.find((v) => v.rule_type === "velocity_24h_usd");
    expect(velocityViolation).toBeDefined();
  });

  it("rejects when tx involves a blacklisted counterparty", () => {
    const meta: TransactionMeta = {
      programIds: [SYSTEM_PROGRAM, "BLOCKED_ADDR"],
      accounts: ["payer", "BLOCKED_ADDR", SYSTEM_PROGRAM],
      signers: ["payer"],
      recentBlockhash: "hash",
      numInstructions: 2,
    };
    const sim = makeSimResult({ counterparties: meta.programIds });
    const { simulation } = solanaToPolicyContext(sim, meta, 100, "agent-001");

    const result = evaluatePolicy(defaultPolicySet, simulation, defaultRuleContext);

    expect(result.passed).toBe(false);
    const blacklistViolation = result.violations.find((v) => v.rule_type === "blacklist_counterparties");
    expect(blacklistViolation).toBeDefined();
    expect(blacklistViolation!.message).toContain("BLOCKED_ADDR");
  });

  it("catches multiple violations in a single evaluation", () => {
    const meta: TransactionMeta = {
      programIds: ["BLOCKED_ADDR"],
      accounts: ["payer", "BLOCKED_ADDR"],
      signers: ["payer"],
      recentBlockhash: "hash",
      numInstructions: 1,
    };
    const sim = makeSimResult({ counterparties: meta.programIds });
    // $15000 exceeds max_usd_value, slippage 5% exceeds max, and blacklisted counterparty
    const { simulation } = solanaToPolicyContext(sim, meta, 15000, "agent-001", { slippagePct: 5.0 });

    const result = evaluatePolicy(defaultPolicySet, simulation, defaultRuleContext);

    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);

    const ruleTypes = result.violations.map((v) => v.rule_type);
    expect(ruleTypes).toContain("max_usd_value");
    expect(ruleTypes).toContain("max_slippage_pct");
    expect(ruleTypes).toContain("blacklist_counterparties");
  });
});
