import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import {
  getAgentDetail,
  getAgentRecentEvaluations,
  getAgentViolationBreakdown,
  getAgentScoreHistory,
  getAgentIntegrityStatus,
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

    const recentEvaluations = getAgentRecentEvaluations(db, id, 20);
    const violationBreakdown = getAgentViolationBreakdown(db, id);
    const scoreHistory = getAgentScoreHistory(db, id, 20);
    const integrityStatus = getAgentIntegrityStatus(db, id);

    return NextResponse.json({
      ...agent,
      recent_evaluations: recentEvaluations,
      violation_breakdown: violationBreakdown,
      score_history: scoreHistory,
      integrity_status: integrityStatus,
    });
  } catch {
    return NextResponse.json(
      { error: "Database unavailable" },
      { status: 503 }
    );
  }
}
