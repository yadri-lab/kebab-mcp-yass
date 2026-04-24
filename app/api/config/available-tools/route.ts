import { NextResponse } from "next/server";
import { resolveRegistryAsync } from "@/core/registry";
import { withAdminAuth } from "@/core/with-admin-auth";
import { toMsg } from "@/core/error-utils";

/**
 * GET /api/config/available-tools
 *
 * Lightweight list of all registered tool names + their connector.
 * Used by the Skills editor to populate the `tools_allowed` multiselect.
 */
async function getHandler() {
  try {
    const registry = await resolveRegistryAsync();
    const tools: Array<{ name: string; connector: string; description: string }> = [];
    for (const p of registry) {
      if (!p.enabled) continue;
      // Skip the skills connector itself — a skill-allowed-list of its own
      // synthetic tools would be circular noise.
      if (p.manifest.id === "skills") continue;
      for (const t of p.manifest.tools) {
        tools.push({
          name: t.name,
          connector: p.manifest.id,
          description: t.description,
        });
      }
    }
    return NextResponse.json({ ok: true, tools });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
