import { NextResponse } from "next/server";
import { listSyncTargets } from "@/connectors/skills/lib/sync";
import { withAdminAuth } from "@/core/with-admin-auth";

/** GET /api/config/skills-sync-targets — list configured sync targets. */
async function getHandler() {
  const targets = listSyncTargets();
  return NextResponse.json({ ok: true, targets });
}

export const GET = withAdminAuth(getHandler);
