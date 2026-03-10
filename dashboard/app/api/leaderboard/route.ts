import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { getLeaderboard } from "@/lib/queries";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1),
    200
  );
  const minScore = searchParams.get("min_score")
    ? parseFloat(searchParams.get("min_score")!)
    : undefined;
  const sortBy = (searchParams.get("sort_by") ?? "score") as
    | "score"
    | "evaluations"
    | "approval_rate";

  try {
    const db = getDatabase();
    const entries = getLeaderboard(db, { limit, minScore, sortBy });
    return NextResponse.json(entries);
  } catch {
    return NextResponse.json(
      { error: "Database unavailable" },
      { status: 503 }
    );
  }
}
