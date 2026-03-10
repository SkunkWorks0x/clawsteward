import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "../../src/db/database.js";
import { insertAgent } from "../../src/db/queries.js";
import { createAgent } from "../../src/core/agent.js";
import { appendToStewardLog } from "../../src/core/audit-log.js";
import { generateStewardReport } from "../../src/core/report.js";
import type { PolicyViolation } from "../../src/core/types.js";

let db: Database.Database;
let agentId: string;

const NOW = new Date("2026-03-09T12:00:00.000Z");

function makeViolation(
  severity: "critical" | "high" | "medium" | "low",
  ruleType: string = "max_usd_value",
): PolicyViolation {
  return {
    rule_id: `rule-${severity}`,
    rule_type: ruleType as PolicyViolation["rule_type"],
    severity,
    message: `${severity} violation on ${ruleType}`,
    actual_value: 15000,
    threshold_value: 10000,
  };
}

function appendEntry(
  overrides: Partial<{
    action: "approve" | "reject" | "error";
    violations: PolicyViolation[];
  }> = {},
) {
  return appendToStewardLog(db, {
    agent_id: agentId,
    chain: "solana",
    action: overrides.action ?? "approve",
    policy_set_id: "default",
    rules_evaluated: 5,
    violations: overrides.violations ?? [],
    compliance_score_delta: 0,
    estimated_usd_value: 100,
    estimated_slippage_pct: 0.5,
    counterparties: ["program111"],
  });
}

beforeEach(() => {
  db = createTestDatabase();
  const agent = createAgent({
    name: "ReportTestAgent",
    chain: "solana",
    signer_address: "So11111111111111111111111111111111111111112",
  });
  agentId = agent.id;
  insertAgent(db, agent);
});

// ─── Report Tests ────────────────────────────────────────────────

describe("generateStewardReport", () => {
  it("returns null for unknown agent", () => {
    const result = generateStewardReport("nonexistent-id", db, { now: NOW });
    expect(result).toBeNull();
  });

  it("report with no evaluations shows Insufficient Data", () => {
    const report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("# Steward Report — ReportTestAgent");
    expect(report).toContain("Insufficient Data");
    expect(report).toContain("**Score:** N/A / 10.0");
    expect(report).toContain("Total Evaluations | 0");
    expect(report).toContain("No evaluations recorded.");
    expect(report).toContain("ClawSteward v0.1.0");
    expect(report).toContain("clawstack.dev");
  });

  it("report with 100% compliance shows all zero violations", () => {
    // 15 clean entries (enough for a real score)
    for (let i = 0; i < 15; i++) {
      appendEntry();
    }

    const report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("ClawSteward-verified");
    expect(report).toContain("**Score:** 10.0 / 10.0");
    expect(report).toContain("Approvals | 15");
    expect(report).toContain("Rejections | 0");
    expect(report).toContain("Approval Rate | 100.0%");
    expect(report).toContain("Total Violations | 0");
    // Violation breakdown should show all zeros
    expect(report).toContain("| critical | 0 |");
    expect(report).toContain("| high | 0 |");
    // Compliance matrix should say no violations
    expect(report).toContain("No policy violations recorded.");
  });

  it("report with mixed pass/fail contains all sections", () => {
    // 8 clean + 4 violations = 12 entries (≥ 10 for score)
    for (let i = 0; i < 8; i++) {
      appendEntry();
    }
    for (let i = 0; i < 2; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("critical")] });
    }
    for (let i = 0; i < 2; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("high", "max_slippage_pct")] });
    }

    const report = generateStewardReport(agentId, db, { now: NOW })!;

    // Header
    expect(report).toContain("# Steward Report — ReportTestAgent");
    expect(report).toContain("Generated:");
    expect(report).toContain("ClawSteward v0.1.0");

    // Score box
    expect(report).toContain("## Steward Score");
    expect(report).toContain("/ 10.0");

    // Summary
    expect(report).toContain("## Summary");
    expect(report).toContain("Total Evaluations | 12");
    expect(report).toContain("Approvals | 8");
    expect(report).toContain("Rejections | 4");

    // Violation breakdown
    expect(report).toContain("## Violation Breakdown");
    expect(report).toContain("| critical | 2 |");
    expect(report).toContain("| high | 2 |");

    // Compliance matrix
    expect(report).toContain("## Policy Compliance");
    expect(report).toContain("max_usd_value");
    expect(report).toContain("max_slippage_pct");

    // Recent activity
    expect(report).toContain("## Recent Activity");
    expect(report).toContain("APPROVED");
    expect(report).toContain("REJECTED");

    // Integrity
    expect(report).toContain("## Integrity");
    expect(report).toContain("✓ Steward Log Verified");
    expect(report).toContain("hash chain intact");

    // Footer
    expect(report).toContain("---");
    expect(report).toContain("clawstack.dev");
  });

  it("badge text matches score thresholds", () => {
    // Score ≥ 8 → ClawSteward-verified (15 clean entries = 10.0)
    for (let i = 0; i < 15; i++) {
      appendEntry();
    }
    let report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("ClawSteward-verified");

    // Create a new agent for "Under Review" test (score 5-7.9)
    db = createTestDatabase();
    const agent2 = createAgent({
      name: "MidAgent",
      chain: "solana",
      signer_address: "So22222222222222222222222222222222222222222",
    });
    agentId = agent2.id;
    insertAgent(db, agent2);

    // 5 clean + 5 high violations → score ~ 7.0
    for (let i = 0; i < 5; i++) appendEntry();
    for (let i = 0; i < 5; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("high")] });
    }
    report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("Under Review");

    // Create a new agent for "High Risk" test (score < 5)
    db = createTestDatabase();
    const agent3 = createAgent({
      name: "BadAgent",
      chain: "solana",
      signer_address: "So33333333333333333333333333333333333333333",
    });
    agentId = agent3.id;
    insertAgent(db, agent3);

    // 10 critical violations → score ~ 0.0
    for (let i = 0; i < 10; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("critical")] });
    }
    report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("High Risk");
  });

  it("recent activity is capped at 10 entries", () => {
    // Create 15 entries
    for (let i = 0; i < 15; i++) {
      appendEntry();
    }

    const report = generateStewardReport(agentId, db, { now: NOW })!;

    // Count APPROVED occurrences in the Recent Activity section
    const recentSection = report.split("## Recent Activity")[1]!.split("## Integrity")[0]!;
    const approvedMatches = recentSection.match(/APPROVED/g);
    expect(approvedMatches).toHaveLength(10);
  });

  it("report with tampered log shows integrity failure", () => {
    // Add some entries
    for (let i = 0; i < 3; i++) {
      appendEntry();
    }

    // Tamper with the log — modify a hash in log_integrity
    const entry = db
      .prepare("SELECT entry_id FROM log_integrity ORDER BY rowid ASC LIMIT 1")
      .get() as { entry_id: string };
    db.prepare("UPDATE log_integrity SET integrity_hash = 'tampered' WHERE entry_id = ?").run(
      entry.entry_id,
    );

    const report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("✗ INTEGRITY FAILURE — TAMPER DETECTED");
    expect(report).toContain(entry.entry_id);
  });

  it("compliance matrix shows correct pass/fail per rule type", () => {
    // 8 clean + 2 violations on max_usd_value
    for (let i = 0; i < 8; i++) appendEntry();
    for (let i = 0; i < 2; i++) {
      appendEntry({ action: "reject", violations: [makeViolation("critical", "max_usd_value")] });
    }

    const report = generateStewardReport(agentId, db, { now: NOW })!;
    // max_usd_value: 8 pass, 2 fail → 80.0%
    expect(report).toContain("| max_usd_value | 8 | 2 | 80.0% |");
  });

  it("generated timestamp uses provided now option", () => {
    const customNow = new Date("2026-06-15T08:30:00.000Z");
    const report = generateStewardReport(agentId, db, { now: customNow })!;
    expect(report).toContain("Generated: 2026-06-15T08:30:00.000Z");
  });

  it("report shows multiple violation types in recent activity", () => {
    appendEntry({
      action: "reject",
      violations: [
        makeViolation("critical", "max_usd_value"),
        makeViolation("high", "max_slippage_pct"),
      ],
    });

    const report = generateStewardReport(agentId, db, { now: NOW })!;
    expect(report).toContain("[critical] critical violation on max_usd_value");
    expect(report).toContain("[high] high violation on max_slippage_pct");
  });
});
