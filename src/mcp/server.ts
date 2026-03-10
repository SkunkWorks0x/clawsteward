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
import type { ChainSimulator } from "../chain/simulator.js";
import {
  handleEvaluate,
  handleRegister,
  handleScore,
  handleLeaderboard,
  handleScan,
  type HandlerDeps,
} from "./handlers.js";

// ─── Server Version ─────────────────────────────────────────────

const SERVER_NAME = "clawsteward";
const SERVER_VERSION = "0.1.0";

// ─── Server Factory ─────────────────────────────────────────────

export interface CreateServerOptions {
  db: Database.Database;
  getSimulator?: (chain: string) => ChainSimulator | undefined;
}

/**
 * Create and configure the ClawSteward MCP server with all 5 tools registered.
 * Does NOT connect a transport — call `server.connect(transport)` separately.
 *
 * @param options.db - Database connection
 * @param options.getSimulator - Factory to get a ChainSimulator by chain name.
 *   Defaults to returning undefined (no simulator). Inject mocks for testing.
 */
export function createMcpServer(options: CreateServerOptions): McpServer {
  const { db, getSimulator = () => undefined } = options;

  const deps: HandlerDeps = { db, getSimulator };

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
      return handleEvaluate(deps, args);
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
      return handleRegister(deps, args);
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
      return handleScore(deps, args);
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
      return handleLeaderboard(deps, args);
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
      return handleScan(deps, args);
    },
  );

  return server;
}

// ─── Stdio Entry Point ──────────────────────────────────────────

/**
 * Start the MCP server on stdio transport.
 * Call this from the CLI `clawsteward serve` command.
 */
export async function startStdioServer(
  db: Database.Database,
  getSimulator?: (chain: string) => ChainSimulator | undefined,
): Promise<void> {
  const server = createMcpServer({ db, getSimulator });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
