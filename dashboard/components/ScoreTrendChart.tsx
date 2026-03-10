"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import type { ScoreHistoryPoint } from "@/lib/queries";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ScoreTrendChart({
  data,
  scoreColor,
}: {
  data: ScoreHistoryPoint[];
  scoreColor: string;
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg bg-white/5 text-sm text-[#6B7280]">
        Not enough history for trend chart
      </div>
    );
  }

  const chartData = data.map((d) => ({
    date: formatDate(d.computed_at),
    score: d.score,
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <ReferenceArea y1={8} y2={10} fill="#10B981" fillOpacity={0.06} />
        <ReferenceArea y1={5} y2={8} fill="#F59E0B" fillOpacity={0.06} />
        <ReferenceArea y1={0} y2={5} fill="#EF4444" fillOpacity={0.06} />
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis
          dataKey="date"
          tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 10]}
          ticks={[0, 2, 4, 6, 8, 10]}
          tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1E293B",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            color: "#F8FAFC",
            fontSize: 13,
          }}
          formatter={(value) => [Number(value).toFixed(1), "Score"]}
        />
        <Line
          type="monotone"
          dataKey="score"
          stroke={scoreColor}
          strokeWidth={2}
          dot={{ fill: scoreColor, r: 3 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
