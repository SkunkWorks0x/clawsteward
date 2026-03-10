#!/usr/bin/env node
// ClawSteward by ClawStack — CLI Entry Point

import { program } from "commander";
import chalk from "chalk";
import { initDatabase, closeDatabase } from "./db/database.js";
import { registerAgent, getAgent } from "./core/agent.js";
import { computeStewardScore } from "./core/reputation.js";
import { verifyStewardLog } from "./core/audit-log.js";
import {
  getLeaderboard,
  getLogEntriesByAgent,
  getLogEntriesSince,
  getAgent as getAgentQuery,
  upsertStewardScore,
} from "./db/queries.js";
import { startStdioServer } from "./mcp/server.js";
import { generateStewardReport } from "./core/report.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────

function getBadge(score: number | null): string {
  if (score === null) return chalk.gray("Insufficient Data");
  if (score >= 8) return chalk.green("ClawSteward-verified");
  if (score >= 5) return chalk.yellow("Under Review");
  return chalk.red("High Risk");
}

function getScoreColor(score: number | null): string {
  if (score === null) return chalk.gray("N/A");
  if (score >= 8) return chalk.green(score.toFixed(1));
  if (score >= 5) return chalk.yellow(score.toFixed(1));
  return chalk.red(score.toFixed(1));
}

function getTrendArrow(trend: string | null): string {
  if (trend === "improving") return chalk.green("↑");
  if (trend === "declining") return chalk.red("↓");
  return chalk.gray("→");
}

function fatal(message: string): never {
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

// ─── Banner ──────────────────────────────────────────────────────

const BRAND = chalk.hex("#F97316")("ClawSteward");
const BRAND_BANNER = `
  ${chalk.hex("#F97316")("╔═══════════════════════════════════════╗")}
  ${chalk.hex("#F97316")("║")}  ${chalk.bold.hex("#F97316")("ClawSteward")} ${chalk.gray("v0.1.0")}                  ${chalk.hex("#F97316")("║")}
  ${chalk.hex("#F97316")("║")}  ${chalk.white("Policy gate & reputation for DeFAI")}   ${chalk.hex("#F97316")("║")}
  ${chalk.hex("#F97316")("║")}  ${chalk.gray("by ClawStack")}                         ${chalk.hex("#F97316")("║")}
  ${chalk.hex("#F97316")("╚═══════════════════════════════════════╝")}
`;

// ─── Program ─────────────────────────────────────────────────────

program
  .name("clawsteward")
  .description(
    `${BRAND} — Pre-signing policy enforcement gate and behavioral reputation system for DeFAI agents`,
  )
  .version("0.1.0")
  .option("--db <path>", "Database path", "./steward.db")
  .option("--verbose", "Enable debug output", false);

// ─── serve ───────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the ClawSteward MCP server for AI agent integration")
  .option("--port <number>", "Port for SSE transport (omit for stdio)")
  .action(async (opts) => {
    const dbPath = program.opts()["db"] as string;
    const verbose = program.opts()["verbose"] as boolean;

    if (opts.port) {
      // SSE transport not implemented in v1
      console.log(
        chalk.yellow(
          `SSE transport on port ${opts.port} coming in v0.2 — using stdio`,
        ),
      );
    }

    const db = initDatabase(dbPath);

    console.error(BRAND_BANNER);
    console.error(
      chalk.gray(`  MCP server starting on stdio (db: ${dbPath})\n`),
    );

    try {
      await startStdioServer(db);
    } catch (err) {
      closeDatabase();
      fatal(err instanceof Error ? err.message : String(err));
    }
  });

// ─── register ────────────────────────────────────────────────────

program
  .command("register")
  .description(
    "Register a new agent (e.g., clawsteward register --name my-agent --chain solana --address 7xKX...)",
  )
  .requiredOption("--name <name>", "Agent name")
  .requiredOption("--chain <chain>", "Blockchain (solana)")
  .requiredOption("--address <pubkey>", "Signer public key")
  .action((opts) => {
    const dbPath = program.opts()["db"] as string;

    if (opts.chain !== "solana") {
      fatal(`Unsupported chain: ${opts.chain}. Only 'solana' is supported in v1.`);
    }

    const db = initDatabase(dbPath);
    try {
      const agent = registerAgent(db, {
        name: opts.name,
        chain: opts.chain,
        signer_address: opts.address,
      });

      console.log(chalk.green("Agent registered successfully"));
      console.log(`  ${chalk.bold("Agent ID:")}  ${agent.id}`);
      console.log(`  ${chalk.bold("Name:")}      ${agent.name}`);
      console.log(`  ${chalk.bold("Chain:")}     ${opts.chain}`);
      console.log(`  ${chalk.bold("Signer:")}    ${opts.address}`);
      console.log(
        `  ${chalk.bold("Registered:")} ${agent.registered_at}`,
      );
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    } finally {
      closeDatabase();
    }
  });

// ─── scan ────────────────────────────────────────────────────────

program
  .command("scan")
  .description("Scan evaluation history and optionally generate a Steward Report")
  .requiredOption("--agent <agent_id>", "Agent ID (UUIDv7)")
  .option("--days <number>", "Lookback window in days", "30")
  .option("--report", "Generate steward-report.md file")
  .action((opts) => {
    const dbPath = program.opts()["db"] as string;
    const days = parseInt(opts.days, 10);

    if (isNaN(days) || days <= 0) {
      fatal("--days must be a positive integer");
    }

    const db = initDatabase(dbPath);
    try {
      const agent = getAgentQuery(db, opts.agent);
      if (!agent) fatal(`Agent not found: ${opts.agent}`);

      // --report flag: generate markdown file and exit
      if (opts.report) {
        const markdown = generateStewardReport(opts.agent, db);
        if (!markdown) fatal(`Agent not found: ${opts.agent}`);
        const outPath = resolve("steward-report.md");
        writeFileSync(outPath, markdown, "utf-8");
        console.log(chalk.green(`Steward Report written to ${outPath}`));
        return;
      }

      const since = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();
      const entries = getLogEntriesSince(db, opts.agent, since);

      const approvals = entries.filter((e) => e.action === "approve").length;
      const rejections = entries.filter((e) => e.action === "reject").length;
      const errors = entries.filter((e) => e.action === "error").length;

      // Violation breakdown
      const bySeverity: Record<string, number> = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      const byType: Record<string, number> = {};
      for (const entry of entries) {
        for (const v of entry.violations) {
          bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
          byType[v.rule_type] = (byType[v.rule_type] ?? 0) + 1;
        }
      }

      const totalUsd = entries.reduce(
        (sum, e) => sum + (e.estimated_usd_value ?? 0),
        0,
      );

      // Current score
      const score = computeStewardScore(db, opts.agent);

      console.log(
        chalk.bold(`\nSteward Scan: ${agent!.name} (${days}-day window)\n`),
      );
      console.log(
        `  ${chalk.bold("Steward Score:")} ${getScoreColor(score.score)} ${getTrendArrow(score.score_trend)} ${getBadge(score.score)}`,
      );
      console.log(
        `  ${chalk.bold("Evaluations:")}  ${entries.length} (${chalk.green(String(approvals))} approved, ${chalk.red(String(rejections))} rejected, ${chalk.gray(String(errors))} errors)`,
      );

      const approvalRate =
        entries.length > 0
          ? ((approvals / entries.length) * 100).toFixed(1)
          : "N/A";
      console.log(`  ${chalk.bold("Approval Rate:")} ${approvalRate}%`);
      console.log(
        `  ${chalk.bold("Total Volume:")}  $${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      );

      if (rejections > 0) {
        console.log(chalk.bold("\n  Violations by Severity:"));
        for (const [sev, count] of Object.entries(bySeverity)) {
          if (count > 0) {
            const color =
              sev === "critical"
                ? chalk.red
                : sev === "high"
                  ? chalk.yellow
                  : sev === "medium"
                    ? chalk.cyan
                    : chalk.gray;
            console.log(`    ${color(`${sev}:`)} ${count}`);
          }
        }

        console.log(chalk.bold("\n  Violations by Rule:"));
        for (const [type, count] of Object.entries(byType)) {
          console.log(`    ${type}: ${count}`);
        }
      }

      if (agent!.is_paused) {
        console.log(chalk.red("\n  ⚠ Agent is currently PAUSED"));
      }

      console.log();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    } finally {
      closeDatabase();
    }
  });

// ─── score ───────────────────────────────────────────────────────

program
  .command("score")
  .description("Query an agent's Steward Score, badge, and trend")
  .argument("<agent_id>", "Agent ID (UUIDv7)")
  .action((agentId) => {
    const dbPath = program.opts()["db"] as string;
    const db = initDatabase(dbPath);

    try {
      const agent = getAgentQuery(db, agentId);
      if (!agent) fatal(`Agent not found: ${agentId}`);

      const score = computeStewardScore(db, agentId);

      console.log(chalk.bold(`\nSteward Score: ${agent!.name}\n`));
      console.log(
        `  ${chalk.bold("Score:")}       ${getScoreColor(score.score)} / 10.0`,
      );
      console.log(
        `  ${chalk.bold("Badge:")}       ${getBadge(score.score)}`,
      );
      console.log(
        `  ${chalk.bold("Trend:")}       ${getTrendArrow(score.score_trend)} ${score.score_trend ?? "N/A"}`,
      );
      console.log(
        `  ${chalk.bold("Evaluations:")} ${score.total_evaluations}`,
      );
      console.log(
        `  ${chalk.bold("Violations:")}  ${score.total_violations} (rate: ${(score.violation_rate * 100).toFixed(1)}%)`,
      );
      console.log(
        `  ${chalk.bold("Critical (30d):")} ${score.critical_violations_30d}`,
      );
      console.log(
        `  ${chalk.bold("Last Eval:")}   ${score.last_evaluation ?? "Never"}`,
      );
      console.log(
        `  ${chalk.bold("Computed:")}    ${score.computed_at}`,
      );

      if (agent!.is_paused) {
        console.log(chalk.red("\n  ⚠ Agent is currently PAUSED (score frozen)"));
      }

      console.log();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    } finally {
      closeDatabase();
    }
  });

// ─── leaderboard ─────────────────────────────────────────────────

program
  .command("leaderboard")
  .description("View agents ranked by Steward Score on the Steward Leaderboard")
  .option("--limit <number>", "Number of agents to show", "20")
  .action((opts) => {
    const dbPath = program.opts()["db"] as string;
    const limit = parseInt(opts.limit, 10);

    if (isNaN(limit) || limit <= 0) {
      fatal("--limit must be a positive integer");
    }

    const db = initDatabase(dbPath);
    try {
      const scores = getLeaderboard(db, limit, 10);

      if (scores.length === 0) {
        console.log(
          chalk.yellow(
            "\nNo agents with sufficient evaluations (min 10) found.\n",
          ),
        );
        return;
      }

      console.log(chalk.bold("\nSteward Leaderboard\n"));

      // Header
      const header = `  ${"#".padEnd(4)} ${"Agent".padEnd(20)} ${"Score".padEnd(8)} ${"Trend".padEnd(6)} ${"Evals".padEnd(8)} ${"Viol %".padEnd(8)} Badge`;
      console.log(chalk.gray(header));
      console.log(chalk.gray("  " + "─".repeat(78)));

      for (let i = 0; i < scores.length; i++) {
        const s = scores[i]!;
        const agent = getAgentQuery(db, s.agent_id);
        const name = (agent?.name ?? "Unknown").slice(0, 18).padEnd(20);
        const rank = String(i + 1).padEnd(4);
        const scoreStr = getScoreColor(s.score).padEnd(8 + 10); // +10 for ANSI codes
        const trend = (getTrendArrow(s.score_trend) + " ").padEnd(6 + 10);
        const evals = String(s.total_evaluations).padEnd(8);
        const violRate = `${(s.violation_rate * 100).toFixed(1)}%`.padEnd(8);
        const badge = getBadge(s.score);

        console.log(`  ${rank} ${name} ${scoreStr} ${trend} ${evals} ${violRate} ${badge}`);
      }

      console.log();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    } finally {
      closeDatabase();
    }
  });

// ─── dashboard ───────────────────────────────────────────────────

program
  .command("dashboard")
  .description("Start the Steward Dashboard")
  .option("--port <number>", "Dashboard port", "3100")
  .action((opts) => {
    console.log(
      chalk.yellow(
        `Dashboard coming in v0.2 — clawstack.dev (port ${opts.port} reserved)`,
      ),
    );
  });

// ─── export ──────────────────────────────────────────────────────

program
  .command("export")
  .description("Export Steward Log entries for compliance or analysis")
  .requiredOption("--agent <agent_id>", "Agent ID (UUIDv7)")
  .option("--format <format>", "Output format (json|csv)", "json")
  .action((opts) => {
    const dbPath = program.opts()["db"] as string;
    const format = opts.format as string;

    if (format !== "json" && format !== "csv") {
      fatal(`Unsupported format: ${format}. Use 'json' or 'csv'.`);
    }

    const db = initDatabase(dbPath);
    try {
      const agent = getAgentQuery(db, opts.agent);
      if (!agent) fatal(`Agent not found: ${opts.agent}`);

      const entries = getLogEntriesByAgent(db, opts.agent);

      if (entries.length === 0) {
        console.error(chalk.yellow("No log entries found for this agent."));
        return;
      }

      if (format === "json") {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        // CSV
        const headers = [
          "id",
          "agent_id",
          "timestamp",
          "chain",
          "action",
          "policy_set_id",
          "rules_evaluated",
          "violations_count",
          "compliance_score_delta",
          "estimated_usd_value",
          "estimated_slippage_pct",
        ];
        console.log(headers.join(","));
        for (const e of entries) {
          const row = [
            e.id,
            e.agent_id,
            e.timestamp,
            e.chain,
            e.action,
            e.policy_set_id,
            e.rules_evaluated,
            e.violations.length,
            e.compliance_score_delta,
            e.estimated_usd_value,
            e.estimated_slippage_pct,
          ];
          console.log(row.join(","));
        }
      }

      console.error(
        chalk.green(`\nExported ${entries.length} entries (${format})`),
      );
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    } finally {
      closeDatabase();
    }
  });

// ─── verify ──────────────────────────────────────────────────────

program
  .command("verify")
  .description("Verify Steward Log integrity (hash chain validation)")
  .action(() => {
    const dbPath = program.opts()["db"] as string;
    const verbose = program.opts()["verbose"] as boolean;
    const db = initDatabase(dbPath);

    try {
      if (verbose) {
        console.log(chalk.gray(`[clawsteward] Verifying log integrity (db: ${dbPath})`));
      }

      const result = verifyStewardLog(db);

      if (result.valid) {
        console.log(
          chalk.green(
            `\nSteward Log integrity: PASS (${result.entries_checked} entries verified)`,
          ),
        );
      } else {
        console.log(chalk.red(`\nSteward Log integrity: FAIL`));
        console.log(chalk.red(`  Error: ${result.error}`));
        if (result.tampered_entry_id) {
          console.log(
            chalk.red(`  Tampered entry: ${result.tampered_entry_id}`),
          );
        }
        console.log(
          chalk.gray(
            `  Entries checked before failure: ${result.entries_checked}`,
          ),
        );
        process.exit(1);
      }

      console.log();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    } finally {
      closeDatabase();
    }
  });

program.parse();
