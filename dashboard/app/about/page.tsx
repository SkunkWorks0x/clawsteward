import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About ClawSteward — ClawStack",
  description:
    "Learn how ClawSteward enforces pre-signing policy gates for DeFAI agents and computes behavioral reputation scores.",
};

const badgeTiers = [
  {
    label: "ClawSteward-verified",
    range: "8.0 - 10.0",
    color: "#10B981",
    bg: "rgba(16, 185, 129, 0.1)",
    border: "rgba(16, 185, 129, 0.3)",
  },
  {
    label: "Under Review",
    range: "5.0 - 7.9",
    color: "#F59E0B",
    bg: "rgba(245, 158, 11, 0.1)",
    border: "rgba(245, 158, 11, 0.3)",
  },
  {
    label: "High Risk",
    range: "0.0 - 4.9",
    color: "#EF4444",
    bg: "rgba(239, 68, 68, 0.1)",
    border: "rgba(239, 68, 68, 0.3)",
  },
  {
    label: "Insufficient Data",
    range: "null",
    color: "#6B7280",
    bg: "rgba(107, 114, 128, 0.1)",
    border: "rgba(107, 114, 128, 0.3)",
  },
];

const policyRules = [
  {
    type: "max_usd_value",
    description: "Maximum USD value per transaction",
  },
  {
    type: "max_slippage_pct",
    description: "Maximum allowed slippage percentage",
  },
  {
    type: "velocity_24h_usd",
    description: "Maximum USD volume in rolling 24-hour window",
  },
  {
    type: "velocity_1h_count",
    description: "Maximum transaction count in rolling 1-hour window",
  },
  {
    type: "blacklist_counterparties",
    description: "Block transactions to specific addresses",
  },
  {
    type: "whitelist_programs",
    description: "Only allow interactions with approved programs",
  },
  {
    type: "concentration_pct",
    description: "Maximum portfolio concentration in a single asset",
  },
  {
    type: "auto_pause_consecutive_violations",
    description: "Auto-pause agent after N consecutive violations",
  },
  {
    type: "max_position_usd",
    description: "Maximum position size in USD",
  },
  {
    type: "custom",
    description: "User-defined custom rule logic",
  },
];

const severityWeights = [
  { level: "Critical", weight: "1.0", color: "#EF4444" },
  { level: "High", weight: "0.6", color: "#F59E0B" },
  { level: "Medium", weight: "0.3", color: "#F97316" },
  { level: "Low", weight: "0.1", color: "#6B7280" },
];

const flowSteps = [
  "DeFAI Agent",
  "Transaction",
  "ClawSteward Gate",
  "Simulate",
  "Evaluate Policy",
  "Approve / Reject",
  "Steward Log",
  "Steward Score",
];

export default function AboutPage() {
  return (
    <div className="space-y-16">
      {/* Hero */}
      <section>
        <h1 className="text-3xl font-bold text-white">
          What is ClawSteward?
        </h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-[#94A3B8]">
          ClawSteward is a pre-signing policy enforcement gate for DeFAI agents.
          Before an AI agent signs a transaction, ClawSteward simulates it,
          evaluates it against configurable policy rules, and either approves or
          rejects it. Every decision is logged to a tamper-evident audit trail
          called the Steward Log.
        </p>
      </section>

      {/* How Scoring Works */}
      <section>
        <h2 className="text-2xl font-bold text-white">How Scoring Works</h2>
        <p className="mt-2 text-[#94A3B8]">
          The{" "}
          <span className="font-semibold text-[#F97316]">Steward Score</span>{" "}
          ranges from <span className="font-mono text-white">0.0</span> to{" "}
          <span className="font-mono text-white">10.0</span>.
        </p>

        {/* Badge Tiers */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {badgeTiers.map((tier) => (
            <div
              key={tier.label}
              className="rounded-lg border p-5"
              style={{
                backgroundColor: tier.bg,
                borderColor: tier.border,
              }}
            >
              <div
                className="text-sm font-bold uppercase tracking-wide"
                style={{ color: tier.color }}
              >
                {tier.label}
              </div>
              <div
                className="mt-2 font-mono text-2xl font-bold"
                style={{ color: tier.color }}
              >
                {tier.range}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-[#94A3B8]">
          Scores are derived from behavioral history — violation severity,
          frequency, recency, and trend. Agents with consistent policy compliance
          earn higher scores.
        </p>

        {/* Severity Weights */}
        <div className="mt-6">
          <h3 className="text-lg font-semibold text-white">Severity Weights</h3>
          <div className="mt-3 inline-grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
            {severityWeights.map((s) => (
              <div key={s.level} className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-sm text-[#F8FAFC]">{s.level}</span>
                <span className="font-mono text-sm text-[#94A3B8]">
                  {s.weight}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Time Decay */}
        <div className="mt-6 rounded-lg border border-white/10 bg-[#1E293B] p-5">
          <h3 className="text-lg font-semibold text-white">Time Decay</h3>
          <p className="mt-2 text-sm text-[#94A3B8]">
            Recent behavior is weighted 3x. Activity older than 90 days decays
            to 0.5x.
          </p>
        </div>
      </section>

      {/* Policy Rules */}
      <section>
        <h2 className="text-2xl font-bold text-white">Policy Rules</h2>
        <p className="mt-2 text-[#94A3B8]">
          ClawSteward evaluates transactions against 10 configurable rule types.
        </p>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {policyRules.map((rule, i) => (
            <div
              key={rule.type}
              className="rounded-lg border border-white/10 bg-[#1E293B] p-5"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#F97316]/10 font-mono text-xs font-bold text-[#F97316]">
                  {i + 1}
                </span>
                <div>
                  <div className="font-mono text-sm font-semibold text-[#F8FAFC]">
                    {rule.type}
                  </div>
                  <p className="mt-1 text-sm text-[#94A3B8]">
                    {rule.description}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture Flow */}
      <section>
        <h2 className="text-2xl font-bold text-white">Architecture</h2>
        <p className="mt-2 text-[#94A3B8]">
          ClawSteward operates as a pre-signing simulation gate. Transactions are
          evaluated before the agent signs and broadcasts.
        </p>
        <div className="mt-6 overflow-x-auto">
          <div className="flex items-center gap-0 py-4">
            {flowSteps.map((step, i) => (
              <div key={step} className="flex items-center">
                <div
                  className={`whitespace-nowrap rounded-lg border px-4 py-3 text-center text-sm font-medium ${
                    step === "ClawSteward Gate"
                      ? "border-[#F97316]/50 bg-[#F97316]/10 text-[#F97316]"
                      : step === "Approve / Reject"
                        ? "border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981]"
                        : step === "Steward Score"
                          ? "border-[#F97316]/30 bg-[#F97316]/5 text-[#F97316]"
                          : "border-white/10 bg-[#1E293B] text-[#F8FAFC]"
                  }`}
                >
                  {step}
                </div>
                {i < flowSteps.length - 1 && (
                  <span className="mx-1 text-[#94A3B8]">&rarr;</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Links */}
      <section>
        <h2 className="text-2xl font-bold text-white">Links</h2>
        <div className="mt-4 flex flex-wrap gap-4">
          <a
            href="https://github.com/SkunkWorks0x/clawsteward"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-white/10 bg-[#1E293B] px-5 py-3 text-sm font-medium text-[#F8FAFC] transition-colors hover:border-[#F97316]/50 hover:text-[#F97316]"
          >
            GitHub
          </a>
          <a
            href="https://clawstack.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-white/10 bg-[#1E293B] px-5 py-3 text-sm font-medium text-[#F8FAFC] transition-colors hover:border-[#F97316]/50 hover:text-[#F97316]"
          >
            ClawStack
          </a>
          <a
            href="https://x.com/SkunkWorks0x"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-white/10 bg-[#1E293B] px-5 py-3 text-sm font-medium text-[#F8FAFC] transition-colors hover:border-[#F97316]/50 hover:text-[#F97316]"
          >
            Built by @SkunkWorks0x
          </a>
        </div>
      </section>
    </div>
  );
}
