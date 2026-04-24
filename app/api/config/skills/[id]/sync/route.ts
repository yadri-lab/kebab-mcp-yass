import { NextResponse } from "next/server";
import { getSkill, recordSkillSyncState } from "@/connectors/skills/store";
import { getSyncTarget, listSyncTargets, syncSkillToTarget } from "@/connectors/skills/lib/sync";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SyncRequestBody {
  target?: string;
  /** If true, sync to every configured target. Overrides `target`. */
  all?: boolean;
}

/**
 * POST /api/config/skills/:id/sync
 * Body: { target?: string, all?: boolean }
 *
 * Pushes the skill to the configured local target(s). Persists the
 * resulting hash/timestamp so drift can be detected on future edits.
 */
async function postHandler(ctx: PipelineContext) {
  const routeCtx = ctx.routeParams as RouteContext;
  const { id } = await routeCtx.params;

  let body: SyncRequestBody = {};
  try {
    const raw = await ctx.request.json();
    if (raw && typeof raw === "object") body = raw as SyncRequestBody;
  } catch {
    // allow empty body — defaults to single target or "all"
  }

  const skill = await getSkill(id);
  if (!skill) {
    return NextResponse.json({ ok: false, error: "Skill not found" }, { status: 404 });
  }

  const targets = listSyncTargets();
  if (targets.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "No sync targets configured. Set KEBAB_SKILLS_SYNC_TARGETS env var to a JSON array.",
      },
      { status: 400 }
    );
  }

  const selected = body.all
    ? targets
    : body.target
      ? [getSyncTarget(body.target)].filter((t): t is NonNullable<typeof t> => !!t)
      : targets.length === 1
        ? targets
        : [];

  if (selected.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No matching target. Pass target=<name> or all=true." },
      { status: 400 }
    );
  }

  const results: Array<{
    target: string;
    ok: boolean;
    filePath?: string;
    error?: string;
  }> = [];

  for (const target of selected) {
    try {
      const result = await syncSkillToTarget(skill, target);
      await recordSkillSyncState(id, {
        target: result.target,
        lastSyncedHash: result.hash,
        lastSyncedAt: result.syncedAt,
        lastSyncStatus: "ok",
      });
      results.push({ target: target.name, ok: true, filePath: result.filePath });
    } catch (err) {
      const errMsg = toMsg(err);
      await recordSkillSyncState(id, {
        target: target.name,
        lastSyncedHash: "",
        lastSyncedAt: new Date().toISOString(),
        lastSyncStatus: "error",
        lastSyncError: errMsg,
      });
      results.push({ target: target.name, ok: false, error: errMsg });
    }
  }

  const anyFailed = results.some((r) => !r.ok);
  return NextResponse.json({ ok: !anyFailed, results }, { status: anyFailed ? 207 : 200 });
}

export const POST = withAdminAuth(postHandler);
