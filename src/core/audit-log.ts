// ClawSteward Audit Log — Append-only Steward Log writer with tamper-evident hash chain
// The Steward Log is the source of truth. NEVER update or delete entries.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import type {
  LogAction,
  LogIntegrityEntry,
  PolicyViolation,
  StewardLogEntry,
} from "./types.js";
import {
  insertLogEntry,
  insertLogIntegrity,
  getLatestIntegrityHash,
  getAllLogIntegrity,
} from "../db/queries.js";

// Genesis hash — the prev_hash for the very first entry
const GENESIS_HASH = "0".repeat(64);

/**
 * Compute SHA-256 integrity hash for a Steward Log entry.
 * integrity_hash = SHA-256(prev_hash + entry_id + timestamp + action + violations)
 */
export function computeIntegrityHash(
  prevHash: string,
  entryId: string,
  timestamp: string,
  action: LogAction,
  violations: PolicyViolation[],
): string {
  const data = prevHash + entryId + timestamp + action + JSON.stringify(violations);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Append a new entry to the Steward Log with hash chain integrity.
 * Returns the created log entry with its ID.
 */
export function appendToStewardLog(
  db: Database.Database,
  params: {
    agent_id: string;
    chain: string;
    action: LogAction;
    policy_set_id: string;
    rules_evaluated: number;
    violations: PolicyViolation[];
    compliance_score_delta: number;
    estimated_usd_value: number;
    estimated_slippage_pct: number;
    counterparties: string[];
    chain_payload?: unknown;
  },
): StewardLogEntry {
  const entry: StewardLogEntry = {
    id: uuidv7(),
    agent_id: params.agent_id,
    timestamp: new Date().toISOString(),
    chain: params.chain,
    action: params.action,
    policy_set_id: params.policy_set_id,
    rules_evaluated: params.rules_evaluated,
    violations: params.violations,
    compliance_score_delta: params.compliance_score_delta,
    estimated_usd_value: params.estimated_usd_value,
    estimated_slippage_pct: params.estimated_slippage_pct,
    counterparties: params.counterparties,
    chain_payload: params.chain_payload ?? null,
  };

  // Get the previous hash (or genesis hash for first entry)
  const prevHash = getLatestIntegrityHash(db) ?? GENESIS_HASH;

  // Compute integrity hash
  const integrityHash = computeIntegrityHash(
    prevHash,
    entry.id,
    entry.timestamp,
    entry.action,
    entry.violations,
  );

  const integrityEntry: LogIntegrityEntry = {
    entry_id: entry.id,
    prev_hash: prevHash,
    integrity_hash: integrityHash,
  };

  // Insert both in a transaction for atomicity
  const insertBoth = db.transaction(() => {
    insertLogEntry(db, entry);
    insertLogIntegrity(db, integrityEntry);
  });
  insertBoth();

  return entry;
}

/**
 * Verification result for the Steward Log hash chain.
 */
export interface VerificationResult {
  valid: boolean;
  entries_checked: number;
  error?: string;
  tampered_entry_id?: string;
}

/**
 * Verify the entire Steward Log hash chain from genesis.
 * Replays every entry and checks that integrity hashes match.
 */
export function verifyStewardLog(db: Database.Database): VerificationResult {
  // Get all log entries ordered by insertion order (rowid)
  const logEntries = db
    .prepare(
      "SELECT id, timestamp, action, violations FROM steward_log ORDER BY rowid ASC",
    )
    .all() as { id: string; timestamp: string; action: LogAction; violations: string }[];

  // Get all integrity entries ordered by timestamp ASC
  const integrityEntries = getAllLogIntegrity(db);

  if (logEntries.length === 0 && integrityEntries.length === 0) {
    return { valid: true, entries_checked: 0 };
  }

  // Build a map for quick integrity lookup
  const integrityMap = new Map<string, LogIntegrityEntry>();
  for (const ie of integrityEntries) {
    integrityMap.set(ie.entry_id, ie);
  }

  // Check every log entry has a corresponding integrity entry
  if (logEntries.length !== integrityEntries.length) {
    return {
      valid: false,
      entries_checked: 0,
      error: `Log has ${logEntries.length} entries but integrity table has ${integrityEntries.length}`,
    };
  }

  let prevHash = GENESIS_HASH;

  for (const logEntry of logEntries) {
    const integrity = integrityMap.get(logEntry.id);
    if (!integrity) {
      return {
        valid: false,
        entries_checked: 0,
        error: `Missing integrity entry for log entry ${logEntry.id}`,
        tampered_entry_id: logEntry.id,
      };
    }

    // Verify prev_hash chain linkage
    if (integrity.prev_hash !== prevHash) {
      return {
        valid: false,
        entries_checked: logEntries.indexOf(logEntry),
        error: `Broken hash chain at entry ${logEntry.id}: expected prev_hash ${prevHash}, got ${integrity.prev_hash}`,
        tampered_entry_id: logEntry.id,
      };
    }

    // Recompute and verify integrity hash
    const violations: PolicyViolation[] = JSON.parse(logEntry.violations);
    const expectedHash = computeIntegrityHash(
      prevHash,
      logEntry.id,
      logEntry.timestamp,
      logEntry.action,
      violations,
    );

    if (integrity.integrity_hash !== expectedHash) {
      return {
        valid: false,
        entries_checked: logEntries.indexOf(logEntry),
        error: `Tampered entry detected: ${logEntry.id}`,
        tampered_entry_id: logEntry.id,
      };
    }

    prevHash = integrity.integrity_hash;
  }

  return { valid: true, entries_checked: logEntries.length };
}
