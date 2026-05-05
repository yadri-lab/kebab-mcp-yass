import { NextResponse } from "next/server";
import { getCustomTool } from "@/connectors/custom-tools/store";
import { listRuns } from "@/connectors/custom-tools/runs-store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * GET /api/admin/custom-tools/:id/runs
 *
 * Returns the persisted run history for a Custom Tool — newest first,
 * capped at 100 entries (24h sliding window). Backs the "Recent runs"
 * tab in the dashboard drawer.
 *
 * Query params:
 *  - `limit` (1..100, default 50) — number of records to return.
 *
 * Auth: admin only (same wrapper as the rest of the custom-tools admin
 * surface). 404 when the tool id doesn't exist so the dashboard doesn't
 * accidentally render an empty list for a deleted tool.
 *
 * Telemetry KV failures degrade gracefully — `listRuns` returns `[]`
 * rather than throwing, so a transient Upstash blip surfaces in the UI
 * as "No runs in the last 24h." rather than a 500.
 */
async function getRunsHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  const tool = await getCustomTool(id);
  if (!tool) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const url = new URL(ctx.request.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(MAX_LIMIT, parsed);
    }
  }

  try {
    const runs = await listRuns(id, limit);
    return NextResponse.json({ ok: true, runs });
  } catch (err) {
    // listRuns swallows its own errors and returns [] — getting here
    // means a programmer bug, not a KV failure. Surface as 500.
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getRunsHandler);
