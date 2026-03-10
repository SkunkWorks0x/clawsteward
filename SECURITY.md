# ClawSteward Security Review — v0.1.0

**Date:** 2026-03-10
**Reviewer:** Automated review via Claude Code
**Scope:** Full codebase audit — dependencies, input validation, SQL injection, policy DSL, hash chain, rate limiting, secrets

---

## Findings Summary

| ID | Severity | Category | Description | Status |
|---|---|---|---|---|
| SEC-001 | Medium | Input Validation | MCP tool schemas lacked max length constraints on string inputs | Fixed |
| SEC-002 | Medium | Input Validation | `agent_id` fields accepted arbitrary strings, not UUIDv7 format | Fixed |
| SEC-003 | Medium | Input Validation | `raw_transaction_base64` had no upper bound, enabling multi-MB payloads | Fixed |
| SEC-004 | Low | Input Validation | `chain_signers` array had no max count, enabling oversized payloads | Fixed |
| SEC-005 | Medium | SQL Injection | `getRecentViolations` severity param used in LIKE pattern without allowlist validation | Fixed |
| SEC-006 | Low | Prototype Pollution | `parsePolicySet` did not reject `__proto__`/`constructor`/`prototype` keys in rule params | Fixed |
| SEC-007 | Info | Dead Code | `getRecentViolations` is exported but never called — attack surface with no caller | Acknowledged |
| SEC-008 | Medium | Rate Limiting | MCP server has no rate limiting; 10K requests/sec would exhaust SQLite and CPU | Deferred |
| SEC-009 | Low | Hash Chain | Attacker with DB write access can recompute entire hash chain from genesis | Acknowledged |
| SEC-010 | Info | Custom Rules | `custom` rule type silently passes (no-op); no code execution risk | Acknowledged |
| SEC-011 | Low | Dependencies | `esbuild` moderate vulnerability (dev dependency via vitest>vite) | Acknowledged |
| SEC-012 | Info | Secrets | HELIUS_API_KEY embedded in RPC URL could appear in Connection error messages | Acknowledged |
| SEC-013 | Info | CLI | `--db` path not validated for traversal — acceptable for local CLI tool | Acknowledged |
| SEC-014 | Info | CLI | `--agent` ID not validated as UUIDv7 in CLI commands (only at MCP boundary) | Acknowledged |

---

## Detailed Findings

### SEC-001: String inputs lacked max length constraints (Fixed)

**Risk:** A malicious MCP client could send multi-megabyte strings in `agent_id`, `name`, `address`, or `policy_set_id` fields, causing excessive memory allocation and potential denial of service.

**Fix:** Added `.max()` constraints to all string fields in Zod schemas:
- `agent_id`: max 64 chars
- `raw_transaction_base64`: max 10,000 chars (Solana tx max is ~1644 base64 chars)
- `name`: max 256 chars
- `address`: max 256 chars
- `policy_set_id`: max 256 chars
- `chain_signers` array: max 10 entries

**Test:** `test/security.test.ts` — "Oversized input rejection" suite (6 tests)

### SEC-002: agent_id accepted arbitrary strings (Fixed)

**Risk:** Without format validation, `agent_id` could contain SQL injection payloads, path traversal sequences, or other malicious content. While parameterized queries prevent SQL injection, defense in depth requires format validation at the input boundary.

**Fix:** Added UUIDv7 regex validation (`/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`) to all `agent_id` fields in Zod schemas.

**Test:** `test/security.test.ts` — "UUIDv7 format validation" suite (4 tests) + "SQL injection attempts" suite (3 tests)

### SEC-003: Transaction base64 had no upper bound (Fixed)

**Risk:** A malicious client could send a multi-MB base64 string, which would be decoded to a Buffer, consuming memory and potentially causing OOM. Solana transactions are capped at 1232 bytes (1644 base64 chars).

**Fix:** Added `.max(10_000)` to `raw_transaction_base64` field. This allows generous headroom beyond the 1644-char theoretical max while preventing abuse.

**Test:** `test/security.test.ts` — "accepts transaction at max allowed length" + "rejects transaction just over max length"

### SEC-004: chain_signers array unbounded (Fixed)

**Risk:** A caller could pass thousands of chain_signers entries, causing excessive processing.

**Fix:** Added `.max(10)` to the chain_signers array schema.

**Test:** `test/security.test.ts` — "rejects too many chain_signers entries"

### SEC-005: Severity parameter used in LIKE pattern without validation (Fixed)

**Risk:** The `getRecentViolations` function in `src/db/queries.ts` constructs a LIKE pattern by interpolating the `severity` parameter into the pattern string: `%"severity":"${severity}"%`. While this is passed as a parameterized value (not string-concatenated into SQL), a crafted severity like `%` could match more broadly than intended, and the function had no caller validation.

**Fix:** Added an allowlist check (`critical`, `high`, `medium`, `low`) before the severity is used. Invalid values now throw an error.

**Test:** `test/security.test.ts` — "Severity filter allowlist" suite (3 tests)

### SEC-006: Prototype pollution in policy JSON (Fixed)

**Risk:** A crafted policy JSON arriving via `JSON.parse` could contain `__proto__`, `constructor`, or `prototype` keys in rule params. While the current code paths don't spread params into target objects in a vulnerable way, this is a defense-in-depth fix to prevent future regressions.

**Fix:** Added `Object.hasOwn()` checks for `__proto__`, `constructor`, and `prototype` in `parseRule()`. These keys are rejected with a `PolicyParseError`.

**Test:** `test/security.test.ts` — "Prototype pollution in policy JSON" suite (4 tests)

### SEC-007: Dead code — getRecentViolations (Acknowledged)

**Risk:** The function `getRecentViolations` in `src/db/queries.ts` is exported but never imported or called anywhere in the codebase. Dead code expands the attack surface and maintenance burden.

**Recommendation:** Remove in v1.1 if no callers are added, or make it internal.

### SEC-008: No rate limiting on MCP server (Deferred)

**Risk:** The MCP server processes requests synchronously via stdio. A malicious or malfunctioning client could flood it with requests, causing:
- SQLite write contention (WAL mode helps but doesn't eliminate)
- CPU saturation from policy evaluation and hash chain computation
- Disk exhaustion from rapid Steward Log growth

**Impact:** Denial of service for the local MCP server. Since v1 runs locally via stdio (not over network), the attack surface is limited to the connected MCP client.

**Recommendation for v1.1:** Implement an in-memory token bucket rate limiter per `agent_id`:
- `steward_evaluate`: 100 req/min per agent
- `steward_register`: 10 req/min global
- `steward_scan`: 30 req/min per agent
- Read endpoints (score, leaderboard): 200 req/min global

### SEC-009: Hash chain recomputable by DB-level attacker (Acknowledged)

**Risk:** An attacker with write access to the SQLite database file could modify log entries and recompute the entire hash chain from the genesis hash (`0x000...`), producing a valid chain that reflects tampered data. This is a fundamental limitation of local-only hash chains without external anchoring.

**Mitigation:** The hash chain still detects:
- Unauthorized modifications by processes that don't recompute hashes
- Partial tampering (modifying one entry without updating the rest)
- Accidental corruption

**Recommendation for v1.1:** Periodically anchor the latest hash to an external timestamping service or blockchain (e.g., post SHA-256 root to Solana memo program) to create externally verifiable checkpoints.

### SEC-010: Custom rule type is a no-op (Acknowledged)

**Risk:** The `custom` rule type is accepted by the policy parser but has no registered evaluator in `RULE_EVALUATORS`. It silently returns `null` (no violation). This is safe — it does not execute arbitrary code.

**Note:** If custom rules gain an expression evaluator in the future, it must be sandboxed (e.g., `vm2` or WebAssembly) to prevent arbitrary code execution.

### SEC-011: esbuild moderate vulnerability (Acknowledged)

**Risk:** `esbuild <=0.24.2` has a moderate vulnerability (GHSA-67mh-4wv8-2f99) allowing any website to send requests to the esbuild development server and read responses. This is a **dev dependency** only (via vitest > vite > esbuild) and does not affect production builds or the shipped binary.

**Mitigation:** Development-only risk. No production exposure. Will be resolved when vitest/vite updates their esbuild dependency.

### SEC-012: API key in RPC URL (Acknowledged)

**Risk:** The `HELIUS_API_KEY` is embedded in the RPC URL (e.g., `https://devnet.helius-rpc.com/?api-key=KEY`). If the Solana `Connection` object throws an error that includes the URL, the API key could appear in error messages. The `SolanaSimulator` itself does not log — it returns errors as strings using only `err.message`.

**Mitigation:** The adapter catches errors and returns only `err.message`, not the full URL. The demo script uses the key but does not log it. The `.gitignore` excludes `.env` files.

### SEC-013: CLI --db path not validated (Acknowledged)

**Risk:** The `--db` CLI flag accepts any filesystem path, including path traversal patterns like `../../etc/data.db`. This is acceptable for a local CLI tool where the user controls the arguments.

**Note:** If the CLI is ever exposed as a web service or accepts paths from untrusted input, path validation must be added.

### SEC-014: CLI agent ID not UUIDv7-validated (Acknowledged)

**Risk:** CLI commands like `clawsteward score <agent_id>` pass the agent ID directly to database queries without UUIDv7 format validation. Since all queries are parameterized, this is not a SQL injection risk — it simply returns "Agent not found" for invalid IDs.

**Note:** UUIDv7 validation is enforced at the MCP boundary (where external clients connect). CLI is considered a trusted interface.

---

## Dependency Audit Results

### Root package (`clawsteward`)

```
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ moderate            │ esbuild enables any website to send any requests to    │
│                     │ the development server and read the response           │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ esbuild                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <=0.24.2                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=0.25.0                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>vitest>vite>esbuild                                  │
└─────────────────────┴────────────────────────────────────────────────────────┘
1 vulnerability found — Severity: 1 moderate (dev dependency only)
```

### Dashboard package

Dashboard directory (`src/dashboard/`) does not exist yet. No audit applicable.

### Dependency version ranges

All dependencies use `^` (caret) ranges, which is standard practice for npm/pnpm. No `*` or `latest` ranges found. All dependencies are well-known, actively maintained packages:

| Dependency | Range | Notes |
|---|---|---|
| @modelcontextprotocol/sdk | ^1.0.0 | Official MCP SDK |
| @solana/web3.js | ^1.95.0 | Official Solana SDK |
| better-sqlite3 | ^11.0.0 | Widely-used SQLite binding |
| chalk | ^5.3.0 | Terminal colors |
| commander | ^12.0.0 | CLI framework |
| uuid | ^10.0.0 | UUID generation |
| zod | ^4.3.6 | Schema validation |
| zod-to-json-schema | ^3.25.1 | Zod to JSON Schema |

No unnecessary dependencies identified. No typosquatting risks detected.

---

## SQL Injection Review

All database queries in `src/db/queries.ts` use parameterized statements (`?` placeholders) via `better-sqlite3`'s `prepare()` API. **No string interpolation of user input into SQL was found.**

Verified queries:
- `insertAgent` — 6 parameterized values
- `getAgent` — 1 parameterized value
- `setAgentPaused` — 2 parameterized values
- `getPolicySet` — 1 parameterized value
- `insertLogEntry` — 13 parameterized values
- `getLogEntriesByAgent` — 1-2 parameterized values
- `getLogEntriesSince` — 2 parameterized values
- `getConsecutiveViolations` — 2 parameterized values
- `getRecentViolations` — 2-3 parameterized values (severity now allowlist-validated)
- `upsertStewardScore` — 9 parameterized values
- `getLeaderboard` — 2 parameterized values

The `ORDER BY` clauses use hardcoded column names, not user input. The `LIMIT` values come from parameterized queries. No `json_extract` with user-controlled paths was found.

---

## Recommendations for v1.1

1. **Rate limiting** (SEC-008) — Implement in-memory token bucket per agent_id before any network-exposed deployment
2. **External hash chain anchoring** (SEC-009) — Anchor latest hash to Solana memo program or external timestamping service
3. **Remove dead code** (SEC-007) — Remove or make `getRecentViolations` internal if unused
4. **Custom rule sandboxing** (SEC-010) — If custom rules gain an expression evaluator, sandbox with vm2 or WASM
5. **API key isolation** (SEC-012) — Pass API keys via separate config rather than embedding in URL strings
6. **Update esbuild** (SEC-011) — Update vitest/vite to pull esbuild >=0.25.0 when available

---

## Test Coverage

37 security-specific tests added in `test/security.test.ts`:
- SQL injection attempts: 3 payloads tested across 3 test cases
- Oversized input rejection: 6 tests (1MB string, oversized name, address, chain_signers)
- UUIDv7 format validation: 4 tests
- Negative/zero/extreme parameter values: 6 tests
- Prototype pollution: 4 tests
- Severity filter allowlist: 3 tests
- API key / secrets hygiene: 5 tests
- Hash chain implementation: 3 tests
- Parameterized query verification: 1 test
- Chain field restriction: 2 tests

**Total test suite: 472 tests passing (37 new security tests + 435 existing).**
