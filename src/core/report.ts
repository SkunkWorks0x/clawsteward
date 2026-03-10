// ClawSteward Report — Generate markdown Steward Report for an agent
// Outputs a complete steward-report.md string with score, stats, violations, and integrity status.

import type Database from "better-sqlite3";
import type { PolicyViolation, StewardLogEntry } from "./types.js";
import { computeStewardScore } from "./reputation.js";
import { verifyStewardLog } from "./audit-log.js";
import { getAgent, getLogEntriesByAgent } from "../db/queries.js";

const VERSION = "0.1.0";

export interface ReportOptions {
  /** ISO timestamp to use as "now" (for deterministic tests) */
  now?: Date;
  /** Max recent activity entries to show (default 10) */
  recentLimit?: number;
}

/**
 * Generate a full Steward Report as a markdown string.
 * Returns null if agent not found.
 */
export function generateStewardReport(
  agentId: string,
  db: Database.Database,
  options: ReportOptions = {},
): string | null {
  const now = options.now ?? new Date();
  const recentLimit = options.recentLimit ?? 10;

  const agent = getAgent(db, agentId);
  if (!agent) return null;

  const score = computeStewardScore(db, agentId, now);
  const entries = getLogEntriesByAgent(db, agentId);

  const sections: string[] = [];

  // 1. Header
  sections.push(renderHeader(agent.name, now));

  // 2. Score box
  sections.push(renderScoreBox(score.score, score.score_trend));

  // 3. Summary stats
  const approvals = entries.filter((e) => e.action === "approve").length;
  const rejections = entries.filter((e) => e.action === "reject").length;
  const totalViolations = entries.reduce((sum, e) => sum + e.violations.length, 0);
  sections.push(renderSummaryStats(entries.length, approvals, rejections, totalViolations));

  // 4. Violation breakdown by severity
  sections.push(renderViolationBreakdown(entries));

  // 5. Policy compliance matrix
  sections.push(renderComplianceMatrix(entries));

  // 6. Recent activity
  sections.push(renderRecentActivity(entries, recentLimit));

  // 7. Integrity status
  const verification = verifyStewardLog(db);
  sections.push(renderIntegrityStatus(verification));

  // 8. Footer
  sections.push(renderFooter());

  return sections.join("\n\n");
}

// ─── Section Renderers ────────────────────────────────────────────

function renderHeader(agentName: string, now: Date): string {
  return [
    `# Steward Report — ${agentName}`,
    `Generated: ${now.toISOString()}`,
    `ClawSteward v${VERSION}`,
  ].join("\n");
}

function renderScoreBox(
  score: number | null,
  trend: "improving" | "stable" | "declining" | null,
): string {
  const scoreDisplay = score !== null ? score.toFixed(1) : "N/A";
  const trendArrow = trend === "improving" ? "↑" : trend === "declining" ? "↓" : "→";
  const badge = getBadgeText(score);

  return [
    "## Steward Score",
    "",
    `**Score:** ${scoreDisplay} / 10.0 ${trendArrow}`,
    `**Status:** ${badge}`,
  ].join("\n");
}

function getBadgeText(score: number | null): string {
  if (score === null) return "Insufficient Data";
  if (score >= 8) return "ClawSteward-verified";
  if (score >= 5) return "Under Review";
  return "High Risk";
}

function renderSummaryStats(
  total: number,
  approvals: number,
  rejections: number,
  totalViolations: number,
): string {
  const approvalRate = total > 0 ? ((approvals / total) * 100).toFixed(1) : "0.0";

  return [
    "## Summary",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Total Evaluations | ${total} |`,
    `| Approvals | ${approvals} |`,
    `| Rejections | ${rejections} |`,
    `| Approval Rate | ${approvalRate}% |`,
    `| Total Violations | ${totalViolations} |`,
  ].join("\n");
}

function renderViolationBreakdown(entries: StewardLogEntry[]): string {
  const bySeverity: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  let totalViolations = 0;
  for (const entry of entries) {
    for (const v of entry.violations) {
      bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
      totalViolations++;
    }
  }

  const lines = [
    "## Violation Breakdown",
    "",
    `| Severity | Count | Percentage |`,
    `| --- | --- | --- |`,
  ];

  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const count = bySeverity[sev]!;
    const pct = totalViolations > 0 ? ((count / totalViolations) * 100).toFixed(1) : "0.0";
    lines.push(`| ${sev} | ${count} | ${pct}% |`);
  }

  return lines.join("\n");
}

function renderComplianceMatrix(entries: StewardLogEntry[]): string {
  // Track per rule type: how many entries it was evaluated in, how many it fired (violated)
  const ruleStats = new Map<string, { pass: number; fail: number }>();

  for (const entry of entries) {
    // Collect which rule types violated in this entry
    const violatedTypes = new Set<string>();
    for (const v of entry.violations) {
      violatedTypes.add(v.rule_type);
      if (!ruleStats.has(v.rule_type)) {
        ruleStats.set(v.rule_type, { pass: 0, fail: 0 });
      }
    }

    // For each rule type that has fired at least once across all entries,
    // count this entry as pass or fail for that rule type
    for (const [ruleType, stats] of ruleStats) {
      if (violatedTypes.has(ruleType)) {
        stats.fail++;
      } else {
        // Only count passes for entries after first violation of this rule type
        // Actually, we should retroactively count. Let's rebuild after the loop.
      }
    }
  }

  // Rebuild: for each rule type that ever fired, count pass/fail across ALL entries
  const ruleStatsRebuilt = new Map<string, { pass: number; fail: number }>();
  const allRuleTypes = new Set<string>();
  for (const entry of entries) {
    for (const v of entry.violations) {
      allRuleTypes.add(v.rule_type);
    }
  }

  for (const ruleType of allRuleTypes) {
    let pass = 0;
    let fail = 0;
    for (const entry of entries) {
      const violated = entry.violations.some((v) => v.rule_type === ruleType);
      if (violated) {
        fail++;
      } else {
        pass++;
      }
    }
    ruleStatsRebuilt.set(ruleType, { pass, fail });
  }

  if (ruleStatsRebuilt.size === 0) {
    return [
      "## Policy Compliance",
      "",
      "No policy violations recorded.",
    ].join("\n");
  }

  const lines = [
    "## Policy Compliance",
    "",
    `| Rule Type | Pass | Fail | Compliance |`,
    `| --- | --- | --- | --- |`,
  ];

  for (const [ruleType, stats] of ruleStatsRebuilt) {
    const total = stats.pass + stats.fail;
    const compliance = total > 0 ? ((stats.pass / total) * 100).toFixed(1) : "100.0";
    lines.push(`| ${ruleType} | ${stats.pass} | ${stats.fail} | ${compliance}% |`);
  }

  return lines.join("\n");
}

function renderRecentActivity(entries: StewardLogEntry[], limit: number): string {
  const recent = entries.slice(0, limit); // entries are already newest-first from DB

  if (recent.length === 0) {
    return [
      "## Recent Activity",
      "",
      "No evaluations recorded.",
    ].join("\n");
  }

  const lines = [
    "## Recent Activity",
    "",
  ];

  for (const entry of recent) {
    const status = entry.action === "approve" ? "APPROVED" : entry.action === "reject" ? "REJECTED" : "ERROR";
    lines.push(`- **${entry.timestamp}** — ${status}`);
    if (entry.violations.length > 0) {
      for (const v of entry.violations) {
        lines.push(`  - [${v.severity}] ${v.message}`);
      }
    }
  }

  return lines.join("\n");
}

function renderIntegrityStatus(
  verification: { valid: boolean; entries_checked: number; error?: string; tampered_entry_id?: string },
): string {
  if (verification.valid) {
    return `## Integrity\n\n✓ Steward Log Verified — ${verification.entries_checked} entries, hash chain intact`;
  }

  const entryRef = verification.tampered_entry_id
    ? ` at entry ${verification.tampered_entry_id}`
    : "";
  return `## Integrity\n\n✗ INTEGRITY FAILURE — TAMPER DETECTED${entryRef}`;
}

function renderFooter(): string {
  return `---\nGenerated by ClawSteward v${VERSION} | clawstack.dev`;
}
