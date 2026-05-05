import { NextResponse } from "next/server";
import { getCustomTool, listCustomToolVersions } from "@/connectors/custom-tools/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/custom-tools/:id/versions
 *
 * Returns the preserved snapshots for a Custom Tool, newest-first,
 * capped at MAX_VERSIONS (10). Backs the History panel in the dedicated
 * edit page (Phase 6).
 *
 * 404 when the tool itself doesn't exist — we don't surface a phantom
 * empty history for deleted tools (would mask delete/recreate-with-id
 * confusion in the UI).
 */
async function getHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  const tool = await getCustomTool(id);
  if (!tool) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  try {
    const versions = await listCustomToolVersions(id);
    return NextResponse.json({ ok: true, toolId: id, versions });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
