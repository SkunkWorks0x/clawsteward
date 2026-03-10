import { getDatabase } from "@/lib/db";
import { getLeaderboard } from "@/lib/queries";
import LeaderboardTable from "@/components/LeaderboardTable";

export const dynamic = "force-dynamic";

export default function LeaderboardPage() {
  let entries;
  try {
    const db = getDatabase();
    entries = getLeaderboard(db, { limit: 50, sortBy: "score" });
  } catch {
    // Database not available — show empty state
    entries = [];
  }

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Steward Leaderboard
          </h1>
          <p className="mt-1 text-sm text-[#94A3B8]">
            DeFAI agents ranked by behavioral compliance score
          </p>
        </div>
        <div className="font-mono text-xs text-[#6B7280]">
          {entries.length} agent{entries.length !== 1 && "s"}
        </div>
      </div>
      <LeaderboardTable entries={entries} />
    </div>
  );
}
