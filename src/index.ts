#!/usr/bin/env node
// ClawSteward by ClawStack — CLI Entry Point

import { program } from "commander";

program
  .name("clawsteward")
  .description("Pre-signing policy enforcement gate and behavioral reputation system for DeFAI agents")
  .version("0.1.0");

// Commands will be added in subsequent build phases:
// - serve: Start MCP server
// - register: Register an agent
// - scan: Free policy scan
// - leaderboard: View Steward Leaderboard
// - score: Query Steward Score
// - dashboard: Start dashboard
// - export: Export Steward Log
// - verify: Verify Steward Log integrity

program.parse();
