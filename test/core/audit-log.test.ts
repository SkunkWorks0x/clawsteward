import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../../src/db/database.js";
import { insertAgent } from "../../src/db/queries.js";
import { createAgent } from "../../src/core/agent.js";
import {
  appendToStewardLog,
  computeIntegrityHash,
  verifyStewardLog,
} from "../../src/core/audit-log.js";
import type { PolicyViolation } from "../../src/core/types.js";

let db: Database.Database;
let agentId: string;

function makeDefaultParams(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: agentId,
    chain: "solana" as const,
    action: "approve" as const,
    policy_set_id: "default",
    rules_evaluated: 5,
    violations: [] as PolicyViolation[],
    compliance_score_delta: 0,
    estimated_usd_value: 100,
    estimated_slippage_pct: 0.5,
    counterparties: ["program111"],
    ...overrides,
  };
}

beforeEach(() => {
  db = createTestDatabase();
  const agent = createAgent({
    name: "TestAgent",
    chain: "solana",
    signer_address: "So11111111111111111111111111111111111111112",
  });
  agentId = agent.id;
  insertAgent(db, agent);
});

describe("Steward Log — Append Entries", () => {
  it("appends a log entry and returns it with UUIDv7 id", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    expect(entry.id).toBeDefined();
    expect(entry.id).toHaveLength(36);
    expect(entry.agent_id).toBe(agentId);
    expect(entry.action).toBe("approve");
    expect(entry.chain).toBe("solana");
  });

  it("appends multiple entries with unique IDs", () => {
    const e1 = appendToStewardLog(db, makeDefaultParams());
    const e2 = appendToStewardLog(db, makeDefaultParams({ action: "reject" }));
    const e3 = appendToStewardLog(db, makeDefaultParams());

    expect(e1.id).not.toBe(e2.id);
    expect(e2.id).not.toBe(e3.id);
  });

  it("stores violations correctly", () => {
    const violations: PolicyViolation[] = [
      {
        rule_id: "max-tx-value",
        rule_type: "max_usd_value",
        severity: "critical",
        message: "Transaction value $15000 exceeds max $10000",
        actual_value: 15000,
        threshold_value: 10000,
      },
    ];

    const entry = appendToStewardLog(
      db,
      makeDefaultParams({ action: "reject", violations }),
    );

    expect(entry.violations).toHaveLength(1);
    expect(entry.violations[0].severity).toBe("critical");
    expect(entry.violations[0].actual_value).toBe(15000);
  });

  it("persists entry to database", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    const row = db
      .prepare("SELECT * FROM steward_log WHERE id = ?")
      .get(entry.id) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row["agent_id"]).toBe(agentId);
    expect(row["action"]).toBe("approve");
  });

  it("stores ISO 8601 timestamp", () => {
    const before = new Date().toISOString();
    const entry = appendToStewardLog(db, makeDefaultParams());
    const after = new Date().toISOString();

    expect(entry.timestamp >= before).toBe(true);
    expect(entry.timestamp <= after).toBe(true);
  });
});

describe("Steward Log — Append-Only Enforcement", () => {
  it("rejects UPDATE on steward_log via SQL constraint check", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    // Direct UPDATE should violate our append-only contract.
    // SQLite doesn't enforce append-only natively, but we verify that
    // any modification breaks the hash chain (detected by verify).
    db.prepare("UPDATE steward_log SET action = 'reject' WHERE id = ?").run(entry.id);

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
    expect(result.tampered_entry_id).toBe(entry.id);
  });

  it("detects deletion of log entries via integrity check", () => {
    appendToStewardLog(db, makeDefaultParams());
    const e2 = appendToStewardLog(db, makeDefaultParams());
    appendToStewardLog(db, makeDefaultParams());

    // Delete middle entry — must remove integrity FK first, then log entry
    db.prepare("DELETE FROM log_integrity WHERE entry_id = ?").run(e2.id);
    db.prepare("DELETE FROM steward_log WHERE id = ?").run(e2.id);

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
  });

  it("detects deletion of integrity entries", () => {
    appendToStewardLog(db, makeDefaultParams());
    const e2 = appendToStewardLog(db, makeDefaultParams());

    db.prepare("DELETE FROM log_integrity WHERE entry_id = ?").run(e2.id);

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
  });
});

describe("Steward Log — Hash Chain Creation", () => {
  it("creates integrity entry for each log entry", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    const integrity = db
      .prepare("SELECT * FROM log_integrity WHERE entry_id = ?")
      .get(entry.id) as Record<string, unknown>;

    expect(integrity).toBeDefined();
    expect(integrity["integrity_hash"]).toBeDefined();
    expect((integrity["integrity_hash"] as string).length).toBe(64); // SHA-256 hex
  });

  it("first entry uses genesis hash (64 zeroes) as prev_hash", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    const integrity = db
      .prepare("SELECT * FROM log_integrity WHERE entry_id = ?")
      .get(entry.id) as Record<string, unknown>;

    expect(integrity["prev_hash"]).toBe("0".repeat(64));
  });

  it("second entry uses first entry's hash as prev_hash", () => {
    const e1 = appendToStewardLog(db, makeDefaultParams());
    const e2 = appendToStewardLog(db, makeDefaultParams());

    const i1 = db
      .prepare("SELECT * FROM log_integrity WHERE entry_id = ?")
      .get(e1.id) as Record<string, unknown>;
    const i2 = db
      .prepare("SELECT * FROM log_integrity WHERE entry_id = ?")
      .get(e2.id) as Record<string, unknown>;

    expect(i2["prev_hash"]).toBe(i1["integrity_hash"]);
  });

  it("builds a chain across multiple entries", () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(appendToStewardLog(db, makeDefaultParams()));
    }

    const integrities = db
      .prepare(
        `SELECT li.* FROM log_integrity li
         JOIN steward_log sl ON li.entry_id = sl.id
         ORDER BY sl.rowid ASC`,
      )
      .all() as Record<string, unknown>[];

    expect(integrities).toHaveLength(5);
    expect(integrities[0]["prev_hash"]).toBe("0".repeat(64));

    for (let i = 1; i < 5; i++) {
      expect(integrities[i]["prev_hash"]).toBe(integrities[i - 1]["integrity_hash"]);
    }
  });
});

describe("Steward Log — Hash Chain Verification", () => {
  it("verifies a valid empty log", () => {
    const result = verifyStewardLog(db);

    expect(result.valid).toBe(true);
    expect(result.entries_checked).toBe(0);
  });

  it("verifies a valid single-entry log", () => {
    appendToStewardLog(db, makeDefaultParams());

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(true);
    expect(result.entries_checked).toBe(1);
  });

  it("verifies a valid multi-entry log", () => {
    for (let i = 0; i < 10; i++) {
      appendToStewardLog(
        db,
        makeDefaultParams({ action: i % 3 === 0 ? "reject" : "approve" }),
      );
    }

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(true);
    expect(result.entries_checked).toBe(10);
  });

  it("detects tampered action field", () => {
    const entry = appendToStewardLog(db, makeDefaultParams({ action: "approve" }));

    // Tamper: change action from approve to reject
    db.prepare("UPDATE steward_log SET action = 'reject' WHERE id = ?").run(entry.id);

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
    expect(result.tampered_entry_id).toBe(entry.id);
    expect(result.error).toContain("Tampered");
  });

  it("detects tampered timestamp", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    db.prepare("UPDATE steward_log SET timestamp = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(
      entry.id,
    );

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
    expect(result.tampered_entry_id).toBe(entry.id);
  });

  it("detects tampered violations JSON", () => {
    const violations: PolicyViolation[] = [
      {
        rule_id: "r1",
        rule_type: "max_usd_value",
        severity: "critical",
        message: "Over limit",
        actual_value: 15000,
        threshold_value: 10000,
      },
    ];
    const entry = appendToStewardLog(
      db,
      makeDefaultParams({ action: "reject", violations }),
    );

    // Tamper: change violations to empty
    db.prepare("UPDATE steward_log SET violations = '[]' WHERE id = ?").run(entry.id);

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
    expect(result.tampered_entry_id).toBe(entry.id);
  });

  it("detects tampered integrity hash", () => {
    const entry = appendToStewardLog(db, makeDefaultParams());

    db.prepare("UPDATE log_integrity SET integrity_hash = ? WHERE entry_id = ?").run(
      "a".repeat(64),
      entry.id,
    );

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
    expect(result.tampered_entry_id).toBe(entry.id);
  });

  it("detects broken chain in the middle", () => {
    appendToStewardLog(db, makeDefaultParams());
    const e2 = appendToStewardLog(db, makeDefaultParams());
    appendToStewardLog(db, makeDefaultParams());

    // Tamper: change the middle entry's action
    db.prepare("UPDATE steward_log SET action = 'error' WHERE id = ?").run(e2.id);

    const result = verifyStewardLog(db);
    expect(result.valid).toBe(false);
    expect(result.tampered_entry_id).toBe(e2.id);
  });
});

describe("computeIntegrityHash", () => {
  it("produces a 64-character hex string (SHA-256)", () => {
    const hash = computeIntegrityHash(
      "0".repeat(64),
      "test-id",
      "2026-01-01T00:00:00.000Z",
      "approve",
      [],
    );

    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it("is deterministic — same inputs produce same hash", () => {
    const args = [
      "0".repeat(64),
      "entry-123",
      "2026-01-01T00:00:00.000Z",
      "approve" as const,
      [] as PolicyViolation[],
    ] as const;

    const h1 = computeIntegrityHash(...args);
    const h2 = computeIntegrityHash(...args);

    expect(h1).toBe(h2);
  });

  it("changes when any input changes", () => {
    const base = {
      prevHash: "0".repeat(64),
      id: "entry-123",
      timestamp: "2026-01-01T00:00:00.000Z",
      action: "approve" as const,
      violations: [] as PolicyViolation[],
    };

    const original = computeIntegrityHash(
      base.prevHash,
      base.id,
      base.timestamp,
      base.action,
      base.violations,
    );

    // Change prev_hash
    expect(
      computeIntegrityHash("1".repeat(64), base.id, base.timestamp, base.action, base.violations),
    ).not.toBe(original);

    // Change id
    expect(
      computeIntegrityHash(base.prevHash, "other-id", base.timestamp, base.action, base.violations),
    ).not.toBe(original);

    // Change timestamp
    expect(
      computeIntegrityHash(
        base.prevHash,
        base.id,
        "2026-06-01T00:00:00.000Z",
        base.action,
        base.violations,
      ),
    ).not.toBe(original);

    // Change action
    expect(
      computeIntegrityHash(base.prevHash, base.id, base.timestamp, "reject", base.violations),
    ).not.toBe(original);

    // Change violations
    const v: PolicyViolation[] = [
      {
        rule_id: "r1",
        rule_type: "max_usd_value",
        severity: "critical",
        message: "x",
        actual_value: 1,
        threshold_value: 2,
      },
    ];
    expect(
      computeIntegrityHash(base.prevHash, base.id, base.timestamp, base.action, v),
    ).not.toBe(original);
  });
});
