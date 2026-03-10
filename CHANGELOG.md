# Changelog

All notable changes to ClawSteward will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-10

### Added

- **Policy Engine:** 10 chain-abstract rule types (max_usd_value, max_slippage_pct, velocity_24h_usd, velocity_1h_count, blacklist_counterparties, whitelist_programs, concentration_pct, auto_pause_consecutive_violations, max_position_usd, custom)
- **Steward Score:** Deterministic 0-10 behavioral reputation score with severity weighting, time decay, and trend detection
- **Steward Log:** Append-only tamper-evident audit log with SHA-256 hash chain integrity verification
- **MCP Server:** 5 tools (steward_evaluate, steward_register, steward_score, steward_leaderboard, steward_scan) over stdio transport
- **Solana Adapter:** Chain simulation via @solana/web3.js simulateTransaction + Helius RPC, with Jupiter Price API for USD estimation
- **CLI:** 8 commands (serve, register, scan, score, leaderboard, dashboard, export, verify) with --verbose and --db flags
- **Dashboard:** Next.js 16 + Tailwind CSS v4 Steward Leaderboard with agent detail pages, dark theme, ClawStack orange accents
- **Policy Templates:** Default, conservative, aggressive, and institutional policy sets in policies/
- **Security Audit:** 37 security-specific tests covering SQL injection, input validation, prototype pollution, hash chain integrity
- **Devnet Testing:** 20 live integration tests against Solana devnet (skipped without HELIUS_API_KEY)
- **472 tests passing** across 16 test suites

### Security

- All database queries use parameterized statements (zero string interpolation)
- MCP input schemas enforce max lengths, UUIDv7 format validation, and chain field restrictions
- Policy JSON parser rejects prototype pollution keys (__proto__, constructor, prototype)
- Severity filter uses allowlist validation
- 0 critical, 0 high severity findings (see SECURITY.md)

[0.1.0]: https://github.com/SkunkWorks0x/clawsteward/releases/tag/v0.1.0
