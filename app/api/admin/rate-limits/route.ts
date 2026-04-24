import { NextResponse } from "next/server";
import { getKVStore, kvScanAll } from "@/core/kv-store";
import { getContextKVStore, getCurrentTenantId } from "@/core/request-context";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { getConfigInt } from "@/core/config-facade";
import { parseRateLimitKey } from "@/core/rate-limit";

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
 * **Phase 42 (TEN-01) — tenant-scoped:**
 *
 * KV key format (new, v0.11+): `ratelimit:<scope>:<idHash>:<minuteBucket>`
 * — 4 parts after the `ratelimit:` prefix; tenant namespace lives in
 * the TenantKVStore wrapper (`tenant:<id>:ratelimit:...`).
 *
 * Default path scans the requester's tenant namespace via
 * `getContextKVStore().scan(...)` — no more application-code tenant
 * filter; the namespace handles isolation.
 *
 * Root-operator opt-in: `?scope=all` bypasses the tenant wrapper and
 * scans every tenant's namespace via raw `getKVStore()`. This is the
 * admin-cross-tenant view; the old 5-part key shape is ALSO parsed
 * (legacy pre-v0.11 buckets) so operators can see both pre- and
 * post-migration data during the 2-release transition window.
 *
 * Response shape unchanged (scopes[] of {scope, current, max,
 * tenantId, percentage}).
 */
// KV-ALLOWLIST-EXEMPT: `?scope=all` is a deliberate root-operator
// escape hatch for cross-tenant rate-limit visibility. See
// `.planning/phases/42-tenant-scoping/INVENTORY.md` §3. Default path
// uses `getContextKVStore()` — safe.
async function getHandler(ctx: PipelineContext) {
  const request = ctx.request;
  const url = new URL(request.url);
  const scopeAll = url.searchParams.get("scope") === "all";

  const defaultLimit = Math.max(1, getConfigInt("KEBAB_RATE_LIMIT_RPM", 60));

  try {
    // Current minute bucket — only count active buckets
    const now = Date.now();
    const windowMs = 60_000;
    const currentBucket = Math.floor(now / windowMs);

    const groups = new Map<string, { scope: string; tenantId: string; current: number }>();
    type ActiveKey = { key: string; tenantId: string; scope: string; rawKey?: string };
    const activeKeys: ActiveKey[] = [];

    if (scopeAll) {
      // Root-operator cross-tenant view. Scan the raw (unwrapped) store
      // and parse BOTH legacy (5-part: `ratelimit:<tid>:<scope>:<hash>:<bucket>`)
      // and new-tenant-wrapped (6-part: `tenant:<tid>:ratelimit:<scope>:<hash>:<bucket>`)
      // shapes. Also catches bare null-tenant new-shape
      // (4-part after "ratelimit:": `ratelimit:<scope>:<hash>:<bucket>`).
      //
      // Phase 53: key-shape parse delegates to parseRateLimitKey() in
      // src/core/rate-limit.ts — shared with /api/admin/metrics/ratelimit.
      const rawKV = getKVStore();
      const [rlKeys, tenantKeys] = await Promise.all([
        kvScanAll(rawKV, "ratelimit:*"),
        kvScanAll(rawKV, "tenant:*"),
      ]);

      for (const key of [...rlKeys, ...tenantKeys]) {
        const parsed = parseRateLimitKey(key);
        if (!parsed || parsed.bucket !== currentBucket) continue;
        activeKeys.push({ key, tenantId: parsed.tenantId, scope: parsed.scope, rawKey: key });
      }
    } else {
      // Default path: tenant-scoped scan. TenantKVStore wraps the match
      // pattern and strips the prefix from returned keys, so we see
      // `ratelimit:<scope>:<hash>:<bucket>` (4 parts) — the null-tenant
      // shape per parseRateLimitKey().
      const kv = getContextKVStore();
      const keys = await kvScanAll(kv, "ratelimit:*");
      const tenantId = getCurrentTenantId() ?? "default";
      for (const key of keys) {
        const parsed = parseRateLimitKey(key);
        if (!parsed || parsed.bucket !== currentBucket) continue;
        activeKeys.push({ key, tenantId, scope: parsed.scope });
      }
    }

    if (activeKeys.length === 0) {
      return NextResponse.json({ scopes: [] });
    }

    // Batch-read active key values. For scope=all we read via the raw
    // KV (rawKey is the un-wrapped key). For default we read via the
    // tenant-wrapped kv (so the bare key re-wraps correctly).
    let values: (string | null)[];
    const readKV = scopeAll ? getKVStore() : getContextKVStore();
    const readKeys = scopeAll ? activeKeys.map((k) => k.rawKey!) : activeKeys.map((k) => k.key);
    if (readKeys.length > 0 && typeof readKV.mget === "function") {
      values = await readKV.mget(readKeys);
    } else {
      values = await Promise.all(readKeys.map((k) => readKV.get(k)));
    }

    for (let i = 0; i < activeKeys.length; i++) {
      const entry = activeKeys[i];
      if (!entry) continue;
      const { tenantId, scope } = entry;
      const raw = values[i];
      const count = raw ? parseInt(raw, 10) || 0 : 0;
      if (count === 0) continue;

      const groupKey = `${tenantId}:${scope}`;
      const existing = groups.get(groupKey);
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

export const GET = withAdminAuth(getHandler);
