# CLAUDE.md — ClawSteward by ClawStack

## IDENTITY
You are building **ClawSteward** — a pre-signing policy enforcement gate and behavioral reputation system for DeFAI (Decentralized Finance + AI) agents. Built by ClawStack. This is defense-layer infrastructure, not an offensive trading tool.

**Builder context:** Solo bootstrap founder (Imani, @SkunkWorks0x) on MacBook Pro M5 32GB. No team, no VC, no budget. Ship in ≤3 weeks. Quality over speed, but ship over perfection.

**This spec was pressure-tested across 5 rounds between Claude Opus 4.6 and Grok 4.20 Swarm (4-agent system). Every architectural decision below survived adversarial review from both frontier models. Do not deviate from the architecture without explicit approval.**

---

## WHAT CLAWSTEWARD DOES (EXACTLY)

1. DeFAI agents submit unsigned transactions to ClawSteward via MCP server
2. ClawSteward simulates the transaction against the target chain (Solana v1)
3. ClawSteward evaluates simulation results against configurable policy rules (chain-abstract DSL)
4. If compliant → approve + log. If violation → reject + log + alert
5. Every evaluation is appended to a tamper-evident audit log
6. A reputation scorer derives a 0-10 behavioral score from audit log history (the "Steward Score")
7. A read-only MCP endpoint exposes Steward Scores for any agent/user/protocol to query
8. A public dashboard displays the agent compliance leaderboard

**Critical architectural constraint (from Grok pressure test):** This is a PRE-SIGNING SIMULATION GATE, not runtime on-chain interception. You cannot intercept transactions on-chain without controlling the signing wallet. ClawSteward evaluates BEFORE the agent signs and broadcasts. If you find yourself writing code that attempts to intercept already-signed transactions, stop — you are off-architecture.

**Brand language:**
- The reputation score is called the **"Steward Score"** (0.0 - 10.0)
- A compliant agent is **"ClawSteward-verified"**
- The leaderboard is the **"Steward Leaderboard"**
- The audit trail is the **"Steward Log"**

---

## TECH STACK (LOCKED — DO NOT SUBSTITUTE)

| Layer | Technology | Reason |
|-------|-----------|--------|
| Runtime | Node.js 20+ / TypeScript 5+ | MCP SDK is TypeScript-native, Solana web3.js is TS |
| MCP Server | @modelcontextprotocol/sdk | Standard protocol — 97M monthly downloads, adopted by all major AI providers |
| Chain Simulation | @solana/web3.js simulateTransaction + Helius RPC | Solana v1 only. Adapter pattern allows EVM v2 |
| Policy Engine | Custom TypeScript DSL parser | Chain-abstract rules, no external deps |
| Database | SQLite (better-sqlite3) for local MVP | Zero-config, runs on M5, TotalReclaw precedent |
| Reputation Scorer | TypeScript module reading SQLite | Pure function over audit log data |
| Dashboard | Next.js 15 + Tailwind CSS v4 | ClawStack precedent (ClawPilled.me stack) |
| Testing | Vitest | Fast, TypeScript-native |
| Package Manager | pnpm | Faster than npm, disk-efficient |

**What is NOT in v1:** PostgreSQL, Supabase, Docker, Redis, any cloud service, any bridge protocol (Wormhole/CCIP), any token/staking/slashing mechanism, any EVM chain support.

---

## PROJECT STRUCTURE

```
clawsteward/
├── CLAUDE.md                    # This file
├── README.md                    # Project docs + usage
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example                 # SOLANA_RPC_URL, HELIUS_API_KEY (optional)
│
├── src/
│   ├── index.ts                 # CLI entry point
│   │
│   ├── core/
│   │   ├── types.ts             # All shared TypeScript types/interfaces
│   │   ├── agent.ts             # Agent model (UUIDv7 + chain_signers map)
│   │   ├── policy-engine.ts     # Policy DSL parser + evaluator
│   │   ├── policy-rules.ts      # Built-in rule definitions
│   │   ├── audit-log.ts         # Append-only tamper-evident Steward Log writer
│   │   └── reputation.ts        # Steward Score calculator
│   │
│   ├── chain/
│   │   ├── simulator.ts         # ChainSimulator interface (adapter pattern)
│   │   ├── solana-adapter.ts    # Solana simulateTransaction implementation
│   │   └── types.ts             # Chain-specific types
│   │
│   ├── mcp/
│   │   ├── server.ts            # MCP server (policy gate + reputation read)
│   │   ├── tools.ts             # MCP tool definitions
│   │   └── handlers.ts          # Request handlers
│   │
│   ├── db/
│   │   ├── schema.sql           # SQLite schema
│   │   ├── database.ts          # Database connection + migrations
│   │   └── queries.ts           # Prepared query functions
│   │
│   ├── dashboard/               # Next.js app (separate package.json)
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx         # Steward Leaderboard home
│   │   │   ├── agent/[id]/
│   │   │   │   └── page.tsx     # Individual agent detail
│   │   │   └── api/
│   │   │       ├── leaderboard/route.ts
│   │   │       └── agent/[id]/route.ts
│   │   └── components/
│   │       ├── LeaderboardTable.tsx
│   │       ├── AgentScoreCard.tsx
│   │       ├── ViolationHistory.tsx
│   │       └── StewardBadge.tsx
│   │
│   └── cli/
│       ├── scan.ts              # Free scan command (Sentinel playbook)
│       └── report.ts            # Generate markdown report
│
├── policies/
│   ├── default.json             # Default policy set
│   └── examples/
│       ├── conservative.json    # Low-risk policy template
│       ├── aggressive.json      # High-risk tolerance template
│       └── institutional.json   # Compliance-heavy template
│
└── test/
    ├── core/
    │   ├── policy-engine.test.ts
    │   ├── audit-log.test.ts
    │   └── reputation.test.ts
    ├── chain/
    │   └── solana-adapter.test.ts
    ├── mcp/
    │   └── server.test.ts
    └── fixtures/
        ├── mock-transactions.ts
        └── mock-policies.ts
```

---

## CORE TYPES (src/core/types.ts)

These types are the foundation. Every other module imports from here. Get these right.

```typescript
// Agent identity — chain-agnostic by design
// UUIDv7 is primary key, NEVER wallet address
interface Agent {
  id: string;                    // UUIDv7 (time-sortable, collision-proof)
  name: string;                  // Human-readable label
  chain_signers: Record<string, string>;  // { "solana": "pubkey", "base": "0x..." }
  registered_at: string;         // ISO 8601
  metadata: Record<string, unknown>;      // Extensible
}

// Chain-abstract policy rule
// Rules NEVER reference chain-specific concepts (gas, compute units, priority fees)
// Translation to chain-specific happens inside the adapter
interface PolicyRule {
  id: string;
  type: PolicyRuleType;
  params: Record<string, number | string | string[]>;
  severity: "critical" | "high" | "medium" | "low";
  enabled: boolean;
}

type PolicyRuleType =
  | "max_usd_value"              // Single tx value cap
  | "max_slippage_pct"           // Slippage tolerance
  | "velocity_24h_usd"           // Rolling 24h volume cap
  | "velocity_1h_count"          // Tx count per hour
  | "blacklist_counterparties"   // Blocked addresses
  | "whitelist_programs"         // Allowed program IDs / contract addresses
  | "concentration_pct"          // Max % of portfolio in single asset
  | "auto_pause_consecutive_violations"  // Pause after N violations in window
  | "max_position_usd"           // Max single position size
  | "custom";                    // Extensible for user-defined rules

interface PolicySet {
  id: string;
  name: string;
  version: number;
  rules: PolicyRule[];
  created_at: string;
  updated_at: string;
}

// Simulation result — chain-abstract output from adapter
interface SimulationResult {
  success: boolean;
  chain: string;                 // "solana" | "base" | "ethereum" | etc
  estimated_usd_value: number;
  estimated_slippage_pct: number;
  counterparties: string[];      // Program IDs or contract addresses involved
  assets_affected: AssetDelta[];
  raw_chain_payload: unknown;    // Chain-specific raw simulation data (JSONB blob)
  simulation_timestamp: string;
  error?: string;
}

interface AssetDelta {
  asset: string;                 // Token mint/address
  symbol: string;
  delta: number;                 // Positive = receive, negative = send
  usd_value: number;
}

// Policy evaluation result
interface PolicyEvaluation {
  passed: boolean;
  violations: PolicyViolation[];
  rules_evaluated: number;
  evaluation_ms: number;
}

interface PolicyViolation {
  rule_id: string;
  rule_type: PolicyRuleType;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  actual_value: number | string;
  threshold_value: number | string;
}

// Steward Log entry — the core data unit
// Steward Score reads ONLY these fields (never raw_chain_payload)
interface StewardLogEntry {
  id: string;                    // UUIDv7
  agent_id: string;
  timestamp: string;             // ISO 8601
  chain: string;
  action: "approve" | "reject" | "error";
  policy_set_id: string;
  rules_evaluated: number;
  violations: PolicyViolation[];
  compliance_score_delta: number; // Impact on rolling score
  estimated_usd_value: number;
  estimated_slippage_pct: number;
  counterparties: string[];
  chain_payload: unknown;        // Raw chain-specific data (JSONB)
}

// Steward Score — derived from Steward Log
interface StewardScore {
  agent_id: string;
  score: number;                 // 0.0 - 10.0
  total_evaluations: number;
  total_violations: number;
  violation_rate: number;        // violations / evaluations
  critical_violations_30d: number;
  last_evaluation: string;
  score_trend: "improving" | "stable" | "declining";
  computed_at: string;
}
```

---

## CHAIN SIMULATOR INTERFACE (src/chain/simulator.ts)

This is the adapter pattern that prevents single-chain lock-in. v1 implements Solana only. Adding EVM later = implement this interface + drop in adapter.

```typescript
// This interface is the multi-chain abstraction layer
// v1: Only SolanaAdapter exists
// v2: Add EvmAdapter (Tenderly/Foundry) — zero changes to core/policy/reputation
interface ChainSimulator {
  chain: string;
  simulate(tx: unknown, context: SimulationContext): Promise<SimulationResult>;
  validateAddress(address: string): boolean;
  estimateUsdValue(assets: AssetDelta[]): Promise<number>;
}

interface SimulationContext {
  agent_id: string;
  rpc_url: string;
  recent_blockhash?: string;
}
```

**CONSTRAINT:** The `tx` parameter is `unknown` deliberately. Each adapter casts to its chain-specific type internally. The core policy engine NEVER touches raw transaction data — it only evaluates the chain-abstract `SimulationResult`.

---

## STEWARD SCORE ALGORITHM (src/core/reputation.ts)

```
StewardScore = 10.0 × (1 - WeightedViolationRate)

WeightedViolationRate = Σ(violation_weight × count) / Σ(evaluation_weight × count)

Violation weights by severity:
  critical: 1.0
  high:     0.6
  medium:   0.3
  low:      0.1

Time decay:
  Last 100 evaluations weighted 3x vs historical
  Evaluations older than 90 days weighted 0.5x

Score bounds: [0.0, 10.0], clamped
Score trend: Compare current score vs 7-day-ago score
  - Improving: current > 7d_ago + 0.3
  - Declining: current < 7d_ago - 0.3
  - Stable: otherwise

Edge cases:
  - Agent with < 10 evaluations: score = null (insufficient data)
  - Agent with 0 violations: score = 10.0
  - Agent paused by auto_pause rule: score frozen until resumed
```

This algorithm is deterministic and reproducible. Given the same Steward Log, any implementation must produce the same score. This is a hard requirement for trust.

---

## MCP SERVER TOOLS (src/mcp/tools.ts)

The MCP server exposes exactly these tools. No more, no less for v1.

```
Tool: steward_evaluate
  Description: Submit an unsigned transaction for policy evaluation
  Input:
    agent_id: string (UUIDv7)
    chain: "solana"
    unsigned_tx: string (base64 encoded serialized transaction)
    policy_set_id?: string (optional, defaults to "default")
  Output:
    approved: boolean
    violations: PolicyViolation[]
    simulation: { usd_value, slippage_pct, counterparties }
    steward_score: number | null
    log_entry_id: string

Tool: steward_register
  Description: Register a new agent with ClawSteward
  Input:
    name: string
    chain: "solana"
    signer_address: string
    metadata?: Record<string, unknown>
  Output:
    agent_id: string (UUIDv7)
    registered: true

Tool: steward_score
  Description: Query the Steward Score for an agent
  Input:
    agent_id: string
  Output:
    StewardScore object (see types above)

Tool: steward_leaderboard
  Description: Get top agents by Steward Score
  Input:
    limit?: number (default 50, max 200)
    min_evaluations?: number (default 10)
  Output:
    agents: Array<{ agent_id, name, score, total_evaluations, violation_rate }>

Tool: steward_scan
  Description: Free scan of a policy set against a mock transaction (Sentinel playbook)
  Input:
    policy_set: PolicySet
    mock_tx_type: "swap" | "transfer" | "lp_add" | "lp_remove"
  Output:
    findings: Array<{ rule_id, description, recommendation }>
    score: number (0-100 policy quality score)
```

---

## SQLITE SCHEMA (src/db/schema.sql)

```sql
-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  name TEXT NOT NULL,
  chain_signers TEXT NOT NULL DEFAULT '{}', -- JSON map
  registered_at TEXT NOT NULL,            -- ISO 8601
  metadata TEXT NOT NULL DEFAULT '{}',    -- JSON
  is_paused INTEGER NOT NULL DEFAULT 0
);

-- Policy sets
CREATE TABLE IF NOT EXISTS policy_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  rules TEXT NOT NULL,                    -- JSON array of PolicyRule
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Steward Log (append-only — NEVER UPDATE OR DELETE)
CREATE TABLE IF NOT EXISTS steward_log (
  id TEXT PRIMARY KEY,                    -- UUIDv7
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,                -- ISO 8601
  chain TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'error')),
  policy_set_id TEXT NOT NULL,
  rules_evaluated INTEGER NOT NULL,
  violations TEXT NOT NULL DEFAULT '[]',  -- JSON array
  compliance_score_delta REAL NOT NULL DEFAULT 0,
  estimated_usd_value REAL,
  estimated_slippage_pct REAL,
  counterparties TEXT NOT NULL DEFAULT '[]', -- JSON array
  chain_payload TEXT,                     -- JSON blob (chain-specific raw data)
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Indexes for Steward Score queries
CREATE INDEX IF NOT EXISTS idx_log_agent_time ON steward_log(agent_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_log_action ON steward_log(action);
CREATE INDEX IF NOT EXISTS idx_log_chain ON steward_log(chain);

-- Steward Score cache (recomputed periodically, not authoritative — log is source of truth)
CREATE TABLE IF NOT EXISTS steward_scores (
  agent_id TEXT PRIMARY KEY,
  score REAL,
  total_evaluations INTEGER,
  total_violations INTEGER,
  violation_rate REAL,
  critical_violations_30d INTEGER,
  last_evaluation TEXT,
  score_trend TEXT CHECK (score_trend IN ('improving', 'stable', 'declining')),
  computed_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Tamper evidence: hash chain on Steward Log
-- Each entry's integrity_hash = SHA-256(prev_hash + entry_id + timestamp + action + violations)
-- Verifiable by replaying from genesis
CREATE TABLE IF NOT EXISTS log_integrity (
  entry_id TEXT PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  integrity_hash TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES steward_log(id)
);

-- Default policy set (inserted on first run)
INSERT OR IGNORE INTO policy_sets (id, name, version, rules, created_at, updated_at)
VALUES (
  'default',
  'Default Steward Policy',
  1,
  '[
    {"id":"r1","type":"max_usd_value","params":{"max":10000},"severity":"critical","enabled":true},
    {"id":"r2","type":"max_slippage_pct","params":{"max":3.0},"severity":"high","enabled":true},
    {"id":"r3","type":"velocity_24h_usd","params":{"max":50000},"severity":"high","enabled":true},
    {"id":"r4","type":"velocity_1h_count","params":{"max":20},"severity":"medium","enabled":true},
    {"id":"r5","type":"auto_pause_consecutive_violations","params":{"threshold":3,"window_minutes":60},"severity":"critical","enabled":true}
  ]',
  datetime('now'),
  datetime('now')
);
```

**CONSTRAINT ON STEWARD LOG:** The steward_log table is append-only. Never write UPDATE or DELETE queries against it. The log_integrity table creates a hash chain for tamper evidence. If you find yourself modifying log entries, stop — you are violating the core trust guarantee.

---

## POLICY DSL (policies/default.json)

```json
{
  "id": "default",
  "name": "Default Steward Policy",
  "version": 1,
  "rules": [
    {
      "id": "max-tx-value",
      "type": "max_usd_value",
      "params": { "max": 10000 },
      "severity": "critical",
      "enabled": true
    },
    {
      "id": "slippage-guard",
      "type": "max_slippage_pct",
      "params": { "max": 3.0 },
      "severity": "high",
      "enabled": true
    },
    {
      "id": "daily-volume-cap",
      "type": "velocity_24h_usd",
      "params": { "max": 50000 },
      "severity": "high",
      "enabled": true
    },
    {
      "id": "hourly-tx-limit",
      "type": "velocity_1h_count",
      "params": { "max": 20 },
      "severity": "medium",
      "enabled": true
    },
    {
      "id": "auto-pause",
      "type": "auto_pause_consecutive_violations",
      "params": { "threshold": 3, "window_minutes": 60 },
      "severity": "critical",
      "enabled": true
    }
  ]
}
```

**All policy params use chain-abstract units (USD, percentages, counts, time).** The chain adapter translates chain-specific data into these units before the policy engine evaluates. The policy engine NEVER receives lamports, compute units, priority fees, or any chain-native denomination.

---

## DASHBOARD SPEC (src/dashboard/)

**Design:** Terminal Luxe — dark mode, orange accents (ClawStack brand continuity with ClawPilled.me). NOT generic AI aesthetic.

**Pages:**
1. **/ (Steward Leaderboard)** — Table of agents ranked by Steward Score. Columns: Rank, Agent Name, Steward Score (0-10 with color badge), Total Evals, Violation Rate, Trend Arrow, Last Active. Filterable by min evaluations. Refreshes every 60s.

2. **/agent/[id] (Agent Detail)** — Steward Score card (large score number + trend), violation history timeline, policy compliance breakdown by rule type, recent 50 evaluations table, chain signer addresses. Include a "ClawSteward-verified" badge component that protocols can reference.

**API routes read directly from SQLite** (same DB file as the core). No separate backend needed for v1.

**Color system:**
- Background: #0F1419
- Cards: #1E293B
- Accent: #F97316 (ClawStack orange)
- Steward Score 8-10: #10B981 (green) — "ClawSteward-verified"
- Steward Score 5-7.9: #F59E0B (amber) — "Under Review"
- Steward Score 0-4.9: #EF4444 (red) — "High Risk"
- Score null (< 10 evals): #6B7280 (gray) — "Insufficient Data"
- Text: #F8FAFC
- Muted: #94A3B8

---

## CLI COMMANDS (src/cli/)

```bash
# Start MCP server
clawsteward serve

# Register an agent
clawsteward register --name "MyAgent" --chain solana --signer <pubkey>

# Free scan of a policy file (Sentinel playbook — generates report)
clawsteward scan --policy policies/default.json --output steward-report.md

# View Steward Leaderboard
clawsteward leaderboard --limit 20

# Query Steward Score
clawsteward score <agent_id>

# Start dashboard
clawsteward dashboard --port 3000

# Export Steward Log (for compliance)
clawsteward export --agent <agent_id> --format json --output steward-log.json

# Verify Steward Log integrity (hash chain validation)
clawsteward verify
```

---

## TESTING REQUIREMENTS

Minimum test coverage for v1 ship:

| Module | Tests Required | Priority |
|--------|---------------|----------|
| policy-engine.ts | All 10 rule types × pass/fail × edge cases | P0 |
| reputation.ts | Steward Score calculation, time decay, edge cases (< 10 evals, 0 violations) | P0 |
| audit-log.ts | Append-only enforcement, hash chain integrity verification | P0 |
| solana-adapter.ts | Mock simulation responses, error handling, timeout | P1 |
| mcp/server.ts | All 5 tools: valid input, invalid input, error paths | P1 |
| agent.ts | Registration, UUIDv7 generation, chain_signers map | P2 |

**Test philosophy:** Every test must be deterministic. No network calls in unit tests. Mock the Solana RPC. Integration tests (marked separately) can hit devnet.

Target: **50+ tests passing before v1 ships.** This is non-negotiable — TotalReclaw shipped with 113 tests and that set the ClawStack quality bar.

---

## BUILD SEQUENCE (3-WEEK SPRINT)

### Week 1: Core Engine (Days 1-7)
- Day 1-2: Project scaffold, types.ts, SQLite schema, database.ts
- Day 3-4: policy-engine.ts + all rule types + tests
- Day 5: audit-log.ts + hash chain integrity + tests
- Day 6: reputation.ts + Steward Score algorithm + tests
- Day 7: agent.ts + registration + tests
- **Gate:** 30+ tests passing, core engine works without network

### Week 2: Chain + MCP (Days 8-14)
- Day 8-9: ChainSimulator interface + Solana adapter + mock tests
- Day 10-11: MCP server + all 5 tools + handler tests
- Day 12: CLI commands (serve, register, scan, score)
- Day 13: Integration test: full flow (register → simulate → evaluate → log → score)
- Day 14: CLI scan command + markdown report generation (Sentinel playbook)
- **Gate:** 50+ tests passing, MCP server runs locally, can evaluate mock txs

### Week 3: Dashboard + Ship (Days 15-21)
- Day 15-17: Next.js dashboard (Steward Leaderboard + agent detail)
- Day 18: CLI polish, README.md, .env.example, error handling pass
- Day 19: End-to-end testing against Solana devnet
- Day 20: Security review (no secrets in logs, input validation, SQL injection prevention)
- Day 21: Ship to GitHub (github.com/SkunkWorks0x/clawsteward), post launch thread
- **Gate:** Clean README, all tests pass, dashboard renders, MCP server connects

---

## WHAT IS NOT IN V1 (EXPLICIT SCOPE BOUNDARIES)

Do NOT build any of these. They are v2+.

- EVM/Base chain adapter
- Token economics / staking / slashing
- Cloud-hosted reputation database
- Cross-chain log attestation (Wormhole/CCIP)
- zkML or TEE attestation
- WebSocket real-time feeds
- User authentication / API keys on dashboard
- Rate limiting on MCP server (trust-based v1)
- Paid tier billing / Stripe integration
- Mobile app
- Agent-to-agent memory sharing via A2A protocol

---

## KNOWN RISKS AND HONEST LIMITATIONS

1. **Solana simulateTransaction is not perfect** — it simulates against current state, which can change by the time the real tx lands. This is a fundamental limitation of pre-signing simulation on any chain. Document it, don't hide it.

2. **USD price estimation requires an oracle** — you need token prices to evaluate USD-denominated rules. For v1, use Jupiter Price API (free, Solana-native). This is an external dependency. If Jupiter is down, USD-based rules cannot evaluate. Fallback: skip USD rules and log warning.

3. **MEV risk on simulation data** — if ClawSteward's simulation queries leak tx intent to public RPCs, MEV searchers can front-run. For v1, document this risk. For v2, integrate Jito or private RPC. This was flagged by Grok swarm as a credibility concern.

4. **Solo maintainer bus factor** — this is open-core software with one developer. Document architecture decisions thoroughly so the codebase is readable by future contributors.

5. **Steward Scores are only as good as the data** — agents that don't use ClawSteward have no score. A score of null (insufficient data) is NOT the same as a score of 0. The UI must make this distinction clear.

---

## SUCCESS CRITERIA FOR V1

- [ ] All CLI commands work
- [ ] MCP server starts and accepts connections from any MCP client
- [ ] Policy engine evaluates all 10 rule types correctly
- [ ] Steward Log maintains hash chain integrity (verifiable via CLI)
- [ ] Steward Scores compute correctly for test agents
- [ ] Dashboard renders Steward Leaderboard and agent detail pages
- [ ] Free scan generates markdown report (Sentinel playbook)
- [ ] 50+ tests passing
- [ ] README documents installation, usage, and architecture
- [ ] Ships to GitHub public repo
- [ ] Zero external cloud dependencies (runs entirely on MacBook)
