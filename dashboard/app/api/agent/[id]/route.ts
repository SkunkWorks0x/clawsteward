import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import {
  getAgentDetail,
  getAgentRecentEvaluations,
  getAgentViolationBreakdown,
} from "@/lib/queries";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const db = getDatabase();
    const agent = getAgentDetail(db, id);

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const recentEvaluations = getAgentRecentEvaluations(db, id, 50);
    const violationBreakdown = getAgentViolationBreakdown(db, id);

    return NextResponse.json({
      ...agent,
      recent_evaluations: recentEvaluations,
      violation_breakdown: violationBreakdown,
    });
  } catch {
    return NextResponse.json(
      { error: "Database unavailable" },
      { status: 503 }
    );
  }
}
