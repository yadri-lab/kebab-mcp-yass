import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import { getConfig } from "@/core/config-facade";
import { getBootstrapAuthToken } from "@/core/first-run";

/**
 * GET /api/config/auth-token
 *
 * Returns the active MCP token to admin-authed callers. Used by the
 * Settings → MCP install panel's "Reveal" button instead of
 * server-rendering the token into the page payload (which would leak it
 * into HTML view-source even when the UI shows it masked).
 *
 * Resolution order mirrors checkMcpAuth's token source:
 *   MCP_AUTH_TOKEN (env / KV-credential) → bootstrap token (welcome-minted,
 *   stored in KV `mymcp:firstrun:bootstrap`). Bootstrap-only instances
 *   (zero-config welcome flow, no MCP_AUTH_TOKEN env) previously rendered
 *   an empty "<MCP_AUTH_TOKEN>" panel even though the endpoint accepts the
 *   bootstrap token — the fallback closes that gap. withAdminAuth runs
 *   rehydrateStep first, so the bootstrap cache is populated from KV before
 *   this handler reads it.
 *
 * Auth: same as other admin routes — admin cookie or Authorization header.
 *
 * v0.6 NIT-01: previously returned 404 for "no token configured" and 401
 * for "wrong creds" — that's an oracle (an attacker could differentiate
 * "token-less server" from "wrong token"). Both states now return 401 so
 * an unauthorized caller cannot tell them apart.
 */
async function getHandler() {
  const token =
    (getConfig("MCP_AUTH_TOKEN") || "").split(",")[0]?.trim() || getBootstrapAuthToken() || "";
  if (!token) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, token });
}

export const GET = withAdminAuth(getHandler);
