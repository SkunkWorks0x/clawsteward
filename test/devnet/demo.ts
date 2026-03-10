#!/usr/bin/env npx tsx
// ClawSteward Live Demo — Solana Devnet
// Run with: pnpm demo:devnet
// Requires: HELIUS_API_KEY environment variable

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";

import { SolanaSimulator } from "../../src/chain/solana-adapter.js";
import { solanaToPolicyContext } from "../../src/chain/solana-policy-bridge.js";
import { registerAgent } from "../../src/core/agent.js";
import { evaluatePolicy } from "../../src/core/policy-engine.js";
import { appendToStewardLog, verifyStewardLog } from "../../src/core/audit-log.js";
import { computeStewardScore } from "../../src/core/reputation.js";
import { generateStewardReport } from "../../src/core/report.js";
import { getPolicySet, insertPolicySet, upsertStewardScore } from "../../src/db/queries.js";
import type { PolicySet } from "../../src/core/types.js";
import type { RuleContext } from "../../src/core/policy-rules.js";

// ─── Config ────────────────────────────────────────────────────

const HELIUS_API_KEY = process.env["HELIUS_API_KEY"];
if (!HELIUS_API_KEY) {
  console.error("ERROR: HELIUS_API_KEY environment variable is required.");
  console.error("Get a free key at https://www.helius.dev/");
  process.exit(1);
}

const DEVNET_RPC_URL = `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const DB_PATH = "/tmp/clawsteward-demo.db";

// ─── Colors ────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const orange = (s: string) => `\x1b[38;5;208m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function scoreColor(score: number | null): string {
  if (score === null) return dim("N/A");
  if (score >= 8) return green(score.toFixed(1));
  if (score >= 5) return yellow(score.toFixed(1));
  return red(score.toFixed(1));
}

// ─── Helpers ───────────────────────────────────────────────────

async function buildSolTransfer(
  connection: Connection,
  from: Keypair,
  toAddress: string,
  lamports: number,
): Promise<string> {
  const { Transaction, SystemProgram, PublicKey } = await import("@solana/web3.js");
  const { blockhash } = await connection.getLatestBlockhash();

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = from.publicKey;

  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

function createDemoDatabase(): Database.Database {
  // Remove existing demo DB if present
  try { unlinkSync(DB_PATH); } catch { /* ignore */ }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const __dir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(__dir, "../../src/db/schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  return db;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(orange("╔══════════════════════════════════════════════════════╗"));
  console.log(orange("║") + bold("   ClawSteward Live Demo — Solana Devnet             ") + orange("║"));
  console.log(orange("║") + dim("   Pre-signing policy enforcement for DeFAI agents    ") + orange("║"));
  console.log(orange("╚══════════════════════════════════════════════════════╝"));
  console.log("");

  // 1. Setup
  console.log(bold("1. Setting up..."));
  const db = createDemoDatabase();
  const connection = new Connection(DEVNET_RPC_URL, "confirmed");
  const simulator = new SolanaSimulator({ heliusRpcUrl: DEVNET_RPC_URL });

  // 2. Generate test keypair and request airdrop
  const wallet = Keypair.generate();
  const recipient1 = Keypair.generate();
  const recipient2 = Keypair.generate();

  console.log(`   Wallet: ${dim(wallet.publicKey.toBase58())}`);
  console.log(`   Requesting devnet airdrop...`);

  try {
    const sig = await connection.requestAirdrop(
      wallet.publicKey,
      LAMPORTS_PER_SOL,
    );
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: sig, ...latestBlockhash },
      "confirmed",
    );
    console.log(`   ${green("Airdrop confirmed")} (1 SOL)`);
  } catch (err) {
    console.error(`   ${red("Airdrop failed")} — devnet faucet may be rate-limited`);
    console.error(`   Try again in a few minutes or use a different Helius key.`);
    cleanup(db);
    process.exit(1);
  }

  // 3. Register agent
  console.log("");
  console.log(bold("2. Registering demo agent..."));
  const agent = registerAgent(db, {
    name: "demo-agent",
    chain: "solana",
    signer_address: wallet.publicKey.toBase58(),
  });
  console.log(`   Agent ID: ${dim(agent.id)}`);
  console.log(`   Name: demo-agent`);

  // 4. Load demo policy set with realistic thresholds
  const demoPolicy: PolicySet = {
    id: "demo",
    name: "Demo Policy",
    version: 1,
    rules: [
      {
        id: "max-value",
        type: "max_usd_value",
        params: { max: 50 }, // $50 max per tx
        severity: "critical",
        enabled: true,
      },
      {
        id: "slippage",
        type: "max_slippage_pct",
        params: { max: 5.0 },
        severity: "high",
        enabled: true,
      },
      {
        id: "hourly-limit",
        type: "velocity_1h_count",
        params: { max: 10 },
        severity: "medium",
        enabled: true,
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  insertPolicySet(db, demoPolicy);
  console.log(`   Policy: ${demoPolicy.name} (max $50/tx)`);

  // 5. Evaluate transactions
  console.log("");
  console.log(bold("3. Evaluating transactions..."));
  console.log("");

  const transactions = [
    {
      label: "Small SOL transfer (0.001 SOL)",
      lamports: LAMPORTS_PER_SOL / 1000,
      usdEstimate: 0.15, // ~$150 SOL price × 0.001
      recipient: recipient1.publicKey.toBase58(),
      expectPass: true,
    },
    {
      label: "Large SOL transfer (0.5 SOL)",
      lamports: LAMPORTS_PER_SOL / 2,
      usdEstimate: 75.0, // Exceeds $50 max
      recipient: recipient2.publicKey.toBase58(),
      expectPass: false,
    },
    {
      label: "Medium SOL transfer (0.01 SOL)",
      lamports: LAMPORTS_PER_SOL / 100,
      usdEstimate: 1.5,
      recipient: recipient1.publicKey.toBase58(),
      expectPass: true,
    },
  ];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i]!;
    console.log(`   ${bold(`TX ${i + 1}:`)} ${tx.label}`);

    // Build unsigned transaction
    const txBase64 = await buildSolTransfer(
      connection,
      wallet,
      tx.recipient,
      tx.lamports,
    );

    // Simulate
    const simResult = await simulator.simulate(txBase64, {
      agent_id: agent.id,
      rpc_url: DEVNET_RPC_URL,
    });

    if (!simResult.success) {
      console.log(`   ${red("SIMULATION FAILED")}: ${simResult.error}`);
      continue;
    }

    // Bridge to policy context
    const meta = simulator.extractTransactionMeta(txBase64);
    const bridged = solanaToPolicyContext(
      simResult,
      meta,
      tx.usdEstimate,
      agent.id,
    );

    // Evaluate policy
    const ruleCtx: RuleContext = {
      volume_24h_usd: 0,
      tx_count_1h: i,
      consecutive_violations: 0,
      portfolio_positions: {},
      agent_paused: false,
    };

    const policy = getPolicySet(db, "demo")!;
    const evalResult = evaluatePolicy(policy, bridged.simulation, ruleCtx);
    const action = evalResult.passed ? "approve" : "reject";

    // Log
    appendToStewardLog(db, {
      agent_id: agent.id,
      chain: "solana",
      action: action as "approve" | "reject",
      policy_set_id: "demo",
      rules_evaluated: evalResult.rules_evaluated,
      violations: evalResult.violations,
      compliance_score_delta: evalResult.passed ? 0 : -1,
      estimated_usd_value: tx.usdEstimate,
      estimated_slippage_pct: 0,
      counterparties: simResult.counterparties,
      chain_payload: bridged.auditPayload,
    });

    // Score
    const score = computeStewardScore(db, agent.id);
    upsertStewardScore(db, score);

    if (evalResult.passed) {
      console.log(`   Result: ${green("APPROVED")}`);
    } else {
      console.log(`   Result: ${red("REJECTED")}`);
      for (const v of evalResult.violations) {
        console.log(`     - [${v.severity}] ${v.message}`);
      }
    }
    console.log(`   Steward Score: ${scoreColor(score.score)}/10.0`);
    console.log("");
  }

  // 6. Seed additional entries for a meaningful score (need ≥10)
  console.log(bold("4. Seeding additional evaluations for score calculation..."));
  for (let i = 0; i < 9; i++) {
    appendToStewardLog(db, {
      agent_id: agent.id,
      chain: "solana",
      action: "approve",
      policy_set_id: "demo",
      rules_evaluated: 3,
      violations: [],
      compliance_score_delta: 0,
      estimated_usd_value: 1.0,
      estimated_slippage_pct: 0,
      counterparties: ["11111111111111111111111111111111"],
    });
  }

  const finalScore = computeStewardScore(db, agent.id);
  upsertStewardScore(db, finalScore);

  console.log(`   Added 9 additional passing evaluations`);
  console.log(`   Total evaluations: ${finalScore.total_evaluations}`);
  console.log(`   Final Steward Score: ${scoreColor(finalScore.score)}/10.0`);
  console.log("");

  // 7. Generate report
  console.log(bold("5. Generating Steward Report..."));
  const report = generateStewardReport(agent.id, db);
  if (report) {
    // Print first 30 lines of the report
    const lines = report.split("\n");
    for (const line of lines.slice(0, 30)) {
      console.log(`   ${dim(line)}`);
    }
    if (lines.length > 30) {
      console.log(`   ${dim(`... (${lines.length - 30} more lines)`)}`);
    }
  }
  console.log("");

  // 8. Hash chain integrity
  console.log(bold("6. Verifying Steward Log integrity..."));
  const verification = verifyStewardLog(db);
  if (verification.valid) {
    console.log(
      `   ${green("PASS")} — ${verification.entries_checked} entries, hash chain intact`,
    );
  } else {
    console.log(`   ${red("FAIL")} — ${verification.error}`);
  }

  // Cleanup
  console.log("");
  cleanup(db);
  console.log(orange("Demo complete."));
  console.log("");
}

function cleanup(db: Database.Database) {
  try {
    db.close();
    unlinkSync(DB_PATH);
    // Also remove WAL and SHM files if they exist
    try { unlinkSync(DB_PATH + "-wal"); } catch { /* ignore */ }
    try { unlinkSync(DB_PATH + "-shm"); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

main().catch((err) => {
  console.error(red(`Demo failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
