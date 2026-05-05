import { NextResponse } from "next/server";
import { rollbackCustomTool } from "@/connectors/custom-tools/store";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { emit } from "@/core/events";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/custom-tools/:id/rollback
 * Body: { versionIndex: number }
 *
 * Restores a Custom Tool to a prior snapshot. The current state is
 * itself snapshotted onto the front of the version history so the
 * rollback is undoable. The restored payload is re-validated through
 * the same pipeline as a fresh write (toolName, cost, destructive
 * aggregation, templates).
 *
 * 400 when versionIndex is missing/invalid OR validation rejects the
 * restored snapshot (a tool that was valid 4 edits ago might reference
 * a connector that's since been removed). 404 when the tool or version
 * doesn't exist.
 *
 * Emits `env.changed` so the MCP registry picks up the restored tool
 * surface on the next iteration without a process restart.
 */
async function postHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  let body: { versionIndex?: number };
  try {
    body = await ctx.request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { versionIndex } = body;
  if (
    typeof versionIndex !== "number" ||
    !Number.isFinite(versionIndex) ||
    versionIndex < 0 ||
    !Number.isInteger(versionIndex)
  ) {
    return NextResponse.json(
      { ok: false, error: "versionIndex must be a non-negative integer" },
      { status: 400 }
    );
  }

  try {
    const restored = await rollbackCustomTool(id, versionIndex);
    if (!restored) {
      return NextResponse.json({ ok: false, error: "Tool or version not found" }, { status: 404 });
    }
    emit("env.changed");
    return NextResponse.json({ ok: true, tool: restored });
  } catch (err) {
    const msg = toMsg(err);
    // Validation errors mirror the standard write path — surfaced as
    // 400 so the dashboard can show the same friendly UX.
    const status =
      /template invalid|does not exist or is not callable|estimated cost \d+ exceeds limit|non-negative/i.test(
        msg
      )
        ? 400
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

export const POST = withAdminAuth(postHandler);
