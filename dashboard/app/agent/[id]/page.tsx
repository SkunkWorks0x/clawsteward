import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db";
import {
  getAgentDetail,
  getAgentRecentEvaluations,
  getAgentViolationBreakdown,
  getAgentScoreHistory,
  getAgentIntegrityStatus,
  getScoreColor,
} from "@/lib/queries";
import StewardBadge from "@/components/StewardBadge";
import TrendArrow from "@/components/TrendArrow";
import ScoreTrendChart from "@/components/ScoreTrendChart";
import ViolationBreakdown from "@/components/ViolationBreakdown";
import EvaluationFeed from "@/components/EvaluationFeed";

export const dynamic = "force-dynamic";

function relativeDate(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const days = Math.floor((now - then) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function ScoreRing({ score, color }: { score: number | null; color: string }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const filled = score !== null ? (score / 10) * circumference : 0;

  return (
    <svg width="140" height="140" viewBox="0 0 140 140">
      {/* Background ring */}
      <circle
        cx="70"
        cy="70"
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="8"
      />
      {/* Filled ring */}
      <circle
        cx="70"
        cy="70"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeDasharray={`${filled} ${circumference - filled}`}
        strokeDashoffset={circumference * 0.25}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.6s ease" }}
      />
      {/* Score text */}
      <text
        x="70"
        y="70"
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontFamily="var(--font-geist-mono)"
        fontSize="32"
        fontWeight="bold"
      >
        {score !== null ? score.toFixed(1) : "N/A"}
      </text>
    </svg>
  );
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let agent;
  let recentEvaluations;
  let violationBreakdown;
  let scoreHistory;
  let integrityStatus;

  try {
    const db = getDatabase();
    agent = getAgentDetail(db, id);
    if (agent) {
      recentEvaluations = getAgentRecentEvaluations(db, id, 20);
      violationBreakdown = getAgentViolationBreakdown(db, id);
      scoreHistory = getAgentScoreHistory(db, id, 20);
      integrityStatus = getAgentIntegrityStatus(db, id);
    }
  } catch {
    agent = null;
  }

  if (!agent) {
    notFound();
  }

  const scoreColor = getScoreColor(agent.badge);

  return (
    <div className="space-y-6">
      {/* Section 1: Agent Header */}
      <div className="rounded-xl border border-white/5 bg-[#1E293B] p-6">
        <Link href="/" className="mb-4 inline-block text-sm text-[#F97316] hover:underline">
          ← Leaderboard
        </Link>

        {agent.is_paused && (
          <div className="mb-4 rounded-lg bg-[#EF4444]/10 px-4 py-2 text-sm text-[#EF4444]">
            ⚠ Agent Paused — auto-paused after consecutive policy violations
          </div>
        )}

        <h1 className="text-2xl font-bold text-white">{agent.name}</h1>
        <p className="mt-1 font-mono text-sm text-[#6B7280]">{agent.id}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {Object.entries(agent.chain_signers).map(([chain, addr]) => (
            <span
              key={chain}
              className="rounded-full bg-white/5 px-3 py-1 font-mono text-xs text-[#94A3B8]"
            >
              {chain}: {truncateAddress(addr)}
            </span>
          ))}
          <span className="text-xs text-[#6B7280]">
            Registered {relativeDate(agent.registered_at)}
          </span>
        </div>
      </div>

      {/* Section 2: Score Card */}
      <div className="rounded-xl border border-white/5 bg-[#1E293B] p-6">
        <div className="flex flex-col items-center gap-4">
          <ScoreRing score={agent.score} color={scoreColor} />
          <StewardBadge badge={agent.badge} />
          <div className="flex items-center gap-2">
            <TrendArrow trend={agent.score_trend} />
            <span className="text-sm text-[#94A3B8]">
              {agent.score_trend === "improving"
                ? "Improving"
                : agent.score_trend === "declining"
                  ? "Declining"
                  : "Stable"}
            </span>
          </div>
        </div>
      </div>

      {/* Section 3: Stats Row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-white/5 bg-[#1E293B] p-4">
          <p className="text-xs uppercase tracking-wider text-[#6B7280]">Total Evaluations</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white">{agent.total_evaluations}</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-[#1E293B] p-4">
          <p className="text-xs uppercase tracking-wider text-[#6B7280]">Approval Rate</p>
          <p
            className="mt-1 font-mono text-2xl font-bold"
            style={{
              color:
                agent.approval_rate >= 80
                  ? "#10B981"
                  : agent.approval_rate >= 50
                    ? "#F59E0B"
                    : "#EF4444",
            }}
          >
            {agent.approval_rate}%
          </p>
        </div>
        <div className="rounded-xl border border-white/5 bg-[#1E293B] p-4">
          <p className="text-xs uppercase tracking-wider text-[#6B7280]">Violations</p>
          <p className="mt-1 font-mono text-2xl font-bold text-[#EF4444]">{agent.total_violations}</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-[#1E293B] p-4">
          <p className="text-xs uppercase tracking-wider text-[#6B7280]">Critical (30d)</p>
          <p
            className="mt-1 font-mono text-2xl font-bold"
            style={{ color: agent.critical_violations_30d > 0 ? "#EF4444" : "#10B981" }}
          >
            {agent.critical_violations_30d}
          </p>
        </div>
      </div>

      {/* Section 4: Score Trend Chart */}
      <div className="rounded-xl border border-white/5 bg-[#1E293B] p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Score Trend</h2>
        <ScoreTrendChart data={scoreHistory ?? []} scoreColor={scoreColor} />
      </div>

      {/* Section 5: Violation Breakdown */}
      <div className="rounded-xl border border-white/5 bg-[#1E293B] p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Violation Breakdown</h2>
        <ViolationBreakdown breakdown={violationBreakdown ?? { by_severity: {}, by_rule_type: {}, total: 0 }} />
      </div>

      {/* Section 6: Recent Evaluations Feed */}
      <div className="rounded-xl border border-white/5 bg-[#1E293B] p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Recent Evaluations</h2>
        <EvaluationFeed evaluations={recentEvaluations ?? []} />
      </div>

      {/* Section 7: Integrity Status */}
      <div className="rounded-xl border border-white/5 bg-[#1E293B] p-6">
        {integrityStatus?.valid ? (
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#10B981]/20 text-lg text-[#10B981]">
              &#x1F6E1;
            </span>
            <div>
              <p className="font-semibold text-[#10B981]">
                Steward Log Integrity: Verified &#10003;
              </p>
              <p className="text-sm text-[#94A3B8]">
                {integrityStatus.entries_checked} entries, unbroken hash chain
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#EF4444]/20 text-lg text-[#EF4444]">
              ⚠
            </span>
            <div>
              <p className="font-semibold text-[#EF4444]">
                Steward Log Integrity: COMPROMISED ⚠
              </p>
              <p className="text-sm text-[#94A3B8]">
                Tamper detected — audit trail may be unreliable
                {integrityStatus?.error && ` (${integrityStatus.error})`}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
