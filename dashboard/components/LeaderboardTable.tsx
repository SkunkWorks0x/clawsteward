"use client";

import { useState } from "react";
import Link from "next/link";
import type { LeaderboardEntry } from "@/lib/queries";
import ScorePill from "./ScorePill";
import StewardBadge from "./StewardBadge";
import TrendArrow from "./TrendArrow";

type SortKey = "rank" | "score" | "evaluations" | "approval_rate";

export default function LeaderboardTable({
  entries,
}: {
  entries: LeaderboardEntry[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortAsc, setSortAsc] = useState(true);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl bg-[#1E293B] p-12 text-center">
        <p className="text-lg text-[#94A3B8]">No agents registered yet.</p>
        <p className="mt-2 font-mono text-sm text-[#6B7280]">
          Start by running:{" "}
          <code className="text-[#F97316]">
            clawsteward register --name &lt;agent-name&gt;
          </code>
        </p>
      </div>
    );
  }

  const sorted = [...entries].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "score":
        cmp = (a.score ?? -1) - (b.score ?? -1);
        break;
      case "evaluations":
        cmp = a.total_evaluations - b.total_evaluations;
        break;
      case "approval_rate":
        cmp = a.approval_rate - b.approval_rate;
        break;
      default:
        cmp = a.rank - b.rank;
    }
    return sortAsc ? cmp : -cmp;
  });

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "rank");
    }
  }

  const thClass =
    "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#94A3B8] cursor-pointer hover:text-white transition-colors select-none";

  return (
    <div className="overflow-x-auto rounded-xl bg-[#1E293B]">
      <table className="w-full">
        <thead className="border-b border-white/10">
          <tr>
            <th className={`${thClass} text-right`} onClick={() => handleSort("rank")}>
              # {sortKey === "rank" && (sortAsc ? "\u25B2" : "\u25BC")}
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#94A3B8]">
              Agent
            </th>
            <th className={thClass} onClick={() => handleSort("score")}>
              Steward Score{" "}
              {sortKey === "score" && (sortAsc ? "\u25B2" : "\u25BC")}
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#94A3B8]">
              Trend
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#94A3B8]">
              Badge
            </th>
            <th className={thClass} onClick={() => handleSort("evaluations")}>
              Evaluations{" "}
              {sortKey === "evaluations" && (sortAsc ? "\u25B2" : "\u25BC")}
            </th>
            <th
              className={thClass}
              onClick={() => handleSort("approval_rate")}
            >
              Approval Rate{" "}
              {sortKey === "approval_rate" && (sortAsc ? "\u25B2" : "\u25BC")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {sorted.map((entry) => (
            <tr
              key={entry.agent_id}
              className="transition-colors hover:bg-white/5"
            >
              <td className="px-4 py-3 text-right font-mono text-sm text-[#94A3B8]">
                {entry.rank}
              </td>
              <td className="px-4 py-3">
                <Link
                  href={`/agent/${entry.agent_id}`}
                  className="font-medium text-white hover:text-[#F97316] transition-colors"
                >
                  {entry.agent_name}
                </Link>
                <div className="mt-0.5 font-mono text-xs text-[#6B7280]">
                  {entry.agent_id.slice(0, 8)}...
                </div>
              </td>
              <td className="px-4 py-3">
                <ScorePill score={entry.score} badge={entry.badge} />
              </td>
              <td className="px-4 py-3">
                <TrendArrow trend={entry.score_trend} />
              </td>
              <td className="px-4 py-3">
                <StewardBadge badge={entry.badge} />
              </td>
              <td className="px-4 py-3 font-mono text-sm text-[#94A3B8]">
                {entry.total_evaluations.toLocaleString()}
              </td>
              <td className="px-4 py-3 font-mono text-sm text-[#94A3B8]">
                {entry.approval_rate}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
