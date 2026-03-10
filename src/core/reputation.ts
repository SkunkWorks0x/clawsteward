// ClawSteward Reputation — Steward Score calculator
// Deterministic: same Steward Log input must always produce the same score.
// Score reads ONLY StewardLogEntry fields (never raw_chain_payload).

import type Database from "better-sqlite3";
import type {
  PolicyViolation,
  Severity,
  StewardLogEntry,
  StewardScore,
  ScoreTrend,
} from "./types.js";
import {
  getLogEntriesByAgent,
  getLogEntryCount,
  getAgent,
} from "../db/queries.js";

// ─── Violation Weights ───────────────────────────────────────────

const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 1.0,
  high: 0.6,
  medium: 0.3,
  low: 0.1,
};

// ─── Constants ───────────────────────────────────────────────────

const MIN_EVALUATIONS = 10;
const RECENT_EVAL_COUNT = 100;
const RECENT_EVAL_WEIGHT = 3.0;
const OLD_EVAL_WEIGHT = 1.0;
const AGED_EVAL_WEIGHT = 0.5;
const AGED_THRESHOLD_DAYS = 90;
const TREND_THRESHOLD = 0.3;
const TREND_LOOKBACK_DAYS = 7;
const CRITICAL_VIOLATIONS_WINDOW_DAYS = 30;

// ─── Pure Computation ────────────────────────────────────────────

/**
 * Compute weighted violation rate from a set of log entries.
 * Entries should be ordered newest-first.
 *
 * @param entries Log entries ordered by timestamp DESC (newest first)
 * @param now Reference timestamp for time decay
 */
export function computeWeightedViolationRate(
  entries: StewardLogEntry[],
  now: Date,
): number {
  if (entries.length === 0) return 0;

  let weightedViolationSum = 0;
  let weightedEvaluationSum = 0;

  const agedCutoff = new Date(now.getTime() - AGED_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // Time-position decay: first 100 entries (newest) weighted 3x, rest 1x
    // Entries older than 90 days weighted 0.5x
    let timeWeight: number;
    const entryDate = new Date(entry.timestamp);

    if (entryDate < agedCutoff) {
      timeWeight = AGED_EVAL_WEIGHT;
    } else if (i < RECENT_EVAL_COUNT) {
      timeWeight = RECENT_EVAL_WEIGHT;
    } else {
      timeWeight = OLD_EVAL_WEIGHT;
    }

    // Sum violation weights for this entry
    const entryViolationWeight = sumViolationWeights(entry.violations);
    weightedViolationSum += entryViolationWeight * timeWeight;
    weightedEvaluationSum += timeWeight;
  }

  if (weightedEvaluationSum === 0) return 0;
  return weightedViolationSum / weightedEvaluationSum;
}

/**
 * Sum violation weights for a list of violations.
 */
export function sumViolationWeights(violations: PolicyViolation[]): number {
  let total = 0;
  for (const v of violations) {
    total += SEVERITY_WEIGHTS[v.severity] ?? 0;
  }
  return total;
}

/**
 * Compute the Steward Score from a weighted violation rate.
 * Score = 10.0 × (1 - WeightedViolationRate), clamped to [0.0, 10.0]
 */
export function computeScore(weightedViolationRate: number): number {
  const raw = 10.0 * (1 - weightedViolationRate);
  return Math.max(0.0, Math.min(10.0, raw));
}

/**
 * Determine score trend by comparing current score to score computed
 * from entries that existed 7 days ago.
 */
export function computeTrend(
  currentScore: number,
  entries: StewardLogEntry[],
  now: Date,
): ScoreTrend {
  const sevenDaysAgo = new Date(now.getTime() - TREND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Filter entries to only those that existed 7 days ago
  const entriesAsOf7DaysAgo = entries.filter(
    (e) => new Date(e.timestamp) <= sevenDaysAgo,
  );

  // If no entries existed 7 days ago, trend is stable (no basis for comparison)
  if (entriesAsOf7DaysAgo.length < MIN_EVALUATIONS) {
    return "stable";
  }

  const pastRate = computeWeightedViolationRate(entriesAsOf7DaysAgo, sevenDaysAgo);
  const pastScore = computeScore(pastRate);

  if (currentScore > pastScore + TREND_THRESHOLD) return "improving";
  if (currentScore < pastScore - TREND_THRESHOLD) return "declining";
  return "stable";
}

/**
 * Count critical violations in the last 30 days.
 */
export function countCriticalViolations30d(
  entries: StewardLogEntry[],
  now: Date,
): number {
  const cutoff = new Date(now.getTime() - CRITICAL_VIOLATIONS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let count = 0;
  for (const entry of entries) {
    if (new Date(entry.timestamp) < cutoff) continue;
    for (const v of entry.violations) {
      if (v.severity === "critical") count++;
    }
  }
  return count;
}

// ─── Main Calculator ─────────────────────────────────────────────

/**
 * Compute the full StewardScore for an agent from their Steward Log.
 *
 * This is the primary public API. It reads all log entries for the agent,
 * applies the scoring algorithm, and returns a complete StewardScore object.
 *
 * @param db Database connection
 * @param agentId Agent UUIDv7
 * @param now Optional reference timestamp (defaults to Date.now(), pass explicitly for determinism in tests)
 */
export function computeStewardScore(
  db: Database.Database,
  agentId: string,
  now?: Date,
): StewardScore {
  const referenceTime = now ?? new Date();
  const computedAt = referenceTime.toISOString();

  // Check if agent is paused — return frozen (cached) score
  const agent = getAgent(db, agentId);
  if (agent?.is_paused) {
    return getFrozenScore(db, agentId, computedAt);
  }

  // Get all log entries for this agent (newest first)
  const entries = getLogEntriesByAgent(db, agentId);
  const totalEvaluations = entries.length;

  // Count entries that have violations (reject actions)
  const totalViolations = entries.filter((e) => e.violations.length > 0).length;
  const violationRate = totalEvaluations > 0 ? totalViolations / totalEvaluations : 0;
  const lastEvaluation = entries.length > 0 ? entries[0]!.timestamp : null;

  // Edge case: insufficient data
  if (totalEvaluations < MIN_EVALUATIONS) {
    return {
      agent_id: agentId,
      score: null,
      total_evaluations: totalEvaluations,
      total_violations: totalViolations,
      violation_rate: violationRate,
      critical_violations_30d: countCriticalViolations30d(entries, referenceTime),
      last_evaluation: lastEvaluation,
      score_trend: null,
      computed_at: computedAt,
    };
  }

  // Edge case: zero violations → perfect score
  if (totalViolations === 0) {
    return {
      agent_id: agentId,
      score: 10.0,
      total_evaluations: totalEvaluations,
      total_violations: 0,
      violation_rate: 0,
      critical_violations_30d: 0,
      last_evaluation: lastEvaluation,
      score_trend: computeTrend(10.0, entries, referenceTime),
      computed_at: computedAt,
    };
  }

  // Normal case: compute weighted violation rate
  const weightedRate = computeWeightedViolationRate(entries, referenceTime);
  const score = computeScore(weightedRate);
  const trend = computeTrend(score, entries, referenceTime);
  const criticalViolations30d = countCriticalViolations30d(entries, referenceTime);

  return {
    agent_id: agentId,
    score,
    total_evaluations: totalEvaluations,
    total_violations: totalViolations,
    violation_rate: violationRate,
    critical_violations_30d: criticalViolations30d,
    last_evaluation: lastEvaluation,
    score_trend: trend,
    computed_at: computedAt,
  };
}

/**
 * Compute Steward Score from raw entries (no DB access).
 * Useful for testing and offline computation.
 */
export function computeStewardScoreFromEntries(
  agentId: string,
  entries: StewardLogEntry[],
  now?: Date,
): StewardScore {
  const referenceTime = now ?? new Date();
  const computedAt = referenceTime.toISOString();

  // Sort newest first (same as DB query would return)
  const sorted = [...entries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const totalEvaluations = sorted.length;
  const totalViolations = sorted.filter((e) => e.violations.length > 0).length;
  const violationRate = totalEvaluations > 0 ? totalViolations / totalEvaluations : 0;
  const lastEvaluation = sorted.length > 0 ? sorted[0]!.timestamp : null;

  if (totalEvaluations < MIN_EVALUATIONS) {
    return {
      agent_id: agentId,
      score: null,
      total_evaluations: totalEvaluations,
      total_violations: totalViolations,
      violation_rate: violationRate,
      critical_violations_30d: countCriticalViolations30d(sorted, referenceTime),
      last_evaluation: lastEvaluation,
      score_trend: null,
      computed_at: computedAt,
    };
  }

  if (totalViolations === 0) {
    return {
      agent_id: agentId,
      score: 10.0,
      total_evaluations: totalEvaluations,
      total_violations: 0,
      violation_rate: 0,
      critical_violations_30d: 0,
      last_evaluation: lastEvaluation,
      score_trend: computeTrend(10.0, sorted, referenceTime),
      computed_at: computedAt,
    };
  }

  const weightedRate = computeWeightedViolationRate(sorted, referenceTime);
  const score = computeScore(weightedRate);
  const trend = computeTrend(score, sorted, referenceTime);
  const criticalViolations30d = countCriticalViolations30d(sorted, referenceTime);

  return {
    agent_id: agentId,
    score,
    total_evaluations: totalEvaluations,
    total_violations: totalViolations,
    violation_rate: violationRate,
    critical_violations_30d: criticalViolations30d,
    last_evaluation: lastEvaluation,
    score_trend: trend,
    computed_at: computedAt,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Return a frozen score for a paused agent.
 * If a cached score exists, return it with updated computed_at.
 * Otherwise return null score.
 */
function getFrozenScore(
  db: Database.Database,
  agentId: string,
  computedAt: string,
): StewardScore {
  // Try to read cached score
  const cached = db
    .prepare("SELECT * FROM steward_scores WHERE agent_id = ?")
    .get(agentId) as Record<string, unknown> | undefined;

  if (cached) {
    return {
      agent_id: agentId,
      score: cached["score"] as number | null,
      total_evaluations: cached["total_evaluations"] as number,
      total_violations: cached["total_violations"] as number,
      violation_rate: cached["violation_rate"] as number,
      critical_violations_30d: cached["critical_violations_30d"] as number,
      last_evaluation: cached["last_evaluation"] as string | null,
      score_trend: cached["score_trend"] as ScoreTrend | null,
      computed_at: computedAt,
    };
  }

  // No cached score — agent was paused before any score was computed
  const entries = getLogEntriesByAgent(db, agentId);
  const totalEvaluations = entries.length;
  const totalViolations = entries.filter((e) => e.violations.length > 0).length;

  return {
    agent_id: agentId,
    score: null,
    total_evaluations: totalEvaluations,
    total_violations: totalViolations,
    violation_rate: totalEvaluations > 0 ? totalViolations / totalEvaluations : 0,
    critical_violations_30d: 0,
    last_evaluation: entries.length > 0 ? entries[0]!.timestamp : null,
    score_trend: null,
    computed_at: computedAt,
  };
}
