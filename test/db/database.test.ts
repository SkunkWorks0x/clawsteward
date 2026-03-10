import { describe, it, expect, afterEach } from "vitest";
import { createTestDatabase } from "../../src/db/database.js";
import {
  insertAgent,
  getAgent,
  getAllAgents,
  setAgentPaused,
  getPolicySet,
  insertLogEntry,
  getLogEntriesByAgent,
  getLogEntryCount,
  getViolationCount,
  getConsecutiveViolations,
  upsertStewardScore,
  getStewardScore,
  getLeaderboard,
  insertLogIntegrity,
  getLogIntegrity,
  getLatestIntegrityHash,
} from "../../src/db/queries.js";
import type Database from "better-sqlite3";

let db: Database.Database;

afterEach(() => {
  if (db) db.close();
});

describe("Database + Schema", () => {
  it("creates all tables from schema", () => {
    db = createTestDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("policy_sets");
    expect(tableNames).toContain("steward_log");
    expect(tableNames).toContain("steward_scores");
    expect(tableNames).toContain("log_integrity");
  });

  it("inserts default policy set on init", () => {
    db = createTestDatabase();
    const policySet = getPolicySet(db, "default");

    expect(policySet).toBeDefined();
    expect(policySet!.name).toBe("Default Steward Policy");
    expect(policySet!.rules).toHaveLength(5);
  });

  it("has foreign keys enabled", () => {
    db = createTestDatabase();
    const result = db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(result[0]!.foreign_keys).toBe(1);
  });
});

describe("Agent Queries", () => {
  it("inserts and retrieves an agent", () => {
    db = createTestDatabase();
    const agent = {
      id: "01912345-6789-7abc-def0-123456789abc",
      name: "TestBot",
      chain_signers: { solana: "So11111111111111111111111111111111111111112" },
      registered_at: new Date().toISOString(),
      metadata: { version: "1.0" },
      is_paused: false,
    };

    insertAgent(db, agent);
    const retrieved = getAgent(db, agent.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(agent.id);
    expect(retrieved!.name).toBe("TestBot");
    expect(retrieved!.chain_signers).toEqual({ solana: "So11111111111111111111111111111111111111112" });
    expect(retrieved!.metadata).toEqual({ version: "1.0" });
    expect(retrieved!.is_paused).toBe(false);
  });

  it("returns undefined for non-existent agent", () => {
    db = createTestDatabase();
    expect(getAgent(db, "nonexistent")).toBeUndefined();
  });

  it("lists all agents", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));
    insertAgent(db, makeAgent("a2", "Agent2"));

    const agents = getAllAgents(db);
    expect(agents).toHaveLength(2);
  });

  it("pauses and unpauses an agent", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    setAgentPaused(db, "a1", true);
    expect(getAgent(db, "a1")!.is_paused).toBe(true);

    setAgentPaused(db, "a1", false);
    expect(getAgent(db, "a1")!.is_paused).toBe(false);
  });
});

describe("Steward Log Queries", () => {
  it("inserts and retrieves log entries", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    const entry = makeLogEntry("log1", "a1", "approve");
    insertLogEntry(db, entry);

    const entries = getLogEntriesByAgent(db, "a1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("approve");
  });

  it("counts entries and violations", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    insertLogEntry(db, makeLogEntry("l1", "a1", "approve"));
    insertLogEntry(db, makeLogEntry("l2", "a1", "reject"));
    insertLogEntry(db, makeLogEntry("l3", "a1", "approve"));

    expect(getLogEntryCount(db, "a1")).toBe(3);
    expect(getViolationCount(db, "a1")).toBe(1);
  });

  it("respects limit on getLogEntriesByAgent", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    for (let i = 0; i < 10; i++) {
      insertLogEntry(db, makeLogEntry(`l${i}`, "a1", "approve"));
    }

    const limited = getLogEntriesByAgent(db, "a1", 3);
    expect(limited).toHaveLength(3);
  });

  it("counts consecutive violations within window", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    // Insert 3 recent rejections followed by an approval
    const now = Date.now();
    insertLogEntry(db, makeLogEntry("l1", "a1", "reject", new Date(now - 1000).toISOString()));
    insertLogEntry(db, makeLogEntry("l2", "a1", "reject", new Date(now - 500).toISOString()));
    insertLogEntry(db, makeLogEntry("l3", "a1", "reject", new Date(now).toISOString()));

    expect(getConsecutiveViolations(db, "a1", 60)).toBe(3);
  });

  it("enforces foreign key on agent_id", () => {
    db = createTestDatabase();

    expect(() => {
      insertLogEntry(db, makeLogEntry("l1", "nonexistent", "approve"));
    }).toThrow();
  });
});

describe("Steward Score Cache Queries", () => {
  it("upserts and retrieves a score", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    const score = {
      agent_id: "a1",
      score: 8.5,
      total_evaluations: 100,
      total_violations: 5,
      violation_rate: 0.05,
      critical_violations_30d: 0,
      last_evaluation: new Date().toISOString(),
      score_trend: "improving" as const,
      computed_at: new Date().toISOString(),
    };

    upsertStewardScore(db, score);
    const retrieved = getStewardScore(db, "a1");

    expect(retrieved).toBeDefined();
    expect(retrieved!.score).toBe(8.5);
    expect(retrieved!.score_trend).toBe("improving");
  });

  it("updates score on upsert", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    upsertStewardScore(db, makeScore("a1", 7.0));
    upsertStewardScore(db, makeScore("a1", 9.0));

    expect(getStewardScore(db, "a1")!.score).toBe(9.0);
  });

  it("returns leaderboard ordered by score", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));
    insertAgent(db, makeAgent("a2", "Agent2"));
    insertAgent(db, makeAgent("a3", "Agent3"));

    upsertStewardScore(db, makeScore("a1", 7.0, 15));
    upsertStewardScore(db, makeScore("a2", 9.5, 20));
    upsertStewardScore(db, makeScore("a3", 5.0, 12));

    const leaderboard = getLeaderboard(db, 10, 10);
    expect(leaderboard).toHaveLength(3);
    expect(leaderboard[0]!.agent_id).toBe("a2");
    expect(leaderboard[1]!.agent_id).toBe("a1");
    expect(leaderboard[2]!.agent_id).toBe("a3");
  });

  it("filters leaderboard by min evaluations", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));
    insertAgent(db, makeAgent("a2", "Agent2"));

    upsertStewardScore(db, makeScore("a1", 9.0, 5)); // Below threshold
    upsertStewardScore(db, makeScore("a2", 8.0, 15));

    const leaderboard = getLeaderboard(db, 10, 10);
    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0]!.agent_id).toBe("a2");
  });
});

describe("Log Integrity Queries", () => {
  it("inserts and retrieves integrity entries", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));
    insertLogEntry(db, makeLogEntry("l1", "a1", "approve"));

    insertLogIntegrity(db, {
      entry_id: "l1",
      prev_hash: "0000000000000000000000000000000000000000000000000000000000000000",
      integrity_hash: "abc123hash",
    });

    const integrity = getLogIntegrity(db, "l1");
    expect(integrity).toBeDefined();
    expect(integrity!.integrity_hash).toBe("abc123hash");
  });

  it("retrieves latest integrity hash", () => {
    db = createTestDatabase();
    insertAgent(db, makeAgent("a1", "Agent1"));

    const now = Date.now();
    insertLogEntry(db, makeLogEntry("l1", "a1", "approve", new Date(now).toISOString()));
    insertLogEntry(db, makeLogEntry("l2", "a1", "approve", new Date(now + 1000).toISOString()));

    insertLogIntegrity(db, { entry_id: "l1", prev_hash: "0".repeat(64), integrity_hash: "hash1" });
    insertLogIntegrity(db, { entry_id: "l2", prev_hash: "hash1", integrity_hash: "hash2" });

    expect(getLatestIntegrityHash(db)).toBe("hash2");
  });
});

// ─── Test Helpers ──────────────────────────────────────────────────

function makeAgent(id: string, name: string) {
  return {
    id,
    name,
    chain_signers: { solana: "test-pubkey" },
    registered_at: new Date().toISOString(),
    metadata: {},
    is_paused: false,
  };
}

function makeLogEntry(id: string, agentId: string, action: "approve" | "reject" | "error", timestamp?: string) {
  return {
    id,
    agent_id: agentId,
    timestamp: timestamp ?? new Date().toISOString(),
    chain: "solana",
    action,
    policy_set_id: "default",
    rules_evaluated: 5,
    violations: [],
    compliance_score_delta: 0,
    estimated_usd_value: 100,
    estimated_slippage_pct: 0.5,
    counterparties: [],
    chain_payload: null,
  };
}

function makeScore(agentId: string, score: number, totalEvals: number = 50) {
  return {
    agent_id: agentId,
    score,
    total_evaluations: totalEvals,
    total_violations: 2,
    violation_rate: 2 / totalEvals,
    critical_violations_30d: 0,
    last_evaluation: new Date().toISOString(),
    score_trend: "stable" as const,
    computed_at: new Date().toISOString(),
  };
}
