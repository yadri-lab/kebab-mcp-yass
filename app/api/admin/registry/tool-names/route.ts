import { NextResponse } from "next/server";
import { resolveRegistryAsync, ALL_CONNECTOR_LOADERS } from "@/core/registry";
import { withAdminAuth } from "@/core/with-admin-auth";
import { toMsg } from "@/core/error-utils";

/**
 * GET /api/admin/registry/tool-names
 *
 * Returns the full surface of tool names callable from a Custom Tool
 * step, grouped by their owning pack — both enabled and disabled
 * connectors. Backs the Custom Tools composer's "Available tool names"
 * hint and the client-side `step.toolName` validation.
 *
 * The dashboard surfaces:
 *  - Enabled packs first (the operator can use these today).
 *  - Disabled packs after, so an author who's about to flip a feature
 *    can compose against the eventual surface without trial-and-error.
 *
 * Returns:
 * ```
 * {
 *   ok: true,
 *   names: string[],          // flat sorted list, fast O(1) lookup client-side
 *   packs: {                  // grouped, for the disclosure hint panel
 *     id: string,
 *     enabled: boolean,
 *     tools: string[]
 *   }[]
 * }
 * ```
 *
 * Auth: admin only. The list of tool *names* is not particularly
 * sensitive (it surfaces in MCP tool/list anyway for connected
 * clients), but the disabled-pack inclusion would otherwise leak
 * forthcoming connectors. Admin gate keeps it consistent with the rest
 * of the custom-tools admin surface.
 */
async function getHandler() {
  try {
    const states = await resolveRegistryAsync();
    const packs: { id: string; enabled: boolean; tools: string[] }[] = [];
    const allNames = new Set<string>();

    for (const s of states) {
      // Enabled packs already carry their full manifest tools[].
      if (s.enabled) {
        const tools = s.manifest.tools.map((t) => t.name).sort();
        for (const n of tools) allNames.add(n);
        packs.push({ id: s.manifest.id, enabled: true, tools });
        continue;
      }
      // Disabled packs return a stub manifest — force-load the real
      // loader to get the full tool list. Best-effort: a loader failure
      // just means we omit that pack's entries (rare, log-worthy but
      // not user-visible).
      const entry = ALL_CONNECTOR_LOADERS.find((e) => e.id === s.manifest.id);
      if (!entry) {
        packs.push({ id: s.manifest.id, enabled: false, tools: [] });
        continue;
      }
      try {
        const loaded = await entry.loader();
        const tools = loaded.tools.map((t) => t.name).sort();
        for (const n of tools) allNames.add(n);
        packs.push({ id: s.manifest.id, enabled: false, tools });
      } catch {
        packs.push({ id: s.manifest.id, enabled: false, tools: [] });
      }
    }

    // Stable order: enabled-first, then alpha by pack id.
    packs.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    return NextResponse.json({
      ok: true,
      names: [...allNames].sort(),
      packs,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
