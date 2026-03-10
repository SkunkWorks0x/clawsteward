// Solana Devnet Live Integration Tests — validates the full ClawSteward pipeline
// against real Solana infrastructure with live RPC calls.
//
// Skipped when HELIUS_API_KEY is not set (safe for CI).
// Run with: pnpm test:devnet

import { describe, it, expect, beforeAll } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type Database from "better-sqlite3";

import { SolanaSimulator } from "../../src/chain/solana-adapter.js";
import { solanaToPolicyContext } from "../../src/chain/solana-policy-bridge.js";
import { evaluatePolicy } from "../../src/core/policy-engine.js";
import { appendToStewardLog, verifyStewardLog } from "../../src/core/audit-log.js";
import { computeStewardScore } from "../../src/core/reputation.js";
import { handleEvaluate } from "../../src/mcp/handlers.js";
import { registerAgent, updateAgentPausedState } from "../../src/core/agent.js";
import { createTestDatabase } from "../../src/db/database.js";
import {
  getPolicySet,
  insertPolicySet,
  getAgent,
  getConsecutiveViolations,
} from "../../src/db/queries.js";
import type { Agent, PolicySet, SimulationResult } from "../../src/core/types.js";
import type { SolanaSimulationPayload, TransactionMeta } from "../../src/chain/types.js";
import type { RuleContext } from "../../src/core/policy-rules.js";
import type { ChainSimulator } from "../../src/chain/simulator.js";

import {
  HELIUS_API_KEY,
  DEVNET_RPC_URL,
  SOL_MINT,
  SYSTEM_PROGRAM_ID,
  createDevnetConnection,
  requestAirdrop,
  buildSolTransfer,
  buildSecondTransfer,
  setupTestContext,
} from "./setup.js";

// ─── Gate: Skip entire file if no API key ──────────────────────

const SKIP = !process.env["HELIUS_API_KEY"];
const describeIfLive = SKIP ? describe.skip : describe;

// ─── Shared State ──────────────────────────────────────────────

let connection: Connection;
let simulator: SolanaSimulator;
let testKeypair: Keypair;
let recipientKeypair: Keypair;
let airdropSuccess: boolean;

describeIfLive("Solana Devnet Live Tests", () => {
  beforeAll(async () => {
    connection = createDevnetConnection();
    simulator = new SolanaSimulator({ heliusRpcUrl: DEVNET_RPC_URL });
    testKeypair = Keypair.generate();
    recipientKeypair = Keypair.generate();

    // Fund the test wallet
    airdropSuccess = await requestAirdrop(
      connection,
      testKeypair.publicKey,
      LAMPORTS_PER_SOL,
    );

    if (!airdropSuccess) {
      console.warn(
        "WARNING: Airdrop failed — tests requiring funded wallet will be skipped",
      );
    }
  }, 60_000);

  // ─── Test Group 1: Simulation ──────────────────────────────

  describe("Simulation", () => {
    it("simulates a valid SOL transfer with success", async () => {
      if (!airdropSuccess) return; // skip gracefully

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000, // 0.000001 SOL
      );

      const result = await simulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });

      expect(result.success).toBe(true);
      expect(result.chain).toBe("solana");
      expect(result.error).toBeUndefined();

      const payload = result.raw_chain_payload as SolanaSimulationPayload;
      expect(payload).toBeDefined();
      expect(Array.isArray(payload.logs)).toBe(true);
      expect(typeof payload.unitsConsumed).toBe("number");
      expect(payload.err).toBeNull();
    }, 30_000);

    it("simulates a transfer exceeding balance as failure", async () => {
      // Use a brand-new unfunded keypair
      const unfundedKeypair = Keypair.generate();

      const txBase64 = await buildSolTransfer(
        connection,
        unfundedKeypair.publicKey,
        recipientKeypair.publicKey,
        5 * LAMPORTS_PER_SOL,
      );

      const result = await simulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 30_000);

    it("returns error for invalid base64 transaction data", async () => {
      const result = await simulator.simulate("not-valid-base64-tx-data!!!", {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("deserialization failed");
    }, 30_000);

    it("returns expected fields in simulation result", async () => {
      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const result = await simulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("chain");
      expect(result).toHaveProperty("estimated_usd_value");
      expect(result).toHaveProperty("counterparties");
      expect(result).toHaveProperty("raw_chain_payload");
      expect(result).toHaveProperty("simulation_timestamp");

      const payload = result.raw_chain_payload as SolanaSimulationPayload;
      expect(Array.isArray(payload.logs)).toBe(true);
      expect(typeof payload.unitsConsumed).toBe("number");
    }, 30_000);

    it("extractTransactionMeta returns correct program IDs for SOL transfer", async () => {
      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const meta = simulator.extractTransactionMeta(txBase64);

      expect(meta.programIds).toContain(SYSTEM_PROGRAM_ID);
      expect(meta.signers).toContain(testKeypair.publicKey.toBase58());
      expect(meta.numInstructions).toBeGreaterThanOrEqual(1);
      expect(meta.recentBlockhash).toBeTruthy();
    }, 30_000);
  });

  // ─── Test Group 2: USD Estimation ──────────────────────────

  describe("USD Estimation", () => {
    // Jupiter Price API serves mainnet prices. Devnet tokens have no market value.
    // We use the mainnet SOL mint for price lookups, which is valid since
    // estimateUsdValue is a price oracle call, not a transaction simulation.

    it("estimates USD value of 1 SOL as a positive number", async () => {
      const result = await simulator.estimateUsdValue([
        { asset: SOL_MINT, symbol: "SOL", delta: 1.0, usd_value: 0 },
      ]);

      // Jupiter may not serve prices for every token at every moment
      if (result !== null) {
        expect(result).toBeGreaterThan(0);
      } else {
        console.warn("Jupiter price API returned null for SOL — API may be down");
      }
    }, 30_000);

    it("estimates USD value of 0 SOL as 0", async () => {
      const result = await simulator.estimateUsdValue([
        { asset: SOL_MINT, symbol: "SOL", delta: 0, usd_value: 0 },
      ]);

      if (result !== null) {
        expect(result).toBe(0);
      }
    }, 30_000);

    it("handles unknown token mint gracefully", async () => {
      const fakeMint = "FakeTokenMint11111111111111111111111111111";
      const result = await simulator.estimateUsdValue([
        { asset: fakeMint, symbol: "FAKE", delta: 100, usd_value: 0 },
      ]);

      // Should return 0 (no price data) or null, never throw
      expect(result === 0 || result === null).toBe(true);
    }, 30_000);
  });

  // ─── Test Group 3: Policy Bridge ───────────────────────────

  describe("Policy Bridge", () => {
    it("bridges real simulation output to policy context", async () => {
      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const simResult = await simulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });
      const meta = simulator.extractTransactionMeta(txBase64);

      const bridged = solanaToPolicyContext(simResult, meta, 0.5, "test-agent");

      expect(bridged.simulation.chain).toBe("solana");
      expect(bridged.simulation.estimated_usd_value).toBe(0.5);
      expect(bridged.simulation.counterparties).toContain(SYSTEM_PROGRAM_ID);
      expect(bridged.auditPayload.chain).toBe("solana");
    }, 30_000);

    it("resolves SystemProgram to 'System Program' in audit payload", async () => {
      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const simResult = await simulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });
      const meta = simulator.extractTransactionMeta(txBase64);

      const bridged = solanaToPolicyContext(simResult, meta, 0, "test-agent");

      const systemEntry = bridged.auditPayload.programIds.find(
        (p) => p.address === SYSTEM_PROGRAM_ID,
      );
      expect(systemEntry).toBeDefined();
      expect(systemEntry!.name).toBe("System Program");
    }, 30_000);

    it("stores raw Solana data in audit payload", async () => {
      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const simResult = await simulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });
      const meta = simulator.extractTransactionMeta(txBase64);

      const bridged = solanaToPolicyContext(simResult, meta, 0, "test-agent");

      expect(Array.isArray(bridged.auditPayload.logs)).toBe(true);
      expect(typeof bridged.auditPayload.unitsConsumed).toBe("number");
      expect(Array.isArray(bridged.auditPayload.accountsAccessed)).toBe(true);
      expect(bridged.auditPayload.recentBlockhash).toBeTruthy();
    }, 30_000);
  });

  // ─── Test Group 4: Full Pipeline ───────────────────────────

  describe("Full Pipeline", () => {
    it("evaluates a SOL transfer through handleEvaluate → APPROVED", async () => {
      if (!airdropSuccess) return;

      const { db, agent } = setupTestContext(testKeypair.publicKey.toBase58());

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      // Use real simulator but override RPC URL via env
      const deps = {
        db,
        getSimulator: (chain: string): ChainSimulator | undefined =>
          chain === "solana"
            ? new SolanaSimulator({ heliusRpcUrl: DEVNET_RPC_URL })
            : undefined,
      };

      // Temporarily set SOLANA_RPC_URL for handleEvaluate
      const origRpc = process.env["SOLANA_RPC_URL"];
      process.env["SOLANA_RPC_URL"] = DEVNET_RPC_URL;

      try {
        const result = await handleEvaluate(deps, {
          agent_id: agent.id,
          chain: "solana",
          raw_transaction_base64: txBase64,
          policy_set_id: "default",
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(
          (result.content[0] as { text: string }).text,
        );
        expect(parsed.approved).toBe(true);
        expect(parsed.violations).toHaveLength(0);
        expect(parsed.evaluation_id).toBeDefined();
      } finally {
        if (origRpc !== undefined) {
          process.env["SOLANA_RPC_URL"] = origRpc;
        } else {
          delete process.env["SOLANA_RPC_URL"];
        }
      }
    }, 30_000);

    it("rejects a SOL transfer that violates strict max_usd_value policy", async () => {
      if (!airdropSuccess) return;

      const db = createTestDatabase();
      const agent = registerAgent(db, {
        name: "strict-agent",
        chain: "solana",
        signer_address: testKeypair.publicKey.toBase58(),
      });

      // Insert a policy with absurdly low max_usd_value
      insertPolicySet(db, {
        id: "strict",
        name: "Strict Test",
        version: 1,
        rules: [
          {
            id: "tiny-max",
            type: "max_usd_value",
            params: { max: 0.0001 },
            severity: "critical",
            enabled: true,
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Build a transfer for 0.5 SOL — at any SOL price > $0.0002 this will violate
      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        LAMPORTS_PER_SOL / 2,
      );

      // Simulate + bridge + evaluate manually (handleEvaluate uses env-based USD which is 0)
      const simResult = await simulator.simulate(txBase64, {
        agent_id: agent.id,
        rpc_url: DEVNET_RPC_URL,
      });

      // If simulation succeeded, bridge with a reasonable USD estimate
      if (simResult.success) {
        const meta = simulator.extractTransactionMeta(txBase64);
        const bridged = solanaToPolicyContext(simResult, meta, 50.0, agent.id);

        const ruleCtx: RuleContext = {
          volume_24h_usd: 0,
          tx_count_1h: 0,
          consecutive_violations: 0,
          portfolio_positions: {},
          agent_paused: false,
        };

        const policy = getPolicySet(db, "strict")!;
        const evalResult = evaluatePolicy(policy, bridged.simulation, ruleCtx);

        expect(evalResult.passed).toBe(false);
        expect(evalResult.violations.length).toBeGreaterThan(0);
        expect(evalResult.violations[0]!.rule_type).toBe("max_usd_value");
      }
    }, 30_000);

    it("Steward Score improves with passing evaluations", async () => {
      if (!airdropSuccess) return;

      const db = createTestDatabase();
      const agent = registerAgent(db, {
        name: "score-test-agent",
        chain: "solana",
        signer_address: testKeypair.publicKey.toBase58(),
      });

      // Append 12 passing evaluations (need ≥10 for a score)
      for (let i = 0; i < 12; i++) {
        appendToStewardLog(db, {
          agent_id: agent.id,
          chain: "solana",
          action: "approve",
          policy_set_id: "default",
          rules_evaluated: 5,
          violations: [],
          compliance_score_delta: 0,
          estimated_usd_value: 10,
          estimated_slippage_pct: 0.1,
          counterparties: [SYSTEM_PROGRAM_ID],
        });
      }

      const score = computeStewardScore(db, agent.id);
      expect(score.score).toBe(10.0);
      expect(score.total_evaluations).toBe(12);
      expect(score.total_violations).toBe(0);
    }, 30_000);

    it("auto-pauses agent after 3 consecutive violations", async () => {
      if (!airdropSuccess) return;

      const db = createTestDatabase();
      const agent = registerAgent(db, {
        name: "pause-test-agent",
        chain: "solana",
        signer_address: testKeypair.publicKey.toBase58(),
      });

      insertPolicySet(db, {
        id: "pause-policy",
        name: "Auto-Pause Test",
        version: 1,
        rules: [
          {
            id: "tiny-max",
            type: "max_usd_value",
            params: { max: 0.0001 },
            severity: "critical",
            enabled: true,
          },
          {
            id: "auto-pause",
            type: "auto_pause_consecutive_violations",
            params: { threshold: 3, window_minutes: 60 },
            severity: "critical",
            enabled: true,
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const deps = {
        db,
        getSimulator: (chain: string): ChainSimulator | undefined =>
          chain === "solana"
            ? new SolanaSimulator({ heliusRpcUrl: DEVNET_RPC_URL })
            : undefined,
      };

      const origRpc = process.env["SOLANA_RPC_URL"];
      process.env["SOLANA_RPC_URL"] = DEVNET_RPC_URL;

      try {
        // Submit 3 violating transactions
        for (let i = 0; i < 3; i++) {
          const txBase64 = await buildSecondTransfer(
            connection,
            testKeypair.publicKey,
            LAMPORTS_PER_SOL / 10,
          );

          await handleEvaluate(deps, {
            agent_id: agent.id,
            chain: "solana",
            raw_transaction_base64: txBase64,
            policy_set_id: "pause-policy",
          });
        }

        // Agent should now be paused
        const agentAfter = getAgent(db, agent.id);
        expect(agentAfter?.is_paused).toBe(true);
      } finally {
        if (origRpc !== undefined) {
          process.env["SOLANA_RPC_URL"] = origRpc;
        } else {
          delete process.env["SOLANA_RPC_URL"];
        }
      }
    }, 60_000);

    it("returns AGENT_PAUSED after auto-pause", async () => {
      if (!airdropSuccess) return;

      const db = createTestDatabase();
      const agent = registerAgent(db, {
        name: "paused-agent",
        chain: "solana",
        signer_address: testKeypair.publicKey.toBase58(),
      });

      // Manually pause the agent
      updateAgentPausedState(db, agent.id, true);

      const deps = {
        db,
        getSimulator: (chain: string): ChainSimulator | undefined =>
          chain === "solana"
            ? new SolanaSimulator({ heliusRpcUrl: DEVNET_RPC_URL })
            : undefined,
      };

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const result = await handleEvaluate(deps, {
        agent_id: agent.id,
        chain: "solana",
        raw_transaction_base64: txBase64,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.code).toBe("AGENT_PAUSED");
    }, 30_000);

    it("verifies Steward Log hash chain integrity after evaluations", async () => {
      if (!airdropSuccess) return;

      const db = createTestDatabase();
      const agent = registerAgent(db, {
        name: "integrity-test-agent",
        chain: "solana",
        signer_address: testKeypair.publicKey.toBase58(),
      });

      // Add several log entries
      for (let i = 0; i < 5; i++) {
        appendToStewardLog(db, {
          agent_id: agent.id,
          chain: "solana",
          action: i % 2 === 0 ? "approve" : "reject",
          policy_set_id: "default",
          rules_evaluated: 5,
          violations:
            i % 2 === 1
              ? [
                  {
                    rule_id: "r1",
                    rule_type: "max_usd_value",
                    severity: "critical",
                    message: "Exceeded max value",
                    actual_value: 15000,
                    threshold_value: 10000,
                  },
                ]
              : [],
          compliance_score_delta: i % 2 === 0 ? 0 : -1,
          estimated_usd_value: 100,
          estimated_slippage_pct: 0.5,
          counterparties: [SYSTEM_PROGRAM_ID],
        });
      }

      const verification = verifyStewardLog(db);
      expect(verification.valid).toBe(true);
      expect(verification.entries_checked).toBe(5);
    }, 30_000);
  });

  // ─── Test Group 5: Network Resilience ──────────────────────

  describe("Network Resilience", () => {
    it("returns error result for invalid RPC URL", async () => {
      const badSimulator = new SolanaSimulator({
        heliusRpcUrl: "https://invalid-rpc-that-does-not-exist.example.com",
      });

      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const result = await badSimulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: "https://invalid-rpc-that-does-not-exist.example.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 30_000);

    it("returns timeout error for very short timeout", async () => {
      const timeoutSimulator = new SolanaSimulator({
        heliusRpcUrl: DEVNET_RPC_URL,
        fetchTimeoutMs: 1, // 1ms timeout — will definitely expire
      });

      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const result = await timeoutSimulator.simulate(txBase64, {
        agent_id: "test",
        rpc_url: DEVNET_RPC_URL,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 30_000);

    it("handleEvaluate returns SIMULATION_FAILED for bad RPC", async () => {
      const db = createTestDatabase();
      const agent = registerAgent(db, {
        name: "resilience-agent",
        chain: "solana",
        signer_address: testKeypair.publicKey.toBase58(),
      });

      const deps = {
        db,
        getSimulator: (chain: string): ChainSimulator | undefined =>
          chain === "solana"
            ? new SolanaSimulator({
                heliusRpcUrl: "https://invalid-rpc.example.com",
              })
            : undefined,
      };

      if (!airdropSuccess) return;

      const txBase64 = await buildSolTransfer(
        connection,
        testKeypair.publicKey,
        recipientKeypair.publicKey,
        1000,
      );

      const origRpc = process.env["SOLANA_RPC_URL"];
      process.env["SOLANA_RPC_URL"] = "https://invalid-rpc.example.com";

      try {
        const result = await handleEvaluate(deps, {
          agent_id: agent.id,
          chain: "solana",
          raw_transaction_base64: txBase64,
        });

        expect(result.isError).toBe(true);
        const parsed = JSON.parse(
          (result.content[0] as { text: string }).text,
        );
        expect(parsed.code).toBe("SIMULATION_FAILED");
      } finally {
        if (origRpc !== undefined) {
          process.env["SOLANA_RPC_URL"] = origRpc;
        } else {
          delete process.env["SOLANA_RPC_URL"];
        }
      }
    }, 30_000);
  });
});
