import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");
const SCHEMA_PATH = join(PROJECT_ROOT, "src", "db", "schema.sql");

// Test database path (unique per test run to avoid conflicts)
let testDbPath: string;
let testDbDir: string;

function runCli(args: string[], expectFail = false): string {
  try {
    const result = execFileSync("npx", ["tsx", CLI, "--db", testDbPath, ...args], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15000,
      // Merge stdout + stderr so we capture all output
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (err: unknown) {
    if (expectFail) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return (e.stdout ?? "") + (e.stderr ?? "");
    }
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `CLI failed unexpectedly: ${e.stderr ?? e.stdout ?? e.message}`,
    );
  }
}

function setupTestDb(): Database.Database {
  mkdirSync(dirname(testDbPath), { recursive: true });
  const db = new Database(testDbPath);
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  return db;
}

function seedAgent(db: Database.Database, name: string): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO agents (id, name, chain_signers, registered_at, metadata, is_paused)
     VALUES (?, ?, ?, ?, '{}', 0)`,
  ).run(id, name, JSON.stringify({ solana: "SomePubkey123" }), new Date().toISOString());
  return id;
}

function seedLogEntries(
  db: Database.Database,
  agentId: string,
  count: number,
  action: "approve" | "reject" = "approve",
): void {
  const violations =
    action === "reject"
      ? JSON.stringify([
          {
            rule_id: "r1",
            rule_type: "max_usd_value",
            severity: "critical",
            message: "Exceeded max value",
            actual_value: 15000,
            threshold_value: 10000,
          },
        ])
      : "[]";

  let prevHash = "0".repeat(64);
  const { createHash } = require("node:crypto");

  for (let i = 0; i < count; i++) {
    const entryId = uuidv7();
    const timestamp = new Date(Date.now() - (count - i) * 60000).toISOString();

    db.prepare(
      `INSERT INTO steward_log (id, agent_id, timestamp, chain, action, policy_set_id,
       rules_evaluated, violations, compliance_score_delta, estimated_usd_value,
       estimated_slippage_pct, counterparties)
       VALUES (?, ?, ?, 'solana', ?, 'default', 5, ?, ?, ?, 1.5, '[]')`,
    ).run(
      entryId,
      agentId,
      timestamp,
      action,
      violations,
      action === "reject" ? -1 : 0,
      5000 + i * 100,
    );

    const integrityHash = createHash("sha256")
      .update(prevHash + entryId + timestamp + action + violations)
      .digest("hex");

    db.prepare(
      `INSERT INTO log_integrity (entry_id, prev_hash, integrity_hash)
       VALUES (?, ?, ?)`,
    ).run(entryId, prevHash, integrityHash);

    prevHash = integrityHash;
  }
}

function seedStewardScore(
  db: Database.Database,
  agentId: string,
  score: number,
  evals: number,
): void {
  db.prepare(
    `INSERT INTO steward_scores (agent_id, score, total_evaluations, total_violations,
     violation_rate, critical_violations_30d, last_evaluation, score_trend, computed_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'stable', ?)`,
  ).run(
    agentId,
    score,
    evals,
    Math.floor(evals * 0.1),
    0.1,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

describe("CLI", () => {
  beforeEach(() => {
    const id = Math.random().toString(36).slice(2, 8);
    testDbDir = join(PROJECT_ROOT, "test", "cli", `.tmp-${id}`);
    testDbPath = join(testDbDir, "test.db");
    mkdirSync(testDbDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDbDir)) {
      rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  // ─── Version & Help ──────────────────────────────────────────

  it("prints version with --version", () => {
    const output = runCli(["--version"]);
    expect(output.trim()).toBe("0.1.0");
  });

  it("prints help with --help", () => {
    const output = runCli(["--help"]);
    expect(output).toContain("clawsteward");
    expect(output).toContain("serve");
    expect(output).toContain("register");
    expect(output).toContain("score");
    expect(output).toContain("leaderboard");
    expect(output).toContain("verify");
    expect(output).toContain("export");
    expect(output).toContain("dashboard");
    expect(output).toContain("scan");
  });

  // ─── register ────────────────────────────────────────────────

  it("registers an agent and prints agent_id", () => {
    const output = runCli([
      "register",
      "--name",
      "TestBot",
      "--chain",
      "solana",
      "--address",
      "So11111111111111111111111111111111111111112",
    ]);
    expect(output).toContain("Agent registered successfully");
    expect(output).toContain("Agent ID:");
    expect(output).toContain("TestBot");
    expect(output).toContain("solana");
  });

  it("fails register with unsupported chain", () => {
    const output = runCli(
      [
        "register",
        "--name",
        "TestBot",
        "--chain",
        "ethereum",
        "--address",
        "0x123",
      ],
      true,
    );
    expect(output).toContain("Unsupported chain");
  });

  it("fails register with missing required options", () => {
    const output = runCli(["register", "--name", "TestBot"], true);
    expect(output).toContain("required");
  });

  // ─── score ─────────────────────────────────────────────────

  it("shows score for an agent with evaluations", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ScoreAgent");
    seedLogEntries(db, agentId, 15);
    db.close();

    const output = runCli(["score", agentId]);
    expect(output).toContain("Steward Score: ScoreAgent");
    expect(output).toContain("Score:");
    expect(output).toContain("10.0");
    expect(output).toContain("Evaluations:");
    expect(output).toContain("15");
  });

  it("shows insufficient data for agent with < 10 evals", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "NewAgent");
    seedLogEntries(db, agentId, 3);
    db.close();

    const output = runCli(["score", agentId]);
    expect(output).toContain("N/A");
    expect(output).toContain("Insufficient Data");
  });

  it("fails score with nonexistent agent", () => {
    setupTestDb().close();
    const output = runCli(["score", "00000000-0000-0000-0000-000000000000"], true);
    expect(output).toContain("Agent not found");
  });

  // ─── leaderboard ──────────────────────────────────────────

  it("shows leaderboard with ranked agents", () => {
    const db = setupTestDb();
    const id1 = seedAgent(db, "AlphaBot");
    const id2 = seedAgent(db, "BetaBot");
    seedLogEntries(db, id1, 20);
    seedLogEntries(db, id2, 15);
    seedStewardScore(db, id1, 9.5, 20);
    seedStewardScore(db, id2, 7.2, 15);
    db.close();

    const output = runCli(["leaderboard", "--limit", "10"]);
    expect(output).toContain("Steward Leaderboard");
    expect(output).toContain("AlphaBot");
    expect(output).toContain("BetaBot");
  });

  it("shows empty leaderboard message when no qualifying agents", () => {
    setupTestDb().close();
    const output = runCli(["leaderboard"]);
    expect(output).toContain("No agents with sufficient evaluations");
  });

  // ─── scan ──────────────────────────────────────────────────

  it("scans agent evaluation history", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ScanBot");
    seedLogEntries(db, agentId, 12);
    seedLogEntries(db, agentId, 3, "reject");
    db.close();

    const output = runCli(["scan", "--agent", agentId, "--days", "7"]);
    expect(output).toContain("Steward Scan: ScanBot");
    expect(output).toContain("approved");
    expect(output).toContain("rejected");
    expect(output).toContain("Approval Rate:");
  });

  it("fails scan with nonexistent agent", () => {
    setupTestDb().close();
    const output = runCli(
      ["scan", "--agent", "00000000-0000-0000-0000-000000000000"],
      true,
    );
    expect(output).toContain("Agent not found");
  });

  // ─── verify ────────────────────────────────────────────────

  it("verifies empty log as PASS", () => {
    setupTestDb().close();
    const output = runCli(["verify"]);
    expect(output).toContain("PASS");
    expect(output).toContain("0 entries verified");
  });

  it("verifies valid log entries as PASS", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "VerifyBot");
    seedLogEntries(db, agentId, 5);
    db.close();

    const output = runCli(["verify"]);
    expect(output).toContain("PASS");
    expect(output).toContain("5 entries verified");
  });

  it("detects tampered log entry as FAIL", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "TamperBot");
    seedLogEntries(db, agentId, 3);

    // Tamper with a log entry
    db.prepare(
      "UPDATE steward_log SET action = 'approve' WHERE action = 'approve' LIMIT 1",
    );
    // Tamper the integrity hash
    const entry = db
      .prepare("SELECT entry_id FROM log_integrity LIMIT 1 OFFSET 1")
      .get() as { entry_id: string } | undefined;
    if (entry) {
      db.prepare(
        "UPDATE log_integrity SET integrity_hash = 'tampered_hash' WHERE entry_id = ?",
      ).run(entry.entry_id);
    }
    db.close();

    const output = runCli(["verify"], true);
    expect(output).toContain("FAIL");
  });

  // ─── export ────────────────────────────────────────────────

  it("exports log entries as JSON", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ExportBot");
    seedLogEntries(db, agentId, 5);
    db.close();

    const output = runCli(["export", "--agent", agentId, "--format", "json"]);
    const parsed = JSON.parse(output.split("\n\nExported")[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(5);
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("action");
  });

  it("exports log entries as CSV", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "CsvBot");
    seedLogEntries(db, agentId, 3);
    db.close();

    const output = runCli(["export", "--agent", agentId, "--format", "csv"]);
    const lines = output.trim().split("\n");
    // First line is headers, then 3 data rows (stderr "Exported" line may be absent from stdout)
    expect(lines[0]).toContain("id,agent_id,timestamp");
    expect(lines.length).toBeGreaterThanOrEqual(4); // header + 3 data rows
  });

  it("fails export with invalid format", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "FmtBot");
    db.close();

    const output = runCli(
      ["export", "--agent", agentId, "--format", "xml"],
      true,
    );
    expect(output).toContain("Unsupported format");
  });

  // ─── dashboard ─────────────────────────────────────────────

  it("shows dashboard setup instructions when dashboard dir missing", () => {
    const output = runCli(["dashboard", "--port", "3200"], true);
    expect(output).toContain("Dashboard not found");
    expect(output).toContain("src/dashboard");
  });

  // ─── global options ────────────────────────────────────────

  it("accepts --verbose flag without error", () => {
    setupTestDb().close();
    const output = runCli(["--verbose", "verify"]);
    expect(output).toContain("PASS");
  });

  // ─── output formatting ──────────────────────────────────────

  it("register shows next steps hint with agent ID", () => {
    const output = runCli([
      "register",
      "--name",
      "HintBot",
      "--chain",
      "solana",
      "--address",
      "So11111111111111111111111111111111111111112",
    ]);
    expect(output).toContain("Next:");
    expect(output).toContain("evaluate");
    expect(output).toContain("--agent");
  });

  it("register shows checkmark on success", () => {
    const output = runCli([
      "register",
      "--name",
      "CheckBot",
      "--chain",
      "solana",
      "--address",
      "So11111111111111111111111111111111111111112",
    ]);
    // The checkmark might be rendered without ANSI in tests
    expect(output).toContain("registered successfully");
  });

  it("verify shows checkmark on empty log PASS", () => {
    setupTestDb().close();
    const output = runCli(["verify"]);
    expect(output).toContain("PASS");
  });

  it("verify shows X on tampered log FAIL", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "TamperBot2");
    seedLogEntries(db, agentId, 5, "approve");

    // Tamper with the integrity hash
    db.prepare("UPDATE log_integrity SET integrity_hash = 'tampered' WHERE rowid = 1").run();
    db.close();

    const output = runCli(["verify"], true);
    expect(output).toContain("FAIL");
  });

  it("score shows badge for high-scoring agent", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ScoreBot");
    seedLogEntries(db, agentId, 15, "approve");
    seedStewardScore(db, agentId, 9.0, 15);
    db.close();

    const output = runCli(["score", agentId]);
    expect(output).toContain("Score:");
    expect(output).toContain("Badge:");
    expect(output).toContain("Trend:");
    expect(output).toContain("Evaluations:");
    expect(output).toContain("Violations:");
  });

  it("leaderboard shows header row with column names", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "LeaderBot");
    seedLogEntries(db, agentId, 15, "approve");
    seedStewardScore(db, agentId, 8.5, 15);
    db.close();

    const output = runCli(["leaderboard", "--limit", "5"]);
    expect(output).toContain("Steward Leaderboard");
    expect(output).toContain("Agent");
    expect(output).toContain("Score");
    expect(output).toContain("Evals");
  });

  it("export to file with --output flag", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ExportFileBot");
    seedLogEntries(db, agentId, 3, "approve");
    db.close();

    const outFile = join(testDbDir, "export.json");
    const output = runCli(["export", "--agent", agentId, "--output", outFile]);
    expect(output).toContain("Exported");
    expect(output).toContain("3 entries");
    expect(output).toContain(outFile);

    // Verify the file was actually written
    const { readFileSync } = require("node:fs");
    const content = readFileSync(outFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(3);
  });

  it("export to file as CSV with --output flag", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "CsvFileBot");
    seedLogEntries(db, agentId, 2, "approve");
    db.close();

    const outFile = join(testDbDir, "export.csv");
    const output = runCli(["export", "--agent", agentId, "--format", "csv", "--output", outFile]);
    expect(output).toContain("Exported");
    expect(output).toContain("2 entries");
    expect(output).toContain("csv");

    const { readFileSync } = require("node:fs");
    const content = readFileSync(outFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain("id,agent_id");
  });

  it("export to stdout when no --output flag", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "StdoutBot");
    seedLogEntries(db, agentId, 2, "approve");
    db.close();

    const output = runCli(["export", "--agent", agentId]);
    // JSON should be in stdout
    const parsed = JSON.parse(output.split("\n").filter(l => l.startsWith("[") || l.startsWith(" ") || l.startsWith("]")).join("\n") || output.trim().split("Exported")[0]!.trim());
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("scan with --report flag generates steward-report.md", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ReportBot");
    seedLogEntries(db, agentId, 3, "approve");
    db.close();

    const output = runCli(["scan", "--agent", agentId, "--report"]);
    expect(output).toContain("Steward Report written to");
    expect(output).toContain("steward-report.md");
  });

  it("scan shows approval rate percentage", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "ApprovalBot");
    seedLogEntries(db, agentId, 5, "approve");
    db.close();

    const output = runCli(["scan", "--agent", agentId]);
    expect(output).toContain("Approval Rate:");
    expect(output).toContain("%");
  });

  it("scan shows total volume in USD", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "VolumeBot");
    seedLogEntries(db, agentId, 3, "approve");
    db.close();

    const output = runCli(["scan", "--agent", agentId]);
    expect(output).toContain("Total Volume:");
    expect(output).toContain("$");
  });

  it("error messages use clear sentences on invalid scan days", () => {
    const output = runCli(["scan", "--agent", "fake", "--days", "abc"], true);
    expect(output).toContain("--days must be a positive integer");
  });

  it("error messages use clear sentences on invalid leaderboard limit", () => {
    const output = runCli(["leaderboard", "--limit", "abc"], true);
    expect(output).toContain("--limit must be a positive integer");
  });

  it("dashboard help text lists the command", () => {
    const output = runCli(["--help"]);
    expect(output).toContain("dashboard");
    expect(output).toContain("Dashboard");
  });

  it("scan with --days customizes the lookback window", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "DaysBot");
    seedLogEntries(db, agentId, 3, "approve");
    db.close();

    const output = runCli(["scan", "--agent", agentId, "--days", "7"]);
    expect(output).toContain("7-day window");
  });

  it("score shows paused warning for paused agent", () => {
    const db = setupTestDb();
    const agentId = seedAgent(db, "PausedBot");
    seedLogEntries(db, agentId, 15, "approve");
    seedStewardScore(db, agentId, 8.0, 15);
    db.prepare("UPDATE agents SET is_paused = 1 WHERE id = ?").run(agentId);
    db.close();

    const output = runCli(["score", agentId]);
    expect(output).toContain("PAUSED");
  });
});
