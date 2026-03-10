// ClawSteward MCP Handlers — Business logic for all 5 tool handlers.
// Each handler: validate input → execute → return typed JSON.
// Errors return { error: string, code: string }.

import type Database from "better-sqlite3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  StewardEvaluateInput,
  StewardRegisterInput,
  StewardScoreInput,
  StewardLeaderboardInput,
  StewardScanInput,
} from "./tools.js";
import type { ChainSimulator } from "../chain/simulator.js";
import type { PolicyViolation, SimulationResult, StewardScore } from "../core/types.js";
import type { RuleContext } from "../core/policy-rules.js";
import { solanaToPolicyContext } from "../chain/solana-policy-bridge.js";
import { registerAgent, getAgent, updateAgentPausedState } from "../core/agent.js";
import { evaluatePolicy } from "../core/policy-engine.js";
import { appendToStewardLog } from "../core/audit-log.js";
import { computeStewardScore, computeStewardScoreFromEntries } from "../core/reputation.js";
import {
  getPolicySet,
  getLeaderboard,
  getLogEntriesByAgent,
  getLogEntriesSince,
  getConsecutiveViolations,
  upsertStewardScore,
  getAgent as getAgentQuery,
} from "../db/queries.js";

// ─── Error Codes ────────────────────────────────────────────────

export const ErrorCode = {
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  AGENT_PAUSED: "AGENT_PAUSED",
  POLICY_SET_NOT_FOUND: "POLICY_SET_NOT_FOUND",
  SIMULATION_FAILED: "SIMULATION_FAILED",
  UNSUPPORTED_CHAIN: "UNSUPPORTED_CHAIN",
  INVALID_INPUT: "INVALID_INPUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// ─── Result Helpers ─────────────────────────────────────────────

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(
  message: string,
  code: string,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

// ─── Handler Dependencies ───────────────────────────────────────

export interface HandlerDeps {
  db: Database.Database;
  getSimulator: (chain: string) => ChainSimulator | undefined;
}

// ─── handleEvaluate ─────────────────────────────────────────────

export async function handleEvaluate(
  deps: HandlerDeps,
  args: StewardEvaluateInput,
): Promise<CallToolResult> {
  const { db, getSimulator } = deps;

  try {
    // 1. Look up agent
    const agent = getAgent(db, args.agent_id);
    if (!agent) {
      return errorResult(
        `Agent not found: ${args.agent_id}`,
        ErrorCode.AGENT_NOT_FOUND,
      );
    }

    // 2. Check paused
    if (agent.is_paused) {
      return errorResult(
        `Agent ${args.agent_id} is paused due to policy violations`,
        ErrorCode.AGENT_PAUSED,
      );
    }

    // 3. Validate chain
    if (args.chain !== "solana") {
      return errorResult(
        `Unsupported chain: ${args.chain}. Only 'solana' is supported in v1.`,
        ErrorCode.UNSUPPORTED_CHAIN,
      );
    }

    // 4. Get simulator
    const simulator = getSimulator(args.chain);
    if (!simulator) {
      return errorResult(
        `No simulator available for chain: ${args.chain}`,
        ErrorCode.SIMULATION_FAILED,
      );
    }

    // 5. Get policy set
    const policySetId = args.policy_set_id ?? "default";
    const policySet = getPolicySet(db, policySetId);
    if (!policySet) {
      return errorResult(
        `Policy set not found: ${policySetId}`,
        ErrorCode.POLICY_SET_NOT_FOUND,
      );
    }

    // 6. Simulate transaction
    const rpcUrl = simulator.chain === "solana"
      ? (process.env["SOLANA_RPC_URL"] ?? "")
      : "";

    let simResult: SimulationResult;
    try {
      simResult = await simulator.simulate(args.raw_transaction_base64, {
        agent_id: args.agent_id,
        rpc_url: rpcUrl,
      });
    } catch (err) {
      return errorResult(
        `Simulation failed: ${err instanceof Error ? err.message : String(err)}`,
        ErrorCode.SIMULATION_FAILED,
      );
    }

    if (!simResult.success && simResult.error) {
      return errorResult(
        `Simulation failed: ${simResult.error}`,
        ErrorCode.SIMULATION_FAILED,
      );
    }

    // 7. Bridge simulation to policy context
    // Extract meta from the simulator if it's a Solana adapter
    const bridged = solanaToPolicyContext(
      simResult,
      {
        programIds: simResult.counterparties,
        accounts: [],
        signers: [],
        recentBlockhash: "",
        numInstructions: 0,
      },
      simResult.estimated_usd_value,
      args.agent_id,
    );

    // 8. Build rule context from historical data
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentEntries24h = getLogEntriesSince(db, args.agent_id, oneDayAgo);
    const recentEntries1h = getLogEntriesSince(db, args.agent_id, oneHourAgo);

    const autoPauseRule = policySet.rules.find(
      (r) => r.type === "auto_pause_consecutive_violations" && r.enabled,
    );
    const windowMinutes = autoPauseRule
      ? (autoPauseRule.params["window_minutes"] as number) ?? 60
      : 60;

    const ruleContext: RuleContext = {
      volume_24h_usd: recentEntries24h.reduce(
        (sum, e) => sum + (e.estimated_usd_value ?? 0),
        0,
      ),
      tx_count_1h: recentEntries1h.length,
      consecutive_violations: getConsecutiveViolations(
        db,
        args.agent_id,
        windowMinutes,
      ),
      portfolio_positions: {},
      agent_paused: agent.is_paused,
    };

    // 9. Evaluate policy
    const evaluation = evaluatePolicy(
      policySet,
      bridged.simulation,
      ruleContext,
    );

    const action = evaluation.passed ? "approve" : "reject";

    // 10. Append to Steward Log
    const logEntry = appendToStewardLog(db, {
      agent_id: args.agent_id,
      chain: args.chain,
      action,
      policy_set_id: policySetId,
      rules_evaluated: evaluation.rules_evaluated,
      violations: evaluation.violations,
      compliance_score_delta: evaluation.passed ? 0 : -1,
      estimated_usd_value: bridged.simulation.estimated_usd_value,
      estimated_slippage_pct: bridged.simulation.estimated_slippage_pct,
      counterparties: bridged.simulation.counterparties,
      chain_payload: bridged.auditPayload,
    });

    // 11. Check auto-pause: if this rejection pushes consecutive violations past threshold
    if (!evaluation.passed && autoPauseRule) {
      const threshold = autoPauseRule.params["threshold"] as number;
      const newConsecutive = getConsecutiveViolations(
        db,
        args.agent_id,
        windowMinutes,
      );
      if (newConsecutive >= threshold) {
        updateAgentPausedState(db, args.agent_id, true);
      }
    }

    // 12. Recompute Steward Score and cache it
    const stewardScore = computeStewardScore(db, args.agent_id);
    upsertStewardScore(db, stewardScore);

    return jsonResult({
      approved: evaluation.passed,
      violations: evaluation.violations,
      simulation: {
        usd_value: bridged.simulation.estimated_usd_value,
        slippage_pct: bridged.simulation.estimated_slippage_pct,
        counterparties: bridged.simulation.counterparties,
      },
      steward_score: stewardScore.score,
      evaluation_id: logEntry.id,
    });
  } catch (err) {
    return errorResult(
      `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ─── handleRegister ─────────────────────────────────────────────

export function handleRegister(
  deps: HandlerDeps,
  args: StewardRegisterInput,
): CallToolResult {
  const { db } = deps;

  try {
    const primarySigner = args.chain_signers[0]!;

    const agent = registerAgent(db, {
      name: args.name,
      chain: primarySigner.chain,
      signer_address: primarySigner.address,
      metadata: args.policy_set_id
        ? { default_policy_set: args.policy_set_id }
        : {},
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
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ─── handleScore ────────────────────────────────────────────────

export function handleScore(
  deps: HandlerDeps,
  args: StewardScoreInput,
): CallToolResult {
  const { db } = deps;

  try {
    const agent = getAgent(db, args.agent_id);
    if (!agent) {
      return errorResult(
        `Agent not found: ${args.agent_id}`,
        ErrorCode.AGENT_NOT_FOUND,
      );
    }

    // Compute score from audit log (live, not cached)
    const score = computeStewardScore(db, args.agent_id);

    // Determine badge
    const badge = score.score !== null && score.score >= 8
      ? "ClawSteward-verified"
      : score.score !== null && score.score >= 5
        ? "Under Review"
        : score.score !== null
          ? "High Risk"
          : "Insufficient Data";

    return jsonResult({
      agent_id: score.agent_id,
      name: agent.name,
      score: score.score,
      total_evaluations: score.total_evaluations,
      total_violations: score.total_violations,
      violation_rate: score.violation_rate,
      critical_violations_30d: score.critical_violations_30d,
      last_evaluation: score.last_evaluation,
      score_trend: score.score_trend,
      badge,
      computed_at: score.computed_at,
    });
  } catch (err) {
    return errorResult(
      `Score query failed: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ─── handleLeaderboard ──────────────────────────────────────────

export function handleLeaderboard(
  deps: HandlerDeps,
  args: StewardLeaderboardInput,
): CallToolResult {
  const { db } = deps;

  try {
    const limit = args.limit ?? 20;
    const scores = getLeaderboard(db, limit, 10);

    // Filter by min_score if provided
    const filtered =
      args.min_score != null
        ? scores.filter((s) => s.score != null && s.score >= args.min_score!)
        : scores;

    // Look up agent names and build ranked list
    const agents = filtered.map((s, index) => {
      const agent = getAgentQuery(db, s.agent_id);
      const badge = s.score !== null && s.score >= 8
        ? "ClawSteward-verified"
        : s.score !== null && s.score >= 5
          ? "Under Review"
          : "High Risk";

      return {
        rank: index + 1,
        agent_id: s.agent_id,
        name: agent?.name ?? "Unknown",
        score: s.score,
        total_evaluations: s.total_evaluations,
        violation_rate: s.violation_rate,
        score_trend: s.score_trend,
        badge,
        last_evaluation: s.last_evaluation,
      };
    });

    return jsonResult({
      leaderboard: agents,
      total: agents.length,
      limit,
    });
  } catch (err) {
    return errorResult(
      `Leaderboard query failed: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ─── handleScan ─────────────────────────────────────────────────

export function handleScan(
  deps: HandlerDeps,
  args: StewardScanInput,
): CallToolResult {
  const { db } = deps;

  try {
    const agent = getAgent(db, args.agent_id);
    if (!agent) {
      return errorResult(
        `Agent not found: ${args.agent_id}`,
        ErrorCode.AGENT_NOT_FOUND,
      );
    }

    const days = args.days ?? 30;
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const entries = getLogEntriesSince(db, args.agent_id, since);

    const totalEvals = entries.length;
    const approvals = entries.filter((e) => e.action === "approve").length;
    const rejections = entries.filter((e) => e.action === "reject").length;
    const errors = entries.filter((e) => e.action === "error").length;

    // Violation breakdown by severity
    const violationBreakdown: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const entry of entries) {
      for (const v of entry.violations) {
        violationBreakdown[v.severity] =
          (violationBreakdown[v.severity] ?? 0) + 1;
      }
    }

    // Violation breakdown by rule type
    const violationsByType: Record<string, number> = {};
    for (const entry of entries) {
      for (const v of entry.violations) {
        violationsByType[v.rule_type] =
          (violationsByType[v.rule_type] ?? 0) + 1;
      }
    }

    // Score history: compute score at different points in time
    // Take up to 5 snapshots evenly spread across the window
    const scoreHistory: Array<{ date: string; score: number | null }> = [];
    const allEntries = getLogEntriesByAgent(db, args.agent_id);
    if (allEntries.length > 0) {
      const snapshotCount = Math.min(5, days);
      const interval = Math.floor(days / snapshotCount);
      for (let i = 0; i < snapshotCount; i++) {
        const snapshotDaysAgo = days - i * interval;
        const snapshotDate = new Date(
          Date.now() - snapshotDaysAgo * 24 * 60 * 60 * 1000,
        );
        const entriesAtSnapshot = allEntries.filter(
          (e) => new Date(e.timestamp) <= snapshotDate,
        );
        if (entriesAtSnapshot.length >= 10) {
          const snap = computeStewardScoreFromEntries(
            args.agent_id,
            entriesAtSnapshot,
            snapshotDate,
          );
          scoreHistory.push({
            date: snapshotDate.toISOString().split("T")[0]!,
            score: snap.score,
          });
        }
      }
    }

    // Recent entries (last 10)
    const recentEntries = entries.slice(0, 10).map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      action: e.action,
      estimated_usd_value: e.estimated_usd_value,
      violations_count: e.violations.length,
    }));

    return jsonResult({
      agent_id: args.agent_id,
      name: agent.name,
      summary: {
        total_evaluations: totalEvals,
        approvals,
        rejections,
        errors,
        approval_rate:
          totalEvals > 0
            ? Number(((approvals / totalEvals) * 100).toFixed(1))
            : null,
      },
      violation_breakdown_by_severity: violationBreakdown,
      violations_by_type: violationsByType,
      score_history: scoreHistory,
      recent_entries: recentEntries,
      is_paused: agent.is_paused,
      scan_window_days: days,
    });
  } catch (err) {
    return errorResult(
      `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.INTERNAL_ERROR,
    );
  }
}
