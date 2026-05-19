/**
 * Phase 71 / Plan 71-02 / UNI-21 — per-account / per-tool quota read.
 *
 * GET /api/admin/metrics/unipile-quotas?account_id=<id>&tool=<send_connection|send_message|send_inmail>
 *
 * - Admin-auth via withAdminAuth (401 on missing/invalid admin cookie).
 * - Tenant-scoped via getContextKVStore (D-96 — NO cross-tenant escape hatch).
 * - Reads the SAME KV keys the writer side (lib/rate-limiter.ts) updates.
 *   Caps come from getCaps() — single source of truth (no duplicate defaults).
 * - 30s Cache-Control per phase 53 admin metrics convention (D-93).
 *
 * NO kv-allowlist entry needed: tenant-scoped KV access is the default-allowed
 *   path in tests/contract/kv-allowlist.test.ts. Only root-scope getKVStore()
 *   requires an entry (see PATTERNS misalignment #1 — CONTEXT line 128 was wrong).
 *
 * Response shape (200):
 *   {
 *     account_id, tool,
 *     daily_used, daily_limit, reset_at, percent_used,
 *     weekly_used?, weekly_limit?, weekly_reset_at?   // omitted when caps.weekly === null
 *   }
 *
 * Errors:
 *   - 400 when account_id is missing/empty
 *   - 400 when tool is missing or not a UnipileRateLimitedTool member
 *   - 500 on unexpected failure (wraps toMsg(err) in `{ error: ... }`)
 */
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline/types";
import { getContextKVStore } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";
import {
  getCaps,
  dailyBucket,
  isoWeekBucket,
  nextUtcMidnight,
  nextMondayUtc,
  type UnipileRateLimitedTool,
} from "@/connectors/unipile/lib/rate-limiter";

const VALID_TOOLS: ReadonlyArray<UnipileRateLimitedTool> = [
  "send_connection",
  "send_message",
  "send_inmail",
];

async function handler(ctx: PipelineContext): Promise<Response> {
  try {
    const url = new URL(ctx.request.url);
    const accountId = url.searchParams.get("account_id");
    const toolParam = url.searchParams.get("tool");
    if (!accountId) {
      return NextResponse.json({ error: "account_id required" }, { status: 400 });
    }
    // I-03: validate account_id shape — Unipile account ids are short
    // alphanumeric tokens. Without this guard, an operator typo (or a
    // malicious caller probing the admin route) could feed unbounded input
    // into the KV key template, polluting the keyspace.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) {
      return NextResponse.json({ error: "invalid_account_id" }, { status: 400 });
    }
    if (!toolParam || !VALID_TOOLS.includes(toolParam as UnipileRateLimitedTool)) {
      return NextResponse.json(
        { error: `tool must be one of: ${VALID_TOOLS.join(", ")}` },
        { status: 400 }
      );
    }
    const tool = toolParam as UnipileRateLimitedTool;
    const caps = getCaps(tool);
    const dailyKey = `unipile:ratelimit:${accountId}:${tool}:${dailyBucket()}:daily`;
    const weeklyKey = `unipile:ratelimit:${accountId}:${tool}:${isoWeekBucket()}:weekly`;
    const kv = getContextKVStore();
    const dailyRaw = await kv.get(dailyKey);
    const daily_used = dailyRaw ? parseInt(dailyRaw, 10) || 0 : 0;

    const payload: Record<string, unknown> = {
      account_id: accountId,
      tool,
      daily_used,
      daily_limit: caps.daily,
      reset_at: nextUtcMidnight(),
      percent_used: caps.daily > 0 ? Math.round((daily_used / caps.daily) * 100) : 0,
    };
    if (caps.weekly !== null) {
      const weeklyRaw = await kv.get(weeklyKey);
      payload.weekly_used = weeklyRaw ? parseInt(weeklyRaw, 10) || 0 : 0;
      payload.weekly_limit = caps.weekly;
      payload.weekly_reset_at = nextMondayUtc();
    }
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, max-age=30" },
    });
  } catch (err) {
    return NextResponse.json({ error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(handler);
