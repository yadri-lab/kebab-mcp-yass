import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { getKVStore } from "@/core/kv-store";

interface RateLimitScope {
  scope: string;
  current: number;
  max: number;
  tenantId: string;
  percentage: number;
}

/**
 * GET /api/admin/rate-limits
 *
 * Lists active rate limit buckets from KV, grouped by scope.
 * Auth-gated via admin token.
 *
 * KV key format: `ratelimit:{tenantId}:{scope}:{idHash}:{minuteBucket}`
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const defaultLimit = Math.max(1, parseInt(process.env.MYMCP_RATE_LIMIT_RPM ?? "60", 10) || 60);

  try {
    const kv = getKVStore();
    const keys = await kv.list("ratelimit:");

    if (keys.length === 0) {
      return NextResponse.json({ scopes: [] });
    }

    // Current minute bucket — only count active buckets
    const now = Date.now();
    const windowMs = 60_000;
    const currentBucket = Math.floor(now / windowMs);

    // Group by tenantId + scope
    const groups = new Map<string, { scope: string; tenantId: string; current: number }>();

    for (const key of keys) {
      // ratelimit:{tenantId}:{scope}:{idHash}:{minuteBucket}
      const parts = key.split(":");
      if (parts.length < 5) continue;

      const tenantId = parts[1];
      const scope = parts[2];
      const bucketStr = parts[parts.length - 1];
      const bucket = parseInt(bucketStr, 10);

      // Only count current bucket
      if (!Number.isFinite(bucket) || bucket !== currentBucket) continue;

      const groupKey = `${tenantId}:${scope}`;
      const existing = groups.get(groupKey);

      // Read count from KV
      let count = 0;
      try {
        const raw = await kv.get(key);
        count = raw ? parseInt(raw, 10) || 0 : 0;
      } catch {
        // Skip keys we can't read
        continue;
      }

      if (existing) {
        existing.current += count;
      } else {
        groups.set(groupKey, { scope, tenantId, current: count });
      }
    }

    const scopes: RateLimitScope[] = [];
    for (const group of groups.values()) {
      const max = defaultLimit;
      scopes.push({
        scope: group.scope,
        current: group.current,
        max,
        tenantId: group.tenantId,
        percentage: Math.round((group.current / max) * 100),
      });
    }

    // Sort by percentage descending
    scopes.sort((a, b) => b.percentage - a.percentage);

    return NextResponse.json({ scopes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read rate limits" },
      { status: 500 }
    );
  }
}
