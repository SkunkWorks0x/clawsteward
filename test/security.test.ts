// ClawSteward Security Tests — Validates input boundaries, injection resistance, and secrets hygiene
// Part of the v0.1.0 security audit.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StewardEvaluateInputSchema,
  StewardRegisterInputSchema,
  StewardScoreInputSchema,
  StewardScanInputSchema,
  StewardLeaderboardInputSchema,
} from "../src/mcp/tools.js";
import { parsePolicySet, PolicyParseError } from "../src/core/policy-engine.js";
import { getRecentViolations, getAgent, insertAgent } from "../src/db/queries.js";
import { registerAgent } from "../src/core/agent.js";
import { appendToStewardLog, verifyStewardLog } from "../src/core/audit-log.js";
import type { Agent } from "../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Test Database Helper ─────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(__dirname, "../src/db/schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}

// Valid UUIDv7 for tests
const VALID_UUID = "01912345-6789-7abc-8def-0123456789ab";

// ─── Part 2: Input Validation ─────────────────────────────────────

describe("Security: SQL injection attempts in agent_id", () => {
  const SQL_PAYLOADS = [
    "'; DROP TABLE agents; --",
    "1 OR 1=1",
    "1; DELETE FROM steward_log WHERE 1=1; --",
    "' UNION SELECT * FROM agents --",
    "Robert'); DROP TABLE steward_log;--",
  ];

  it("Zod schema rejects all SQL injection payloads as agent_id", () => {
    for (const payload of SQL_PAYLOADS) {
      const result = StewardScoreInputSchema.safeParse({ agent_id: payload });
      expect(result.success, `Should reject: ${payload}`).toBe(false);
    }
  });

  it("database query is safe even if SQL injection payload reaches it", () => {
    const db = createTestDb();
    try {
      // Even without Zod validation, parameterized queries must be safe
      for (const payload of SQL_PAYLOADS) {
        // Should not throw, should just return undefined (not found)
        const result = getAgent(db, payload);
        expect(result).toBeUndefined();
      }
      // Verify tables still exist (not dropped)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("agents");
      expect(tableNames).toContain("steward_log");
      expect(tableNames).toContain("log_integrity");
    } finally {
      db.close();
    }
  });

  it("SQL injection in steward_log agent_id returns empty, not error", () => {
    const db = createTestDb();
    try {
      const result = getRecentViolations(
        db,
        "'; DROP TABLE steward_log; --",
        new Date().toISOString(),
      );
      expect(result).toEqual([]);
      // Table still exists
      const count = db
        .prepare("SELECT COUNT(*) as c FROM steward_log")
        .get() as { c: number };
      expect(count.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("Security: Oversized input rejection", () => {
  it("rejects 1MB string in raw_transaction_base64", () => {
    const megabyteString = "A".repeat(1_000_000);
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: VALID_UUID,
      raw_transaction_base64: megabyteString,
      chain: "solana",
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized agent name in register", () => {
    const longName = "A".repeat(500);
    const result = StewardRegisterInputSchema.safeParse({
      name: longName,
      chain_signers: [{ chain: "solana", address: "pubkey123" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized address in chain_signers", () => {
    const longAddress = "A".repeat(500);
    const result = StewardRegisterInputSchema.safeParse({
      name: "test",
      chain_signers: [{ chain: "solana", address: longAddress }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects too many chain_signers entries", () => {
    const signers = Array.from({ length: 20 }, (_, i) => ({
      chain: "solana" as const,
      address: `pubkey${i}`,
    }));
    const result = StewardRegisterInputSchema.safeParse({
      name: "test",
      chain_signers: signers,
    });
    expect(result.success).toBe(false);
  });

  it("accepts transaction at max allowed length (10000 chars)", () => {
    const maxTx = "A".repeat(10_000);
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: VALID_UUID,
      raw_transaction_base64: maxTx,
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("rejects transaction just over max length", () => {
    const overMax = "A".repeat(10_001);
    const result = StewardEvaluateInputSchema.safeParse({
      agent_id: VALID_UUID,
      raw_transaction_base64: overMax,
      chain: "solana",
    });
    expect(result.success).toBe(false);
  });
});

describe("Security: UUIDv7 format validation", () => {
  it("rejects plain string as agent_id", () => {
    const result = StewardScoreInputSchema.safeParse({ agent_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects UUIDv4 format (wrong version)", () => {
    const result = StewardScoreInputSchema.safeParse({
      agent_id: "550e8400-e29b-41d4-a716-446655440000", // v4 UUID
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid UUIDv7", () => {
    const result = StewardScoreInputSchema.safeParse({
      agent_id: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects UUID with wrong variant", () => {
    // Variant byte 'd' is not in [89ab]
    const result = StewardScoreInputSchema.safeParse({
      agent_id: "01912345-6789-7abc-def0-0123456789ab",
    });
    expect(result.success).toBe(false);
  });
});

describe("Security: Negative and extreme parameter values", () => {
  it("rejects negative limit in leaderboard", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects zero limit in leaderboard", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative days in scan", () => {
    const result = StewardScanInputSchema.safeParse({
      agent_id: VALID_UUID,
      days: -10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero days in scan", () => {
    const result = StewardScanInputSchema.safeParse({
      agent_id: VALID_UUID,
      days: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extremely large limit (beyond max)", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: 999999 });
    expect(result.success).toBe(false);
  });

  it("rejects NaN-coercible values for numeric fields", () => {
    const result = StewardLeaderboardInputSchema.safeParse({ limit: "abc" });
    expect(result.success).toBe(false);
  });
});

// ─── Part 4: Policy DSL Injection ─────────────────────────────────

describe("Security: Prototype pollution in policy JSON", () => {
  it("rejects __proto__ key in policy rule params (via JSON.parse)", () => {
    // Object literals handle __proto__ specially; JSON.parse preserves it as own property
    // This simulates how external input actually arrives
    const maliciousJson = '{"id":"test-policy","name":"Malicious Policy","version":1,"rules":[{"id":"evil","type":"max_usd_value","params":{"max":1000,"__proto__":{"isAdmin":true}},"severity":"critical","enabled":true}]}';
    const malicious = JSON.parse(maliciousJson);
    expect(() => parsePolicySet(malicious)).toThrow(PolicyParseError);
    expect(() => parsePolicySet(malicious)).toThrow(/forbidden key/);
  });

  it("rejects constructor key in policy rule params", () => {
    const malicious = {
      id: "test-policy",
      name: "Malicious Policy",
      version: 1,
      rules: [
        {
          id: "evil",
          type: "max_usd_value",
          params: { max: 1000, "constructor": { prototype: {} } },
          severity: "critical",
          enabled: true,
        },
      ],
    };
    expect(() => parsePolicySet(malicious)).toThrow(PolicyParseError);
  });

  it("rejects prototype key in policy rule params", () => {
    const malicious = {
      id: "test-policy",
      name: "Malicious Policy",
      version: 1,
      rules: [
        {
          id: "evil",
          type: "max_usd_value",
          params: { max: 1000, "prototype": {} },
          severity: "critical",
          enabled: true,
        },
      ],
    };
    expect(() => parsePolicySet(malicious)).toThrow(PolicyParseError);
  });

  it("accepts clean policy params without pollution keys", () => {
    const clean = {
      id: "test-policy",
      name: "Clean Policy",
      version: 1,
      rules: [
        {
          id: "r1",
          type: "max_usd_value",
          params: { max: 1000 },
          severity: "critical",
          enabled: true,
        },
      ],
    };
    const result = parsePolicySet(clean);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.params["max"]).toBe(1000);
  });
});

// ─── Part 3: Severity allowlist in getRecentViolations ────────────

describe("Security: Severity filter allowlist", () => {
  it("rejects invalid severity values", () => {
    const db = createTestDb();
    try {
      expect(() =>
        getRecentViolations(db, "agent-1", new Date().toISOString(), "evil-severity"),
      ).toThrow(/Invalid severity filter/);
    } finally {
      db.close();
    }
  });

  it("rejects LIKE-pattern injection in severity", () => {
    const db = createTestDb();
    try {
      expect(() =>
        getRecentViolations(db, "agent-1", new Date().toISOString(), '%" OR 1=1 --'),
      ).toThrow(/Invalid severity filter/);
    } finally {
      db.close();
    }
  });

  it("accepts valid severity values", () => {
    const db = createTestDb();
    try {
      for (const sev of ["critical", "high", "medium", "low"]) {
        // Should not throw, just return empty array
        const result = getRecentViolations(
          db,
          "agent-1",
          new Date().toISOString(),
          sev,
        );
        expect(result).toEqual([]);
      }
    } finally {
      db.close();
    }
  });
});

// ─── Part 7: API key not in logs ──────────────────────────────────

describe("Security: API key not exposed in outputs", () => {
  it("HELIUS_API_KEY is not present in any source file output strings", () => {
    // Read the solana adapter source — it should never log or include API keys
    const adapterSrc = readFileSync(
      join(__dirname, "../src/chain/solana-adapter.ts"),
      "utf-8",
    );
    // Should not contain console.log, console.error, etc.
    expect(adapterSrc).not.toMatch(/console\.(log|error|warn|info)/);
  });

  it("error messages from SolanaSimulator do not include RPC URLs", () => {
    // The error messages use err.message, not the full context with URLs
    const adapterSrc = readFileSync(
      join(__dirname, "../src/chain/solana-adapter.ts"),
      "utf-8",
    );
    // Error returns should use err.message, not include rpc_url directly
    expect(adapterSrc).not.toMatch(/error:.*rpc_url/);
    expect(adapterSrc).not.toMatch(/error:.*HELIUS/i);
  });

  it(".gitignore excludes .env files", () => {
    const gitignore = readFileSync(join(__dirname, "../.gitignore"), "utf-8");
    expect(gitignore).toContain(".env");
  });

  it(".gitignore excludes database files", () => {
    const gitignore = readFileSync(join(__dirname, "../.gitignore"), "utf-8");
    expect(gitignore).toContain("*.db");
  });

  it(".gitignore excludes node_modules and dist", () => {
    const gitignore = readFileSync(join(__dirname, "../.gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules");
    expect(gitignore).toContain("dist/");
  });
});

// ─── Part 5: Hash chain uses node:crypto ──────────────────────────

describe("Security: Hash chain implementation", () => {
  it("uses node:crypto SHA-256 (not npm package)", () => {
    const auditLogSrc = readFileSync(
      join(__dirname, "../src/core/audit-log.ts"),
      "utf-8",
    );
    expect(auditLogSrc).toContain('from "node:crypto"');
    expect(auditLogSrc).toContain("sha256");
  });

  it("hash chain handles empty log correctly", () => {
    const db = createTestDb();
    try {
      const result = verifyStewardLog(db);
      expect(result.valid).toBe(true);
      expect(result.entries_checked).toBe(0);
    } finally {
      db.close();
    }
  });

  it("hash chain handles single entry correctly", () => {
    const db = createTestDb();
    try {
      const agent = registerAgent(db, {
        name: "test-agent",
        chain: "solana",
        signer_address: "TestPubkey123",
      });
      appendToStewardLog(db, {
        agent_id: agent.id,
        chain: "solana",
        action: "approve",
        policy_set_id: "default",
        rules_evaluated: 1,
        violations: [],
        compliance_score_delta: 0,
        estimated_usd_value: 100,
        estimated_slippage_pct: 0.5,
        counterparties: [],
      });

      const result = verifyStewardLog(db);
      expect(result.valid).toBe(true);
      expect(result.entries_checked).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ─── Parameterized query verification ─────────────────────────────

describe("Security: Parameterized queries", () => {
  it("all queries in queries.ts use ? placeholders, not string interpolation", () => {
    const queriesSrc = readFileSync(
      join(__dirname, "../src/db/queries.ts"),
      "utf-8",
    );
    // Find all db.prepare() calls and check they use ? placeholders
    const prepareMatches = queriesSrc.match(/db\.prepare\([`"'][\s\S]*?[`"']\)/g) ?? [];
    expect(prepareMatches.length).toBeGreaterThan(0);

    for (const match of prepareMatches) {
      // Should not contain ${...} template interpolation inside SQL strings
      expect(match).not.toMatch(/\$\{[^}]+\}/);
    }
  });
});

// ─── Chain field validation ───────────────────────────────────────

describe("Security: Chain field restricted to solana literal", () => {
  it("rejects arbitrary chain values in evaluate", () => {
    for (const chain of ["ethereum", "base", "polygon", '"; DROP TABLE', "solana; --"]) {
      const result = StewardEvaluateInputSchema.safeParse({
        agent_id: VALID_UUID,
        raw_transaction_base64: "AQAAAA==",
        chain,
      });
      expect(result.success, `Should reject chain: ${chain}`).toBe(false);
    }
  });

  it("rejects arbitrary chain values in register chain_signers", () => {
    const result = StewardRegisterInputSchema.safeParse({
      name: "test",
      chain_signers: [{ chain: "ethereum", address: "0xabc" }],
    });
    expect(result.success).toBe(false);
  });
});
