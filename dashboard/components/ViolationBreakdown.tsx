"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { ViolationBreakdown as ViolationBreakdownType } from "@/lib/queries";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#EF4444",
  high: "#F97316",
  medium: "#F59E0B",
  low: "#6B7280",
};

const tooltipStyle = {
  backgroundColor: "#1E293B",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  color: "#F8FAFC",
  fontSize: 13,
};

export default function ViolationBreakdown({
  breakdown,
}: {
  breakdown: ViolationBreakdownType;
}) {
  if (breakdown.total === 0) {
    return (
      <div className="flex h-48 items-center justify-center gap-2 rounded-lg bg-white/5 text-sm text-[#10B981]">
        <span className="text-lg">&#10003;</span>
        Clean record — no violations
      </div>
    );
  }

  const severityData = Object.entries(breakdown.by_severity)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const ruleTypeData = Object.entries(breakdown.by_rule_type)
    .map(([name, count]) => ({ name: name.replace(/_/g, " "), count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* By Severity */}
      <div>
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
          By Severity
        </h4>
        <ResponsiveContainer width="100%" height={severityData.length * 40 + 20}>
          <BarChart
            data={severityData}
            layout="vertical"
            margin={{ top: 0, right: 8, bottom: 0, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" horizontal={false} />
            <XAxis type="number" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }} axisLine={false} tickLine={false} width={70} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={24}>
              {severityData.map((entry) => (
                <Cell key={entry.name} fill={SEVERITY_COLORS[entry.name] ?? "#6B7280"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* By Rule Type */}
      <div>
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
          By Rule Type
        </h4>
        <ResponsiveContainer width="100%" height={ruleTypeData.length * 40 + 20}>
          <BarChart
            data={ruleTypeData}
            layout="vertical"
            margin={{ top: 0, right: 8, bottom: 0, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" horizontal={false} />
            <XAxis type="number" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }} axisLine={false} tickLine={false} width={120} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="count" fill="#F97316" radius={[0, 4, 4, 0]} maxBarSize={24} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
