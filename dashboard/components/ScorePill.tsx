import { getScoreColor } from "@/lib/queries";

type Badge = "verified" | "under-review" | "high-risk" | "insufficient-data";

export default function ScorePill({
  score,
  badge,
}: {
  score: number | null;
  badge: Badge;
}) {
  const color = getScoreColor(badge);

  return (
    <span
      className="inline-block rounded-full px-3 py-1 font-mono text-sm font-bold"
      style={{
        backgroundColor: `${color}33`,
        color,
      }}
    >
      {score !== null ? score.toFixed(1) : "N/A"}
    </span>
  );
}
