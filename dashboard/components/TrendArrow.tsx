type Trend = "improving" | "stable" | "declining" | null;

const trendConfig: Record<string, { arrow: string; className: string }> = {
  improving: { arrow: "\u2191", className: "text-[#10B981]" },
  stable: { arrow: "\u2192", className: "text-[#94A3B8]" },
  declining: { arrow: "\u2193", className: "text-[#EF4444]" },
};

export default function TrendArrow({ trend }: { trend: Trend }) {
  if (!trend) {
    return <span className="text-[#6B7280]">--</span>;
  }
  const config = trendConfig[trend];
  return (
    <span className={`font-mono text-lg font-bold ${config?.className}`}>
      {config?.arrow ?? "--"}
    </span>
  );
}
