// ClawSteward MCP Tool Definitions — JSON Schema input definitions for all 5 tools.
// These are pure schema definitions with validation helpers. No business logic here.

import { z } from "zod";

// ─── Tool Input Schemas (Zod) ───────────────────────────────────

export const StewardEvaluateInputSchema = z.object({
  agent_id: z.string().min(1).describe("Agent UUIDv7 identifier"),
  raw_transaction_base64: z.string().min(1).describe("Base64-encoded unsigned Solana transaction"),
  chain: z.literal("solana").describe("Target chain (solana only in v1)"),
  policy_set_id: z.string().optional().describe("Policy set ID (defaults to 'default')"),
});

export const StewardRegisterInputSchema = z.object({
  name: z.string().min(1).describe("Human-readable agent name"),
  chain_signers: z
    .array(
      z.object({
        chain: z.literal("solana").describe("Chain identifier"),
        address: z.string().min(1).describe("Signer public key on this chain"),
      }),
    )
    .min(1)
    .describe("Chain signer addresses"),
  policy_set_id: z.string().optional().describe("Default policy set to associate"),
});

export const StewardScoreInputSchema = z.object({
  agent_id: z.string().min(1).describe("Agent UUIDv7 identifier"),
});

export const StewardLeaderboardInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(20).describe("Max results (default 20, max 200)"),
  min_score: z.number().min(0).max(10).optional().describe("Minimum Steward Score filter"),
});

export const StewardScanInputSchema = z.object({
  agent_id: z.string().min(1).describe("Agent UUIDv7 identifier to scan"),
  days: z.number().int().min(1).max(365).optional().default(30).describe("Lookback window in days (default 30)"),
});

// ─── Type Exports ───────────────────────────────────────────────

export type StewardEvaluateInput = z.infer<typeof StewardEvaluateInputSchema>;
export type StewardRegisterInput = z.infer<typeof StewardRegisterInputSchema>;
export type StewardScoreInput = z.infer<typeof StewardScoreInputSchema>;
export type StewardLeaderboardInput = z.infer<typeof StewardLeaderboardInputSchema>;
export type StewardScanInput = z.infer<typeof StewardScanInputSchema>;

// ─── Tool Metadata ──────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "steward_evaluate",
    description:
      "Submit an unsigned transaction for policy evaluation. Simulates the transaction against the target chain, evaluates against the agent's policy set, and returns approval/rejection with violations.",
    inputSchema: StewardEvaluateInputSchema,
  },
  {
    name: "steward_register",
    description:
      "Register a new agent with ClawSteward. Creates a UUIDv7 identity and associates chain signer addresses.",
    inputSchema: StewardRegisterInputSchema,
  },
  {
    name: "steward_score",
    description:
      "Query the Steward Score for an agent. Returns the 0-10 behavioral reputation score derived from the Steward Log.",
    inputSchema: StewardScoreInputSchema,
  },
  {
    name: "steward_leaderboard",
    description:
      "Get top agents ranked by Steward Score. Returns the Steward Leaderboard with scores, evaluation counts, and violation rates.",
    inputSchema: StewardLeaderboardInputSchema,
  },
  {
    name: "steward_scan",
    description:
      "Scan an agent's recent evaluation history. Returns violation breakdown, compliance trends, and risk assessment over the lookback window.",
    inputSchema: StewardScanInputSchema,
  },
] as const;
