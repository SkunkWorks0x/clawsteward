type Badge = "verified" | "under-review" | "high-risk" | "insufficient-data";

const badgeConfig: Record<
  Badge,
  { label: string; bgClass: string; textClass: string }
> = {
  verified: {
    label: "ClawSteward-verified",
    bgClass: "bg-[#10B981]/20",
    textClass: "text-[#10B981]",
  },
  "under-review": {
    label: "Under Review",
    bgClass: "bg-[#F59E0B]/20",
    textClass: "text-[#F59E0B]",
  },
  "high-risk": {
    label: "High Risk",
    bgClass: "bg-[#EF4444]/20",
    textClass: "text-[#EF4444]",
  },
  "insufficient-data": {
    label: "Insufficient Data",
    bgClass: "bg-[#6B7280]/20",
    textClass: "text-[#6B7280]",
  },
};

export default function StewardBadge({ badge }: { badge: Badge }) {
  const config = badgeConfig[badge];
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${config.bgClass} ${config.textClass}`}
    >
      {config.label}
    </span>
  );
}
