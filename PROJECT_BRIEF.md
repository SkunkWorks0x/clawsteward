# PROJECT BRIEF — ClawSteward by ClawStack

## Origin

This project spec was produced through 5 rounds of adversarial pressure testing between Claude Opus 4.6 and Grok 4.20 Swarm (4-agent: Grok coordinator + Harper fact-check + Benjamin technical + Lucas creative). The name "ClawSteward" was selected in a dedicated naming session where Lucas generated 12 candidates, Benjamin verified zero npm/GitHub conflicts, and Harper confirmed no trademark collisions across CoinGecko, npm registry, and GitHub orgs.

## Strategic Context

DeFAI (Decentralized Finance + AI) is a $10.8B sector where autonomous AI agents execute on-chain financial transactions. 40% of on-chain transactions are now agent-initiated. The sector is building offense (trading, yield, abstraction) without building defense (policy enforcement, audit trails, reputation, compliance).

No US legislation addresses AI agents operating on-chain. The GENIUS Act covers stablecoins only. The CLARITY Act (market structure) leaves DeFi/DeFAI treatment undefined. "Know Your Agent" standards are coming but don't exist yet. The builder who ships defense infrastructure now defines the standard.

## Product Thesis

ClawSteward is a pre-signing policy enforcement gate for DeFAI agents. Agents submit unsigned transactions → ClawSteward simulates and evaluates against configurable policy rules → approves or rejects → logs everything in a tamper-evident Steward Log → derives behavioral Steward Scores from the log.

The Reputation Layer (Steward Score) is not a separate product — it's a read layer on top of ClawSteward's audit trail. Together they form a trust infrastructure stack: ClawSteward generates compliance data, Steward Score makes it queryable and visible.

## Brand Architecture

- **Parent brand:** ClawStack
- **Product name:** ClawSteward
- **Reputation score:** Steward Score (0.0 - 10.0)
- **Compliance badge:** "ClawSteward-verified"
- **Audit trail:** Steward Log
- **Public ranking:** Steward Leaderboard
- **Ecosystem fit:** ClawStack Sentinel (scans) → ClawSteward (enforces) → TotalReclaw (remembers)

## Why Solana First

- ClawStack brand is Solana-adjacent (OpenClaw ecosystem)
- ElizaOS + Griffain agent ecosystems are Solana-heavy
- Base + Solana = ~70-75% of DeFAI agent volume. Solana gives faster GTM with existing audience
- Solana simulation tooling is production-grade (native RPC simulateTransaction + Helius)
- Lower fees = higher agent tx volume = more data for Steward Scores
- X audience overlap with Solana DeFAI community

## Multi-Chain Architecture

The codebase is designed chain-agnostic from day one despite shipping Solana-only in v1:
- Agent identity uses UUIDv7 (not wallet address) as primary key
- Policy DSL is 100% chain-abstract (USD, percentages, counts — never gas/lamports)
- Chain simulation uses adapter pattern (interface + per-chain implementation)
- Steward Log stores chain-specific data in a JSONB blob alongside standardized fields
- Steward Score reads only standardized fields, never chain-specific data

Adding EVM support in v2 = implement ChainSimulator interface for Tenderly/Foundry. Zero changes to core policy engine, Steward Score, MCP server, or database schema.

## GTM (Go-to-Market)

1. Ship CLI + MCP server + free scanner (Sentinel playbook)
2. Open-source core on GitHub (github.com/SkunkWorks0x/clawsteward)
3. X reply-first: respond to every DeFAI exploit with "Here's how ClawSteward would have caught it"
4. Free scans of top DeFAI protocols by TVL
5. Daily "Steward Leaderboard" posts from live data (earned media flywheel)
6. Publish "DeFAI Security Report" for press/credibility

## Revenue Model (Post-v1)

- Free: Basic policy rules, local-only, limited scan
- Pro ($99-$499/mo): Custom policy sets, alerting, Steward Log export, protocol-level deployment
- Enterprise: SOC 2-adjacent reporting, custom integration, SLA

## What Comes After v1

Phase 2 (Month 2-3): EVM/Base adapter, cloud-hosted Steward Score option, webhook alerts
Phase 3 (Month 4-6): Agent Reputation staking/slashing economic layer (if adoption warrants)
Phase 4 (Month 6+): SentinelNet-style public risk dashboard, institutional compliance reporting

## Key Technical Decisions Log

| Decision | Choice | Reasoning | Alternative Considered |
|----------|--------|-----------|----------------------|
| Product name | ClawSteward | "Steward" = responsible oversight + reputation. Verbs naturally. ClawStack brand leverage. Zero conflicts confirmed by Grok Harper | Firewall (wrong metaphor), Veripact (fragments brand), ClawAttest (too narrow) |
| Transaction enforcement model | Pre-signing simulation gate | Cannot intercept on-chain without wallet control (Grok correction) | Runtime interception (impossible without custodial control) |
| Agent ID format | UUIDv7 | Time-sortable, collision-proof, chain-agnostic | Wallet address (chain-specific, breaks multi-chain) |
| Policy DSL units | Chain-abstract (USD, %) | Multi-chain ready, user-friendly | Chain-native (lamports, gwei — fragments across chains) |
| Chain abstraction | Adapter interface pattern | 20 lines of TS, zero overhead, clean v2 path | No abstraction (faster v1 but rewrite for v2) |
| v1 chain | Solana only | Brand fit, agent volume, simulation tooling, GTM speed | EVM-first (better tooling but weaker brand leverage) |
| Database | SQLite (better-sqlite3) | Zero config, M5-native, TotalReclaw precedent | PostgreSQL (overkill for solo MVP) |
| Audit integrity | SHA-256 hash chain | Tamper-evident, verifiable, no blockchain needed for v1 | On-chain storage (expensive, unnecessary for MVP) |
| Reputation scoring | Deterministic weighted formula | Reproducible, auditable, no ML black box | ML-based scoring (opaque, hard to trust) |
| Dashboard stack | Next.js 15 + Tailwind v4 | ClawPilled.me precedent, Imani knows the stack | Separate React SPA (extra complexity) |
| USD pricing oracle | Jupiter Price API | Free, Solana-native, reliable | Pyth/Chainlink (more setup, overkill for v1) |
| MCP protocol | @modelcontextprotocol/sdk | 97M monthly downloads, universal adoption | REST API (works but misses the agentic ecosystem) |
