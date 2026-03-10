// Solana Policy Bridge — converts Solana-specific simulation output into
// chain-abstract types for the policy engine and audit log.
//
// This is the translation layer between the Solana adapter and the core engine.
// The policy engine NEVER sees Solana-specific data — only chain-abstract SimulationResult.

import type { AssetDelta, SimulationResult } from "../core/types.js";
import type { SolanaSimulationPayload, TransactionMeta } from "./types.js";

// ─── Known Solana Program ID → Human-Readable Name ──────────────

const KNOWN_PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Token Program",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token Program",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter Aggregator v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
};

/**
 * Resolve a Solana program ID to a human-readable name.
 * Returns the raw address if unknown.
 */
export function resolveProgramName(programId: string): string {
  return KNOWN_PROGRAMS[programId] ?? programId;
}

/**
 * Resolve all program IDs in a list, returning objects with both address and name.
 */
export function resolveCounterparties(
  programIds: string[],
): Array<{ address: string; name: string }> {
  return programIds.map((id) => ({
    address: id,
    name: resolveProgramName(id),
  }));
}

// ─── Bridge Output ──────────────────────────────────────────────

/** Result of bridging Solana simulation output to policy-engine-ready context */
export interface BridgedPolicyInput {
  /** Chain-abstract SimulationResult ready for evaluatePolicy() */
  simulation: SimulationResult;
  /** JSONB-serializable blob for the Steward Log chain_payload field */
  auditPayload: SolanaAuditPayload;
}

/** Raw Solana data stored in the Steward Log JSONB blob */
export interface SolanaAuditPayload {
  chain: "solana";
  logs: string[];
  unitsConsumed: number;
  accountsAccessed: string[];
  programIds: Array<{ address: string; name: string }>;
  signers: string[];
  recentBlockhash: string;
  numInstructions: number;
  simulationError: unknown;
}

// ─── Bridge Function ────────────────────────────────────────────

/**
 * Convert Solana-specific simulation output into the chain-abstract
 * SimulationResult that policy-engine.ts expects, plus a JSONB audit payload.
 *
 * @param sim - SimulationResult from SolanaSimulator.simulate()
 * @param meta - TransactionMeta from SolanaSimulator.extractTransactionMeta()
 * @param usdEstimate - Total USD value from SolanaSimulator.estimateUsdValue()
 * @param agentId - The agent that submitted the transaction
 * @param options - Optional overrides (slippage, assets)
 */
export function solanaToPolicyContext(
  sim: SimulationResult,
  meta: TransactionMeta,
  usdEstimate: number,
  agentId: string,
  options?: {
    slippagePct?: number;
    assetsAffected?: AssetDelta[];
  },
): BridgedPolicyInput {
  const rawPayload = sim.raw_chain_payload as SolanaSimulationPayload | null;

  // Build enriched SimulationResult with USD value and resolved counterparties
  const simulation: SimulationResult = {
    success: sim.success,
    chain: "solana",
    estimated_usd_value: usdEstimate,
    estimated_slippage_pct: options?.slippagePct ?? sim.estimated_slippage_pct,
    counterparties: meta.programIds,
    assets_affected: options?.assetsAffected ?? sim.assets_affected,
    raw_chain_payload: sim.raw_chain_payload,
    simulation_timestamp: sim.simulation_timestamp,
    error: sim.error,
  };

  // Build JSONB audit payload with all raw Solana-specific data
  const resolvedPrograms = resolveCounterparties(meta.programIds);
  const auditPayload: SolanaAuditPayload = {
    chain: "solana",
    logs: rawPayload?.logs ?? [],
    unitsConsumed: rawPayload?.unitsConsumed ?? 0,
    accountsAccessed: rawPayload?.accountsAccessed ?? meta.accounts,
    programIds: resolvedPrograms,
    signers: meta.signers,
    recentBlockhash: meta.recentBlockhash,
    numInstructions: meta.numInstructions,
    simulationError: rawPayload?.err ?? null,
  };

  return { simulation, auditPayload };
}
