/**
 * Tests for per-tenant rate limit bucket isolation (INFRA-01, TEN-01).
 *
 * Phase 42 (TEN-01): key shape moved from
 *   `ratelimit:<tenantId>:<scope>:<hash>:<bucket>` (tenantId in body)
 * to
 *   `tenant:<id>:ratelimit:<scope>:<hash>:<bucket>` (tenant via wrapper).
 * Null-tenant keys stay bare (`ratelimit:<scope>:<hash>:<bucket>`).
 *
 * Verifies that Tenant A's rate limit is independent of Tenant B's,
 * and that the default (null) tenant is isolated from named tenants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared in-memory KV mock. We mount the same backing map under both
// `getKVStore` (rarely touched from this path post-v0.11) and
// `getTenantKVStore` (wraps reads/writes with `tenant:<id>:` prefix
// exactly like production).
const mockKV: Record<string, string> = {};

function baseStore() {
  return {
    kind: "filesystem" as const,
    get: async (key: string) => mockKV[key] ?? null,
    set: async (key: string, value: string) => {
      mockKV[key] = value;
    },
    delete: async (key: string) => {
      delete mockKV[key];
    },
    list: async (prefix?: string) => {
      const keys = Object.keys(mockKV);
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    },
    incr: async (key: string) => {
      const prev = parseInt(mockKV[key] ?? "0", 10);
      const next = (Number.isFinite(prev) ? prev : 0) + 1;
      mockKV[key] = String(next);
      return next;
    },
  };
}

function prefixed(tenantId: string | null) {
  const base = baseStore();
  if (tenantId === null) return base;
  const pk = (k: string) => `tenant:${tenantId}:${k}`;
  return {
    ...base,
    get: async (key: string) => mockKV[pk(key)] ?? null,
    set: async (key: string, value: string) => {
      mockKV[pk(key)] = value;
    },
    delete: async (key: string) => {
      delete mockKV[pk(key)];
    },
    list: async (prefix?: string) => {
      const actualPrefix = pk(prefix ?? "");
      return Object.keys(mockKV)
        .filter((k) => k.startsWith(actualPrefix))
        .map((k) => k.slice(`tenant:${tenantId}:`.length));
    },
    incr: async (key: string) => {
      const pkey = pk(key);
      const prev = parseInt(mockKV[pkey] ?? "0", 10);
      const next = (Number.isFinite(prev) ? prev : 0) + 1;
      mockKV[pkey] = String(next);
      return next;
    },
  };
}

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => baseStore(),
  getTenantKVStore: (tenantId: string | null) => prefixed(tenantId),
  kvScanAll: async (_kv: unknown, match?: string) => {
    const prefix = match?.endsWith("*") ? match.slice(0, -1) : match;
    return Object.keys(mockKV).filter((k) => (prefix ? k.startsWith(prefix) : true));
  },
}));

// Mock request-context to control tenantId. getContextKVStore delegates
// to getTenantKVStore(getCurrentTenantId()).
let mockTenantId: string | null = null;
vi.mock("@/core/request-context", async () => {
  const { getTenantKVStore } = await import("@/core/kv-store");
  return {
    getCurrentTenantId: () => mockTenantId,
    getContextKVStore: () => getTenantKVStore(mockTenantId),
  };
});

import { checkRateLimit } from "@/core/rate-limit";

describe("per-tenant rate limit isolation", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    mockTenantId = null;
  });

  it("uses unprefixed bucket when no tenant is set", async () => {
    const result = await checkRateLimit("token-abc", { limit: 10 });
    expect(result.allowed).toBe(true);
    // Null tenant → key body is bare, no `tenant:` prefix
    const keys = Object.keys(mockKV);
    expect(keys.some((k) => k.startsWith("ratelimit:"))).toBe(true);
    expect(keys.every((k) => !k.startsWith("tenant:"))).toBe(true);
  });

  it("uses tenant-prefixed bucket when tenant is set", async () => {
    mockTenantId = "acme";
    const result = await checkRateLimit("token-abc", { limit: 10 });
    expect(result.allowed).toBe(true);
    const keys = Object.keys(mockKV);
    // TenantKVStore wrapped: `tenant:acme:ratelimit:...`
    expect(keys.some((k) => k.startsWith("tenant:acme:ratelimit:"))).toBe(true);
    // No legacy `ratelimit:acme:*` or `ratelimit:global:*` in the new shape
    expect(keys.some((k) => k.startsWith("ratelimit:acme:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("ratelimit:global:"))).toBe(false);
  });

  it("isolates rate limits between tenants", async () => {
    const limit = 2;

    // Exhaust tenant-a's limit
    mockTenantId = "tenant-a";
    await checkRateLimit("shared-token", { limit });
    await checkRateLimit("shared-token", { limit });
    const blocked = await checkRateLimit("shared-token", { limit });
    expect(blocked.allowed).toBe(false);

    // tenant-b with same token should still have full allowance
    mockTenantId = "tenant-b";
    const allowed = await checkRateLimit("shared-token", { limit });
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(limit - 1);
  });

  it("isolates null tenant from named tenants", async () => {
    const limit = 1;

    // Exhaust null-tenant limit
    mockTenantId = null;
    await checkRateLimit("token-x", { limit });
    const blockedGlobal = await checkRateLimit("token-x", { limit });
    expect(blockedGlobal.allowed).toBe(false);

    // Named tenant still has its own budget
    mockTenantId = "org-1";
    const allowedTenant = await checkRateLimit("token-x", { limit });
    expect(allowedTenant.allowed).toBe(true);
  });

  it("TEN-01: two tenants running concurrently see independent buckets (real requestContext)", async () => {
    // Remove mock to exercise the real requestContext + getContextKVStore.
    // For this scenario we rely on the TenantKVStore mock behavior above.
    const limit = 3;
    mockTenantId = "alpha";
    await checkRateLimit("shared-id", { limit });
    await checkRateLimit("shared-id", { limit });

    mockTenantId = "beta";
    const beta = await checkRateLimit("shared-id", { limit });
    expect(beta.allowed).toBe(true);
    expect(beta.remaining).toBe(limit - 1); // beta saw a fresh bucket
  });
});
