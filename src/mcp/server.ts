// ClawSteward MCP Server — Policy gate + reputation read endpoints
// Uses @modelcontextprotocol/sdk McpServer with stdio transport for local use.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

import {
  StewardEvaluateInputSchema,
  StewardRegisterInputSchema,
  StewardScoreInputSchema,
  StewardLeaderboardInputSchema,
  StewardScanInputSchema,
  type StewardEvaluateInput,
  type StewardRegisterInput,
  type StewardScoreInput,
  type StewardLeaderboardInput,
  type StewardScanInput,
} from "./tools.js";
import { registerAgent, getAgent } from "../core/agent.js";
import {
  getLeaderboard,
  getStewardScore,
  getLogEntriesByAgent,
  getLogEntriesSince,
} from "../db/queries.js";

// ─── Server Version ─────────────────────────────────────────────

const SERVER_NAME = "clawsteward";
const SERVER_VERSION = "0.1.0";

// ─── Result Helpers ─────────────────────────────────────────────

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ─── Server Factory ─────────────────────────────────────────────

export interface CreateServerOptions {
  db: Database.Database;
}

/**
 * Create and configure the ClawSteward MCP server with all 5 tools registered.
 * Does NOT connect a transport — call `server.connect(transport)` separately.
 */
export function createMcpServer(options: CreateServerOptions): McpServer {
  const { db } = options;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── steward_evaluate ───────────────────────────────────────────

  server.registerTool(
    "steward_evaluate",
    {
      description:
        "Submit an unsigned transaction for policy evaluation. Simulates the transaction against the target chain, evaluates against the agent's policy set, and returns approval/rejection with violations.",
      inputSchema: StewardEvaluateInputSchema,
    },
    async (args: StewardEvaluateInput): Promise<CallToolResult> => {
      try {
        const agent = getAgent(db, args.agent_id);
        if (!agent) {
          return errorResult(`Agent not found: ${args.agent_id}`);
        }

        if (agent.is_paused) {
          return errorResult(`Agent ${args.agent_id} is paused due to policy violations`);
        }

        if (args.chain !== "solana") {
          return errorResult(`Unsupported chain: ${args.chain}. Only 'solana' is supported in v1.`);
        }

        // Placeholder: full simulation + policy evaluation pipeline will be wired
        // when the orchestration layer (handlers.ts) is built.
        // For now, return structured acknowledgment.
        return jsonResult({
          status: "received",
          agent_id: args.agent_id,
          chain: args.chain,
          policy_set_id: args.policy_set_id ?? "default",
          message: "Transaction queued for evaluation",
        });
      } catch (err) {
        return errorResult(
          `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ─── steward_register ──────────────────────────────────────────

  server.registerTool(
    "steward_register",
    {
      description:
        "Register a new agent with ClawSteward. Creates a UUIDv7 identity and associates chain signer addresses.",
      inputSchema: StewardRegisterInputSchema,
    },
    async (args: StewardRegisterInput): Promise<CallToolResult> => {
      try {
        // Use first chain signer for primary registration
        const primarySigner = args.chain_signers[0]!;

        const agent = registerAgent(db, {
          name: args.name,
          chain: primarySigner.chain,
          signer_address: primarySigner.address,
          metadata: args.policy_set_id ? { default_policy_set: args.policy_set_id } : {},
        });

        return jsonResult({
          agent_id: agent.id,
          name: agent.name,
          chain_signers: agent.chain_signers,
          registered_at: agent.registered_at,
          registered: true,
        });
      } catch (err) {
        return errorResult(
          `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ─── steward_score ──────────────────────────────────────────────

  server.registerTool(
    "steward_score",
    {
      description:
        "Query the Steward Score for an agent. Returns the 0-10 behavioral reputation score derived from the Steward Log.",
      inputSchema: StewardScoreInputSchema,
    },
    async (args: StewardScoreInput): Promise<CallToolResult> => {
      try {
        const agent = getAgent(db, args.agent_id);
        if (!agent) {
          return errorResult(`Agent not found: ${args.agent_id}`);
        }

        const score = getStewardScore(db, args.agent_id);
        if (!score) {
          return jsonResult({
            agent_id: args.agent_id,
            agent_name: agent.name,
            score: null,
            message: "Insufficient evaluation data (< 10 evaluations)",
          });
        }

        return jsonResult({
          agent_id: score.agent_id,
          agent_name: agent.name,
          score: score.score,
          total_evaluations: score.total_evaluations,
          total_violations: score.total_violations,
          violation_rate: score.violation_rate,
          critical_violations_30d: score.critical_violations_30d,
          last_evaluation: score.last_evaluation,
          score_trend: score.score_trend,
          computed_at: score.computed_at,
        });
      } catch (err) {
        return errorResult(
          `Score query failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ─── steward_leaderboard ────────────────────────────────────────

  server.registerTool(
    "steward_leaderboard",
    {
      description:
        "Get top agents ranked by Steward Score. Returns the Steward Leaderboard with scores, evaluation counts, and violation rates.",
      inputSchema: StewardLeaderboardInputSchema,
    },
    async (args: StewardLeaderboardInput): Promise<CallToolResult> => {
      try {
        const limit = args.limit ?? 20;
        const scores = getLeaderboard(db, limit, 10);

        // Filter by min_score if provided
        const filtered = args.min_score != null
          ? scores.filter((s) => s.score != null && s.score >= args.min_score!)
          : scores;

        const agents = filtered.map((s, index) => ({
          rank: index + 1,
          agent_id: s.agent_id,
          score: s.score,
          total_evaluations: s.total_evaluations,
          violation_rate: s.violation_rate,
          score_trend: s.score_trend,
          last_evaluation: s.last_evaluation,
        }));

        return jsonResult({
          leaderboard: agents,
          total: agents.length,
          limit,
        });
      } catch (err) {
        return errorResult(
          `Leaderboard query failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ─── steward_scan ───────────────────────────────────────────────

  server.registerTool(
    "steward_scan",
    {
      description:
        "Scan an agent's recent evaluation history. Returns violation breakdown, compliance trends, and risk assessment over the lookback window.",
      inputSchema: StewardScanInputSchema,
    },
    async (args: StewardScanInput): Promise<CallToolResult> => {
      try {
        const agent = getAgent(db, args.agent_id);
        if (!agent) {
          return errorResult(`Agent not found: ${args.agent_id}`);
        }

        const days = args.days ?? 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const entries = getLogEntriesSince(db, args.agent_id, since);

        const totalEvals = entries.length;
        const approvals = entries.filter((e) => e.action === "approve").length;
        const rejections = entries.filter((e) => e.action === "reject").length;
        const errors = entries.filter((e) => e.action === "error").length;

        // Aggregate violations by rule type
        const violationsByType: Record<string, number> = {};
        for (const entry of entries) {
          for (const v of entry.violations) {
            violationsByType[v.rule_type] = (violationsByType[v.rule_type] ?? 0) + 1;
          }
        }

        // Aggregate by severity
        const violationsBySeverity: Record<string, number> = {};
        for (const entry of entries) {
          for (const v of entry.violations) {
            violationsBySeverity[v.severity] = (violationsBySeverity[v.severity] ?? 0) + 1;
          }
        }

        return jsonResult({
          agent_id: args.agent_id,
          agent_name: agent.name,
          scan_window_days: days,
          total_evaluations: totalEvals,
          approvals,
          rejections,
          errors,
          compliance_rate: totalEvals > 0 ? Number(((approvals / totalEvals) * 100).toFixed(1)) : null,
          violations_by_type: violationsByType,
          violations_by_severity: violationsBySeverity,
          is_paused: agent.is_paused,
        });
      } catch (err) {
        return errorResult(
          `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  return server;
}

// ─── Stdio Entry Point ──────────────────────────────────────────

/**
 * Start the MCP server on stdio transport.
 * Call this from the CLI `clawsteward serve` command.
 */
export async function startStdioServer(db: Database.Database): Promise<void> {
  const server = createMcpServer({ db });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
