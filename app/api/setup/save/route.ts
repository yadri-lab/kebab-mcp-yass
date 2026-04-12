import { NextResponse } from "next/server";
import { getEnvStore } from "@/core/env-store";
import { checkAdminAuth } from "@/core/auth";

/**
 * POST /api/setup/save
 * Writes env vars during first-time setup (filesystem only).
 *
 * Auth model:
 * - On Vercel: blocked — use /api/config/env with VERCEL_TOKEN, or set env in dashboard.
 * - Local, no MCP_AUTH_TOKEN yet: open (first-run).
 * - Local, MCP_AUTH_TOKEN present: caller must provide it via Authorization header
 *   (same as admin auth). Typically used by the wizard for the second write
 *   (pack credentials) after the first write established the token.
 */
export async function POST(request: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json(
      {
        error:
          "Cannot write .env on Vercel. Use /api/config/env (requires VERCEL_TOKEN + VERCEL_PROJECT_ID) or the Vercel dashboard.",
      },
      { status: 403 }
    );
  }

  // If a token is already configured, require admin auth for additional writes.
  if (process.env.MCP_AUTH_TOKEN) {
    const authError = checkAdminAuth(request);
    if (authError) return authError;
  }

  const body = (await request.json().catch(() => null)) as {
    envVars?: Record<string, string>;
  } | null;
  if (!body || !body.envVars || typeof body.envVars !== "object") {
    return NextResponse.json({ error: "Missing envVars object" }, { status: 400 });
  }

  // Validate keys
  for (const k of Object.keys(body.envVars)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
      return NextResponse.json({ error: `Invalid env var key: ${k}` }, { status: 400 });
    }
  }

  try {
    const store = getEnvStore();
    const result = await store.write(body.envVars);
    return NextResponse.json({
      ok: true,
      message: result.note || ".env saved.",
      written: result.written,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
