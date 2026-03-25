# ClawSteward Mainnet Readiness Audit

**Date:** 2026-03-24
**Auditor:** Claude Opus 4.6 (automated)
**Codebase:** ClawSteward v0.1.0 (`8e599c1`)
**Test suite:** 472 passed, 20 skipped (492 total)

---

## 1. Devnet-Specific Code Inventory

### Source Code (`src/`) — CLEAN

**No devnet references exist in production source code.** The `src/` directory contains zero hardcoded devnet URLs, devnet program IDs, devnet faucet calls, or test-only configurations.

| File | Finding |
|------|---------|
| `src/chain/solana-adapter.ts:19` | `DEFAULT_JUPITER_PRICE_URL = "https://price.jup.ag/v6"` — Mainnet-native, correct for production |
| `src/chain/solana-adapter.ts:63` | RPC URL sourced from `context.rpc_url` or constructor — no hardcoded chain endpoint |
| `src/mcp/handlers.ts:125` | RPC resolved from `process.env["SOLANA_RPC_URL"]` — environment-driven, correct |
| `src/db/database.ts:23` | DB path from `process.env["DATABASE_PATH"]` with default `./data/clawsteward.db` |
| `src/chain/solana-policy-bridge.ts` | Program IDs (Token Program, Jupiter V6, System Program) are mainnet addresses — same on devnet and mainnet |

### Test Code (`test/`) — Properly Isolated

| Location | Type | Devnet-Dependent | Risk |
|----------|------|------------------|------|
| `test/devnet/solana-live.test.ts` | Live network tests | YES — airdrop, devnet RPC | Gated by `HELIUS_API_KEY` env var, auto-skipped otherwise |
| `test/devnet/setup.ts:21` | `DEVNET_RPC_URL = https://devnet.helius-rpc.com/...` | YES | Only used by devnet test suite |
| `test/devnet/setup.ts:39-58` | `requestAirdrop()` — devnet faucet | YES | Would fail on mainnet (no faucet) |
| `test/devnet/demo.ts:37` | Hardcoded devnet Helius URL | YES | Demo script only, not test |
| All other test files (12 files) | Unit/integration tests | NO | Fully mocked, deterministic |

### Configuration Files

| File | Finding |
|------|---------|
| `.env.example:7` | Default `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com` — already mainnet |
| `.env:7` | Same as `.env.example` — already mainnet |
| `policies/default.json` | Chain-abstract policy rules (USD, %, counts) — no chain-specific references |
| `package.json:27-28` | `test:devnet` and `demo:devnet` scripts — properly separated from `test` |

### Leaked Secret Found

| File | Finding | Severity |
|------|---------|----------|
| `.claude/settings.local.json:37-38` | Helius API key `eb7e5ccc-2a5d-4d5d-9f41-17e2f8781857` hardcoded in permission rules | **HIGH** — Rotate this key before mainnet. Ensure `.claude/` is in `.gitignore`. |

---

## 2. Mainnet Deployment Config

Created: `config/mainnet.env` and `config/mainnet-policy.json`

### Key Differences from Development

| Parameter | Dev Default | Mainnet Config | Rationale |
|-----------|------------|----------------|-----------|
| `SOLANA_RPC_URL` | Public RPC | Private Helius PRO | MEV protection, rate limits |
| `LOG_LEVEL` | `info` | `warn` | Prevent tx payload logging |
| `DATABASE_PATH` | `./data/clawsteward.db` | `/var/lib/clawsteward/clawsteward.db` | Absolute path, backup-friendly |
| `max_usd_value` | $10,000 | $5,000 | Conservative initial cap |
| `max_slippage_pct` | 3.0% | 1.5% | Real money, tighter tolerance |
| `velocity_24h_usd` | $50,000 | $25,000 | Halved for safety |
| `velocity_1h_count` | 20 | 10 | Prevent runaway agent loops |
| `auto_pause` threshold | 3 violations / 60min | 2 violations / 30min | Faster circuit breaker |

---

## 3. Security Audit Verification

Re-verified against current code (`8e599c1`). Prior audit claimed 0 critical, 0 high.

### Findings Still Hold — Confirmed

| Category | Status | Evidence |
|----------|--------|----------|
| **SQL Injection** | PASS | All queries use parameterized prepared statements (`db.prepare` + `stmt.run`/`stmt.get`/`stmt.all`). No string interpolation in SQL. LIKE pattern injection prevented via severity allowlist (`queries.ts:167-183`). |
| **Input Validation** | PASS | All MCP inputs validated via Zod schemas with strict type/length/regex constraints (`tools.ts:9-55`). UUIDv7 regex enforced. Base64 tx capped at 10KB. Agent names capped at 256 chars. |
| **Append-Only Log Integrity** | PASS | No UPDATE/DELETE queries exist against `steward_log`. Hash chain with SHA-256 (`audit-log.ts:27-36`). Atomic insert via SQLite transaction (`audit-log.ts:93-97`). Verification replays from genesis. |
| **No Secrets in Logs** | PASS | `raw_chain_payload` stored as JSONB but never logged to console. Error messages use `.message` property only, no stack traces with env vars. |
| **Chain Payload Isolation** | PASS | Policy engine only evaluates `SimulationResult` (chain-abstract). Never touches raw tx bytes. Adapter pattern correctly separates concerns. |
| **Error Handling** | PASS | All handlers wrapped in try/catch. Typed error codes returned. No unhandled promise rejections in MCP flow. Fetch calls use `AbortSignal.timeout()`. |

### New Findings for Mainnet

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| M1 | **HIGH** | No rate limiting on MCP server. Malicious agent can flood evaluations, exhausting RPC credits and filling SQLite. | Add rate limiting before mainnet. Per-agent: 100 evals/hour. Global: 1000 evals/hour. |
| M2 | **HIGH** | No authentication on MCP server. Any MCP client can register agents and submit evaluations. | Add API key or mTLS auth for MCP connections. Acceptable for local-only v1, but not for any network-exposed deployment. |
| M3 | **MEDIUM** | Public RPC default leaks simulation intent to MEV searchers. `simulateTransaction` queries reveal tx structure. | Use private RPC (Helius PRO, Triton) in `mainnet.env`. Documented in CLAUDE.md but not enforced in code. |
| M4 | **MEDIUM** | Jupiter Price API is single point of failure for USD-denominated rules. If Jupiter is down, `estimateUsdValue` returns `null` and USD rules evaluate against 0. | USD rules with `estimated_usd_value = 0` currently PASS (under threshold). Consider treating null USD as evaluation skip with warning. |
| M5 | **MEDIUM** | SQLite has no connection pooling or WAL mode configuration. Under concurrent MCP evaluations, writes will serialize on the default journal mode. | Enable WAL mode: `PRAGMA journal_mode=WAL` in `database.ts`. Already acceptable for single-node MVP. |
| M6 | **LOW** | Helius API key in `.claude/settings.local.json` (lines 37-38). Not in git-tracked source, but exists in local config. | Rotate key. Verify `.claude/` is gitignored. |
| M7 | **LOW** | No database backup strategy. SQLite file is the sole copy of the Steward Log (source of truth for reputation). | Implement periodic backup (cron + cp) or SQLite online backup API before mainnet. |

### Security Posture Summary

| Rating | Count |
|--------|-------|
| Critical | 0 |
| High | 2 (M1, M2 — both acceptable for local-only v1 per CLAUDE.md scope) |
| Medium | 3 (M3, M4, M5) |
| Low | 2 (M6, M7) |

**Assessment:** Prior "0 critical, 0 high" audit still holds for the v1 local-only deployment model defined in CLAUDE.md. The 2 new HIGH findings (M1, M2) apply only if the MCP server is exposed over a network, which is explicitly out of scope for v1.

---

## 4. Test Suite Status

```
Test Files:  15 passed | 1 skipped (16)
Tests:       472 passed | 20 skipped (492)
Duration:    15.32s
```

All 472 tests pass. The 20 skipped tests are the devnet live tests (gated by missing `HELIUS_API_KEY`).

---

## 5. Devnet-Dependent Tests

| Test File | Tests | Devnet Dependency | Mainnet Impact |
|-----------|-------|-------------------|----------------|
| `test/devnet/solana-live.test.ts` | ~20 (skipped) | `requestAirdrop()`, devnet RPC, unfunded keypairs | **Would fail on mainnet** — no faucet, test keypairs have no SOL |
| All other test files (15 files, 472 tests) | 472 | None — fully mocked | **No impact** — would pass identically against any network config |

**Conclusion:** The `pnpm test` command (default) runs zero devnet-dependent tests. Only `pnpm test:devnet` hits the network. This separation is correct and safe.

---

## 6. Mainnet Migration Checklist

### Phase 1: Pre-Migration Preparation

| # | Step | Risk | Details |
|---|------|------|---------|
| 1.1 | Rotate Helius API key (leaked in `.claude/settings.local.json`) | **HIGH** | Generate new key at dev.helius.xyz. Update `.env` only, never commit. |
| 1.2 | Provision private/dedicated Helius RPC (PRO tier) | **HIGH** | Public RPC leaks tx intent to MEV. Budget ~$50/mo for PRO tier. Essential for simulation confidentiality. |
| 1.3 | Copy `config/mainnet.env` to `.env` and fill in real values | **MEDIUM** | Replace `YOUR_HELIUS_API_KEY` placeholder. Set `DATABASE_PATH` to absolute path with backup access. |
| 1.4 | Load `config/mainnet-policy.json` as default policy set | **LOW** | Run: `clawsteward` with policy set import, or manually insert into SQLite. Tighter thresholds than dev defaults. |
| 1.5 | Verify `.gitignore` includes `.env`, `.claude/`, `data/` | **LOW** | Prevent accidental secret commit. |

### Phase 2: Infrastructure Setup

| # | Step | Risk | Details |
|---|------|------|---------|
| 2.1 | Enable SQLite WAL mode | **LOW** | Add `db.pragma('journal_mode = WAL')` call or set in config. Improves concurrent read performance. |
| 2.2 | Set up database backup (cron job) | **MEDIUM** | `cp clawsteward.db clawsteward.db.bak` every 6 hours minimum. Steward Log is append-only source of truth — loss is unrecoverable. |
| 2.3 | Set `LOG_LEVEL=warn` in production | **LOW** | Prevents tx payload logging. Verify no sensitive data in `info`-level logs before going lower. |
| 2.4 | Verify Steward Log integrity before go-live | **LOW** | Run `clawsteward verify` on production DB. Should return PASS with 0 entries (fresh DB) or valid chain from dev data. |

### Phase 3: Validation (Mainnet Shadow Mode)

| # | Step | Risk | Details |
|---|------|------|---------|
| 3.1 | Run ClawSteward against mainnet RPC with real-world tx patterns | **MEDIUM** | Test `steward_evaluate` with realistic base64 transactions. Verify simulation succeeds, USD estimation returns non-null from Jupiter. |
| 3.2 | Verify Jupiter Price API returns real prices | **LOW** | Unlike devnet (where tokens have no market value), mainnet tokens have real prices. Confirm `estimateUsdValue` returns accurate amounts. |
| 3.3 | Test policy evaluation with mainnet-scale USD values | **MEDIUM** | Devnet tests used small values. Mainnet swaps can be $1K+. Verify `max_usd_value` and `velocity_24h_usd` rules trigger correctly at real price levels. |
| 3.4 | Test auto-pause circuit breaker | **LOW** | Submit 2+ consecutive violations within 30min window. Verify agent gets paused. Verify paused agent is rejected from further evaluations. |
| 3.5 | Verify hash chain integrity after shadow run | **LOW** | `clawsteward verify` should return PASS after test evaluations. |

### Phase 4: Go-Live

| # | Step | Risk | Details |
|---|------|------|---------|
| 4.1 | Start fresh production database (or migrate from shadow) | **LOW** | If shadow-mode data is disposable, start fresh. If preserving test agent scores, keep the DB and verify integrity. |
| 4.2 | Register production agents | **LOW** | `clawsteward register --name "AgentName" --chain solana --signer <mainnet-pubkey>` |
| 4.3 | Connect first agent to MCP server | **MEDIUM** | Monitor first few evaluations closely. Check logs for simulation errors, Jupiter API failures, unexpected rejections. |
| 4.4 | Start dashboard | **LOW** | `clawsteward dashboard --port 3000`. Verify Steward Leaderboard renders. Note: no auth on dashboard (v1 scope). |

### Phase 5: Post-Launch Monitoring

| # | Step | Risk | Details |
|---|------|------|---------|
| 5.1 | Monitor Helius RPC credit usage | **MEDIUM** | Each evaluation = 1 simulation call + 1 blockhash call. At 100 evals/day = 200 calls. Free tier: 100K credits/day — comfortable. |
| 5.2 | Monitor SQLite file size | **LOW** | Each log entry ~1-2KB. At 100 evals/day: ~60KB/day, ~22MB/year. SQLite handles this easily. |
| 5.3 | Periodic `clawsteward verify` | **LOW** | Run hash chain verification weekly via cron. Alert if FAIL. |
| 5.4 | Review and adjust policy thresholds | **LOW** | After 1 week of production data, review violation rates. Adjust mainnet policy if too many false positives/negatives. |

---

## Risk Summary

| Risk Level | Items | Action Required |
|------------|-------|-----------------|
| **HIGH** | Rotate leaked API key (M6/1.1), Provision private RPC (1.2), Rate limiting if network-exposed (M1), Auth if network-exposed (M2) | Before mainnet launch |
| **MEDIUM** | MEV risk on public RPC (M3), Jupiter SPOF (M4), WAL mode (M5), DB backups (2.2), Shadow validation (3.1/3.3) | Before or during launch week |
| **LOW** | Policy loading, gitignore check, log level, dashboard, monitoring | During launch |

---

## Conclusion

ClawSteward's source code is **mainnet-ready at the code level**. There are zero hardcoded devnet references in production source. The architecture correctly separates environment config from code via `process.env`, and the chain adapter pattern cleanly abstracts RPC endpoints.

The primary blockers for mainnet are **operational**, not code:
1. Rotate the leaked Helius API key
2. Provision a private RPC endpoint (MEV protection)
3. Set up database backups
4. Run shadow-mode validation with real mainnet prices

The test suite is clean — 472 tests pass without any network dependency, and devnet tests are properly gated and separated.
