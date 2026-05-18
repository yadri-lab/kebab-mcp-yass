/**
 * Phase 71 / Plan 71-02 / UNI-21 (D-91) — aggregate quota matrix for current tenant.
 *
 * GET /api/admin/metrics/unipile-quotas/summary
 *
 * - Admin-auth via withAdminAuth.
 * - Tenant-scoped via getContextKVStore — TenantKVStore auto-prefixes keys, so
 *   kvScanAll returns ONLY the current tenant's ratelimit buckets (D-96).
 * - Filters to current-day daily buckets (matches dailyBucket()). Weekly skipped.
 * - Sorted by percent_used DESC for at-a-glance hot-spot detection.
 * - 30s Cache-Control.
 *
 * Key format (from rate-limiter.ts D-38):
 *   `unipile:ratelimit:<account_id>:<tool>:<bucket>:<window>`  (6 segments)
 *
 * Defensive against poisoned KV: unknown tool segments are SKIPPED rather than
 *   crashing (`getCaps` only handles the 3 known tools). Same posture as
 *   findAuditByProviderId's try/catch row decode.
 *
 * NO kv-allowlist entry (tenant-scoped — see PATTERNS misalignment #1).
 */
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline/types";
import { getContextKVStore } from "@/core/request-context";
import { kvScanAll } from "@/core/kv-store";
import { toMsg } from "@/core/error-utils";
import {
  getCaps,
  dailyBucket,
  type UnipileRateLimitedTool,
} from "@/connectors/unipile/lib/rate-limiter";

const VALID_TOOLS = new Set<string>(["send_connection", "send_message", "send_inmail"]);

async function handler(_ctx: PipelineContext): Promise<Response> {
  try {
    const kv = getContextKVStore();
    const keys = await kvScanAll(kv, "unipile:ratelimit:*");
    // Key format: `unipile:ratelimit:<account_id>:<tool>:<bucket>:<window>` — 6 segments
    interface Active {
      key: string;
      accountId: string;
      tool: UnipileRateLimitedTool;
    }
    const today = dailyBucket();
    const active: Active[] = [];
    for (const key of keys) {
      const parts = key.split(":");
      if (parts.length !== 6) continue;
      const [, , accountId, tool, bucket, window] = parts;
      if (window !== "daily") continue;
      if (bucket !== today) continue;
      if (!tool || !VALID_TOOLS.has(tool)) continue; // defensive — skip unknown tool from poisoned KV
      if (!accountId) continue;
      active.push({ key, accountId, tool: tool as UnipileRateLimitedTool });
    }
    if (active.length === 0) {
      return NextResponse.json(
        { rows: [] },
        { headers: { "Cache-Control": "private, max-age=30" } }
      );
    }
    const values = await Promise.all(active.map((a) => kv.get(a.key)));
    const rows = active
      .map((a, i) => {
        const v = values[i];
        const daily_used = v ? parseInt(v, 10) || 0 : 0;
        const caps = getCaps(a.tool);
        return {
          account_id: a.accountId,
          tool: a.tool,
          daily_used,
          daily_limit: caps.daily,
          percent_used: caps.daily > 0 ? Math.round((daily_used / caps.daily) * 100) : 0,
        };
      })
      .sort((a, b) => b.percent_used - a.percent_used);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (err) {
    return NextResponse.json({ error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(handler);
