import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getRecentLogs } from "@/core/logging";

/**
 * GET /api/config/logs?count=100
 * Returns recent tool logs from the in-memory ring buffer.
 * Admin-auth-gated.
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const count = parseInt(url.searchParams.get("count") || "100", 10);
  const logs = getRecentLogs(Number.isFinite(count) ? count : 100);

  return NextResponse.json({ ok: true, logs });
}
