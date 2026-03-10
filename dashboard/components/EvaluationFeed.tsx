"use client";

import { useState } from "react";
import type { EvaluationEntry } from "@/lib/queries";

const SEVERITY_DOT_COLORS: Record<string, string> = {
  critical: "#EF4444",
  high: "#F97316",
  medium: "#F59E0B",
  low: "#6B7280",
};

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function EvaluationRow({ entry }: { entry: EvaluationEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-white/5 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
      >
        <span className="mt-0.5 shrink-0 font-mono text-xs text-[#6B7280]">
          {relativeTime(entry.timestamp)}
        </span>

        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
            entry.action === "approve"
              ? "bg-[#10B981]/20 text-[#10B981]"
              : entry.action === "reject"
                ? "bg-[#EF4444]/20 text-[#EF4444]"
                : "bg-[#6B7280]/20 text-[#6B7280]"
          }`}
        >
          {entry.action === "approve" ? "APPROVED" : entry.action === "reject" ? "REJECTED" : "ERROR"}
        </span>

        <span className="flex-1 text-sm text-[#F8FAFC]">
          {entry.violations.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {entry.violations.map((v, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-xs text-[#94A3B8]">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: SEVERITY_DOT_COLORS[v.severity] ?? "#6B7280" }}
                  />
                  {v.rule_type.replace(/_/g, " ")}
                </span>
              ))}
            </span>
          )}
          {entry.violations.length === 0 && entry.action === "approve" && (
            <span className="text-xs text-[#94A3B8]">All rules passed</span>
          )}
        </span>

        {entry.estimated_usd_value != null && (
          <span className="shrink-0 font-mono text-xs text-[#94A3B8]">
            ${entry.estimated_usd_value.toLocaleString()}
          </span>
        )}

        <span className="shrink-0 text-xs text-[#6B7280]">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-white/5 bg-white/[0.02] px-4 py-3">
          <div className="mb-2 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
            <div>
              <span className="text-[#6B7280]">Chain</span>
              <p className="font-mono text-[#F8FAFC]">{entry.chain}</p>
            </div>
            <div>
              <span className="text-[#6B7280]">Rules Evaluated</span>
              <p className="font-mono text-[#F8FAFC]">{entry.rules_evaluated}</p>
            </div>
            <div>
              <span className="text-[#6B7280]">USD Value</span>
              <p className="font-mono text-[#F8FAFC]">
                {entry.estimated_usd_value != null ? `$${entry.estimated_usd_value.toLocaleString()}` : "—"}
              </p>
            </div>
            <div>
              <span className="text-[#6B7280]">Slippage</span>
              <p className="font-mono text-[#F8FAFC]">
                {entry.estimated_slippage_pct != null ? `${entry.estimated_slippage_pct}%` : "—"}
              </p>
            </div>
          </div>

          {entry.violations.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold text-[#94A3B8]">Violations</p>
              <pre className="overflow-x-auto rounded-lg bg-[#0F1419] p-3 font-mono text-xs text-[#F8FAFC]">
                {JSON.stringify(entry.violations, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EvaluationFeed({
  evaluations,
}: {
  evaluations: EvaluationEntry[];
}) {
  if (evaluations.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-[#6B7280]">
        No evaluations yet
      </div>
    );
  }

  return (
    <div className="divide-y divide-white/5">
      {evaluations.map((entry) => (
        <EvaluationRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
