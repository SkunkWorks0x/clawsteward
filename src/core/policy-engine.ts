// ClawSteward Policy Engine — DSL parser + evaluator
// Evaluates a SimulationResult against a PolicySet using chain-abstract rules.
// The engine NEVER touches raw transaction data — only chain-abstract SimulationResult.

import type {
  PolicyEvaluation,
  PolicyRule,
  PolicySet,
  PolicyViolation,
  SimulationResult,
} from "./types.js";
import { RULE_EVALUATORS, type RuleContext } from "./policy-rules.js";

/**
 * Evaluate a simulation result against a policy set.
 *
 * @param policySet - The policy set containing rules to evaluate
 * @param simulation - Chain-abstract simulation result from the adapter
 * @param context - Historical context for stateful rules (velocity, auto_pause)
 * @returns PolicyEvaluation with pass/fail, violations, and timing
 */
export function evaluatePolicy(
  policySet: PolicySet,
  simulation: SimulationResult,
  context: RuleContext,
): PolicyEvaluation {
  const start = performance.now();
  const violations: PolicyViolation[] = [];
  let rulesEvaluated = 0;

  for (const rule of policySet.rules) {
    if (!rule.enabled) continue;

    rulesEvaluated++;
    const violation = evaluateRule(rule, simulation, context);
    if (violation) {
      violations.push(violation);
    }
  }

  const elapsed = performance.now() - start;

  return {
    passed: violations.length === 0,
    violations,
    rules_evaluated: rulesEvaluated,
    evaluation_ms: Math.round(elapsed * 100) / 100,
  };
}

/**
 * Evaluate a single rule against a simulation result.
 */
export function evaluateRule(
  rule: PolicyRule,
  simulation: SimulationResult,
  context: RuleContext,
): PolicyViolation | null {
  const evaluator = RULE_EVALUATORS[rule.type];
  if (!evaluator) {
    // Unknown rule type — skip silently (custom rules without registered handlers)
    return null;
  }
  return evaluator(rule, simulation, context);
}

/**
 * Parse and validate a policy set from JSON.
 * Returns the parsed PolicySet or throws with a descriptive error.
 */
export function parsePolicySet(json: unknown): PolicySet {
  if (!json || typeof json !== "object") {
    throw new PolicyParseError("Policy set must be a non-null object");
  }

  const obj = json as Record<string, unknown>;

  if (typeof obj["id"] !== "string" || obj["id"].length === 0) {
    throw new PolicyParseError("Policy set must have a non-empty string 'id'");
  }
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new PolicyParseError("Policy set must have a non-empty string 'name'");
  }
  if (typeof obj["version"] !== "number" || !Number.isInteger(obj["version"]) || obj["version"] < 1) {
    throw new PolicyParseError("Policy set must have a positive integer 'version'");
  }
  if (!Array.isArray(obj["rules"])) {
    throw new PolicyParseError("Policy set must have an array 'rules'");
  }

  const rules = (obj["rules"] as unknown[]).map((r, i) => parseRule(r, i));

  return {
    id: obj["id"] as string,
    name: obj["name"] as string,
    version: obj["version"] as number,
    rules,
    created_at: (obj["created_at"] as string) ?? new Date().toISOString(),
    updated_at: (obj["updated_at"] as string) ?? new Date().toISOString(),
  };
}

const VALID_RULE_TYPES = new Set([
  "max_usd_value",
  "max_slippage_pct",
  "velocity_24h_usd",
  "velocity_1h_count",
  "blacklist_counterparties",
  "whitelist_programs",
  "concentration_pct",
  "auto_pause_consecutive_violations",
  "max_position_usd",
  "custom",
]);

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

function parseRule(json: unknown, index: number): PolicyRule {
  if (!json || typeof json !== "object") {
    throw new PolicyParseError(`Rule at index ${index} must be a non-null object`);
  }

  const obj = json as Record<string, unknown>;

  if (typeof obj["id"] !== "string" || obj["id"].length === 0) {
    throw new PolicyParseError(`Rule at index ${index} must have a non-empty string 'id'`);
  }
  if (typeof obj["type"] !== "string" || !VALID_RULE_TYPES.has(obj["type"])) {
    throw new PolicyParseError(
      `Rule '${obj["id"]}' has invalid type '${obj["type"]}'. Valid: ${[...VALID_RULE_TYPES].join(", ")}`,
    );
  }
  if (typeof obj["severity"] !== "string" || !VALID_SEVERITIES.has(obj["severity"])) {
    throw new PolicyParseError(
      `Rule '${obj["id"]}' has invalid severity '${obj["severity"]}'. Valid: critical, high, medium, low`,
    );
  }
  if (!obj["params"] || typeof obj["params"] !== "object" || Array.isArray(obj["params"])) {
    throw new PolicyParseError(`Rule '${obj["id"]}' must have an object 'params'`);
  }
  if (typeof obj["enabled"] !== "boolean") {
    throw new PolicyParseError(`Rule '${obj["id"]}' must have a boolean 'enabled'`);
  }

  return {
    id: obj["id"] as string,
    type: obj["type"] as PolicyRule["type"],
    params: obj["params"] as PolicyRule["params"],
    severity: obj["severity"] as PolicyRule["severity"],
    enabled: obj["enabled"] as boolean,
  };
}

export class PolicyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyParseError";
  }
}
