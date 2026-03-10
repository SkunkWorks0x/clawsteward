// ClawSteward Policy Rules — Individual rule evaluator functions
// Each rule evaluates a SimulationResult against chain-abstract params.
// Rules NEVER receive chain-specific data (lamports, compute units, etc).

import type { PolicyRule, PolicyViolation, SimulationResult } from "./types.js";

/**
 * Historical context needed by stateful rules (velocity, auto_pause).
 * Provided by the policy engine from the database.
 */
export interface RuleContext {
  /** Rolling 24h USD volume for this agent */
  volume_24h_usd: number;
  /** Transaction count in the last hour for this agent */
  tx_count_1h: number;
  /** Consecutive violations in the given window for this agent */
  consecutive_violations: number;
  /** Agent's current portfolio positions: asset → USD value */
  portfolio_positions: Record<string, number>;
  /** Whether the agent is currently paused */
  agent_paused: boolean;
}

export type RuleEvaluator = (
  rule: PolicyRule,
  sim: SimulationResult,
  ctx: RuleContext,
) => PolicyViolation | null;

// ─── Rule Evaluators ───────────────────────────────────────────────

export function evaluateMaxUsdValue(
  rule: PolicyRule,
  sim: SimulationResult,
): PolicyViolation | null {
  const max = rule.params["max"] as number;
  if (sim.estimated_usd_value > max) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Transaction value $${sim.estimated_usd_value.toFixed(2)} exceeds maximum $${max.toFixed(2)}`,
      actual_value: sim.estimated_usd_value,
      threshold_value: max,
    };
  }
  return null;
}

export function evaluateMaxSlippagePct(
  rule: PolicyRule,
  sim: SimulationResult,
): PolicyViolation | null {
  const max = rule.params["max"] as number;
  if (sim.estimated_slippage_pct > max) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Slippage ${sim.estimated_slippage_pct.toFixed(2)}% exceeds maximum ${max.toFixed(2)}%`,
      actual_value: sim.estimated_slippage_pct,
      threshold_value: max,
    };
  }
  return null;
}

export function evaluateVelocity24hUsd(
  rule: PolicyRule,
  sim: SimulationResult,
  ctx: RuleContext,
): PolicyViolation | null {
  const max = rule.params["max"] as number;
  const projected = ctx.volume_24h_usd + sim.estimated_usd_value;
  if (projected > max) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `24h volume $${projected.toFixed(2)} (including this tx) exceeds cap $${max.toFixed(2)}`,
      actual_value: projected,
      threshold_value: max,
    };
  }
  return null;
}

export function evaluateVelocity1hCount(
  rule: PolicyRule,
  _sim: SimulationResult,
  ctx: RuleContext,
): PolicyViolation | null {
  const max = rule.params["max"] as number;
  // The current tx would be count + 1
  const projected = ctx.tx_count_1h + 1;
  if (projected > max) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Hourly tx count ${projected} (including this tx) exceeds limit ${max}`,
      actual_value: projected,
      threshold_value: max,
    };
  }
  return null;
}

export function evaluateBlacklistCounterparties(
  rule: PolicyRule,
  sim: SimulationResult,
): PolicyViolation | null {
  const blacklist = rule.params["addresses"] as string[];
  if (!blacklist || blacklist.length === 0) return null;

  const blacklistSet = new Set(blacklist);
  const matched = sim.counterparties.filter((cp) => blacklistSet.has(cp));

  if (matched.length > 0) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Transaction involves blacklisted counterpart${matched.length > 1 ? "ies" : "y"}: ${matched.join(", ")}`,
      actual_value: matched.join(", "),
      threshold_value: "none allowed",
    };
  }
  return null;
}

export function evaluateWhitelistPrograms(
  rule: PolicyRule,
  sim: SimulationResult,
): PolicyViolation | null {
  const whitelist = rule.params["programs"] as string[];
  if (!whitelist || whitelist.length === 0) return null;

  const whitelistSet = new Set(whitelist);
  const unauthorized = sim.counterparties.filter((cp) => !whitelistSet.has(cp));

  if (unauthorized.length > 0) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Transaction involves unauthorized program${unauthorized.length > 1 ? "s" : ""}: ${unauthorized.join(", ")}`,
      actual_value: unauthorized.join(", "),
      threshold_value: `allowed: ${whitelist.join(", ")}`,
    };
  }
  return null;
}

export function evaluateConcentrationPct(
  rule: PolicyRule,
  sim: SimulationResult,
  ctx: RuleContext,
): PolicyViolation | null {
  const maxPct = rule.params["max"] as number;

  // Calculate total portfolio value including this transaction's effects
  const positions = { ...ctx.portfolio_positions };
  for (const delta of sim.assets_affected) {
    const current = positions[delta.asset] ?? 0;
    positions[delta.asset] = current + delta.usd_value;
  }

  const totalPortfolio = Object.values(positions).reduce((sum, v) => sum + Math.max(0, v), 0);
  if (totalPortfolio === 0) return null;

  for (const [asset, value] of Object.entries(positions)) {
    if (value <= 0) continue;
    const pct = (value / totalPortfolio) * 100;
    if (pct > maxPct) {
      return {
        rule_id: rule.id,
        rule_type: rule.type,
        severity: rule.severity,
        message: `Asset ${asset} concentration ${pct.toFixed(1)}% exceeds maximum ${maxPct}%`,
        actual_value: Number(pct.toFixed(1)),
        threshold_value: maxPct,
      };
    }
  }
  return null;
}

export function evaluateAutoPauseConsecutiveViolations(
  rule: PolicyRule,
  _sim: SimulationResult,
  ctx: RuleContext,
): PolicyViolation | null {
  const threshold = rule.params["threshold"] as number;

  if (ctx.agent_paused) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Agent is paused due to exceeding ${threshold} consecutive violations`,
      actual_value: "paused",
      threshold_value: threshold,
    };
  }

  // Check if adding one more violation (this one about to be rejected by other rules)
  // would breach the threshold. The engine handles the actual pause logic.
  if (ctx.consecutive_violations >= threshold) {
    return {
      rule_id: rule.id,
      rule_type: rule.type,
      severity: rule.severity,
      message: `Agent has ${ctx.consecutive_violations} consecutive violations, meets/exceeds threshold of ${threshold}`,
      actual_value: ctx.consecutive_violations,
      threshold_value: threshold,
    };
  }
  return null;
}

export function evaluateMaxPositionUsd(
  rule: PolicyRule,
  sim: SimulationResult,
  ctx: RuleContext,
): PolicyViolation | null {
  const max = rule.params["max"] as number;

  for (const delta of sim.assets_affected) {
    if (delta.delta <= 0) continue; // Only check assets being acquired
    const currentPosition = ctx.portfolio_positions[delta.asset] ?? 0;
    const projectedPosition = currentPosition + delta.usd_value;
    if (projectedPosition > max) {
      return {
        rule_id: rule.id,
        rule_type: rule.type,
        severity: rule.severity,
        message: `Position in ${delta.symbol} would be $${projectedPosition.toFixed(2)}, exceeds max $${max.toFixed(2)}`,
        actual_value: projectedPosition,
        threshold_value: max,
      };
    }
  }
  return null;
}

// ─── Rule Registry ─────────────────────────────────────────────────

/** Map of rule type → evaluator function */
export const RULE_EVALUATORS: Record<string, RuleEvaluator> = {
  max_usd_value: (rule, sim, _ctx) => evaluateMaxUsdValue(rule, sim),
  max_slippage_pct: (rule, sim, _ctx) => evaluateMaxSlippagePct(rule, sim),
  velocity_24h_usd: evaluateVelocity24hUsd,
  velocity_1h_count: evaluateVelocity1hCount,
  blacklist_counterparties: (rule, sim, _ctx) => evaluateBlacklistCounterparties(rule, sim),
  whitelist_programs: (rule, sim, _ctx) => evaluateWhitelistPrograms(rule, sim),
  concentration_pct: evaluateConcentrationPct,
  auto_pause_consecutive_violations: evaluateAutoPauseConsecutiveViolations,
  max_position_usd: evaluateMaxPositionUsd,
  // "custom" type has no built-in evaluator — it's a no-op unless a custom handler is registered
};
