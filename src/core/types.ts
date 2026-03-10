// ClawSteward Core Types — Foundation for all modules
// Every other module imports from here.

// ─── Agent Identity ────────────────────────────────────────────────
// Chain-agnostic by design. UUIDv7 is primary key, NEVER wallet address.

export interface Agent {
  id: string; // UUIDv7 (time-sortable, collision-proof)
  name: string; // Human-readable label
  chain_signers: Record<string, string>; // { "solana": "pubkey", "base": "0x..." }
  registered_at: string; // ISO 8601
  metadata: Record<string, unknown>; // Extensible
  is_paused: boolean;
}

// ─── Policy DSL ────────────────────────────────────────────────────
// Rules NEVER reference chain-specific concepts (gas, compute units, priority fees).
// Translation to chain-specific happens inside the adapter.

export type PolicyRuleType =
  | "max_usd_value" // Single tx value cap
  | "max_slippage_pct" // Slippage tolerance
  | "velocity_24h_usd" // Rolling 24h volume cap
  | "velocity_1h_count" // Tx count per hour
  | "blacklist_counterparties" // Blocked addresses
  | "whitelist_programs" // Allowed program IDs / contract addresses
  | "concentration_pct" // Max % of portfolio in single asset
  | "auto_pause_consecutive_violations" // Pause after N violations in window
  | "max_position_usd" // Max single position size
  | "custom"; // Extensible for user-defined rules

export interface PolicyRule {
  id: string;
  type: PolicyRuleType;
  params: Record<string, number | string | string[]>;
  severity: Severity;
  enabled: boolean;
}

export type Severity = "critical" | "high" | "medium" | "low";

export interface PolicySet {
  id: string;
  name: string;
  version: number;
  rules: PolicyRule[];
  created_at: string;
  updated_at: string;
}

// ─── Chain Simulation ──────────────────────────────────────────────
// Chain-abstract output from adapter. The policy engine evaluates ONLY this.

export interface SimulationResult {
  success: boolean;
  chain: string; // "solana" | "base" | "ethereum" | etc
  estimated_usd_value: number;
  estimated_slippage_pct: number;
  counterparties: string[]; // Program IDs or contract addresses involved
  assets_affected: AssetDelta[];
  raw_chain_payload: unknown; // Chain-specific raw simulation data
  simulation_timestamp: string; // ISO 8601
  error?: string;
}

export interface AssetDelta {
  asset: string; // Token mint/address
  symbol: string;
  delta: number; // Positive = receive, negative = send
  usd_value: number;
}

export interface SimulationContext {
  agent_id: string;
  rpc_url: string;
  recent_blockhash?: string;
}

// ─── Policy Evaluation ─────────────────────────────────────────────

export interface PolicyEvaluation {
  passed: boolean;
  violations: PolicyViolation[];
  rules_evaluated: number;
  evaluation_ms: number;
}

export interface PolicyViolation {
  rule_id: string;
  rule_type: PolicyRuleType;
  severity: Severity;
  message: string;
  actual_value: number | string;
  threshold_value: number | string;
}

// ─── Steward Log ───────────────────────────────────────────────────
// The core data unit. Append-only, tamper-evident.
// Steward Score reads ONLY these fields (never raw_chain_payload).

export type LogAction = "approve" | "reject" | "error";

export interface StewardLogEntry {
  id: string; // UUIDv7
  agent_id: string;
  timestamp: string; // ISO 8601
  chain: string;
  action: LogAction;
  policy_set_id: string;
  rules_evaluated: number;
  violations: PolicyViolation[];
  compliance_score_delta: number; // Impact on rolling score
  estimated_usd_value: number;
  estimated_slippage_pct: number;
  counterparties: string[];
  chain_payload: unknown; // Raw chain-specific data
}

// ─── Steward Score ─────────────────────────────────────────────────
// Derived from Steward Log. Deterministic and reproducible.

export type ScoreTrend = "improving" | "stable" | "declining";

export interface StewardScore {
  agent_id: string;
  score: number | null; // 0.0 - 10.0, null if < 10 evaluations
  total_evaluations: number;
  total_violations: number;
  violation_rate: number; // violations / evaluations
  critical_violations_30d: number;
  last_evaluation: string | null; // ISO 8601
  score_trend: ScoreTrend | null;
  computed_at: string; // ISO 8601
}

// ─── Log Integrity ─────────────────────────────────────────────────

export interface LogIntegrityEntry {
  entry_id: string;
  prev_hash: string;
  integrity_hash: string;
}
