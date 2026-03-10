// Devnet Test Setup — Shared utilities for live Solana devnet tests
// Requires HELIUS_API_KEY env var. All transactions are unsigned (pre-signing gate).

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../../src/db/database.js";
import { registerAgent } from "../../src/core/agent.js";
import { getPolicySet, insertPolicySet } from "../../src/db/queries.js";
import type { Agent, PolicySet } from "../../src/core/types.js";

// ─── Constants ─────────────────────────────────────────────────

export const HELIUS_API_KEY = process.env["HELIUS_API_KEY"] ?? "";
export const DEVNET_RPC_URL = `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// SOL mint on mainnet (used for Jupiter price lookups)
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// ─── Connection ────────────────────────────────────────────────

export function createDevnetConnection(): Connection {
  return new Connection(DEVNET_RPC_URL, "confirmed");
}

// ─── Airdrop ───────────────────────────────────────────────────

/**
 * Request a devnet airdrop and wait for confirmation.
 * Returns true on success, false if faucet is rate-limited or fails.
 */
export async function requestAirdrop(
  connection: Connection,
  publicKey: PublicKey,
  lamports: number = LAMPORTS_PER_SOL,
): Promise<boolean> {
  try {
    const signature = await connection.requestAirdrop(publicKey, lamports);
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed",
    );
    return true;
  } catch (err) {
    console.warn(
      `Airdrop failed (faucet may be rate-limited): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ─── Transaction Builders ──────────────────────────────────────

/**
 * Build a simple SOL transfer transaction (unsigned).
 * Returns the transaction as a base64-encoded serialized buffer.
 */
export async function buildSolTransfer(
  connection: Connection,
  from: PublicKey,
  to: PublicKey,
  lamports: number,
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash();

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;

  // Serialize WITHOUT signing — ClawSteward evaluates unsigned transactions
  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return serialized.toString("base64");
}

/**
 * Build a SOL transfer to a second random address (different counterparty).
 * Returns the transaction as a base64-encoded serialized buffer.
 */
export async function buildSecondTransfer(
  connection: Connection,
  from: PublicKey,
  lamports: number,
): Promise<string> {
  const recipient = Keypair.generate().publicKey;
  return buildSolTransfer(connection, from, recipient, lamports);
}

// ─── Test Database Setup ───────────────────────────────────────

export interface DevnetTestContext {
  db: Database.Database;
  agent: Agent;
  policySet: PolicySet;
}

/**
 * Create a fresh test database with a registered agent and default policy set.
 */
export function setupTestContext(signerAddress: string): DevnetTestContext {
  const db = createTestDatabase();

  const agent = registerAgent(db, {
    name: "devnet-test-agent",
    chain: "solana",
    signer_address: signerAddress,
  });

  const policySet = getPolicySet(db, "default")!;

  return { db, agent, policySet };
}

/**
 * Create a test database with a low-threshold policy set for triggering violations.
 */
export function setupStrictPolicyContext(signerAddress: string): DevnetTestContext {
  const db = createTestDatabase();

  const agent = registerAgent(db, {
    name: "strict-policy-agent",
    chain: "solana",
    signer_address: signerAddress,
  });

  // Insert a strict policy set with very low thresholds
  const strictPolicy: PolicySet = {
    id: "strict",
    name: "Strict Devnet Test Policy",
    version: 1,
    rules: [
      {
        id: "tiny-max-value",
        type: "max_usd_value",
        params: { max: 0.01 },
        severity: "critical",
        enabled: true,
      },
      {
        id: "slippage-guard",
        type: "max_slippage_pct",
        params: { max: 1.0 },
        severity: "high",
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
  };

  insertPolicySet(db, strictPolicy);
  const policySet = getPolicySet(db, "strict")!;

  return { db, agent, policySet };
}
