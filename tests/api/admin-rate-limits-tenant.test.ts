/**
 * Phase 42 / TEN-01 regression: /api/admin/rate-limits scans the
 * requester's tenant namespace by default (no more application-code
 * `parts[1] === tenantFilter` filter).
 *
 * Verifies:
 *  - Two tenants with live buckets see only their own rows under
 *    their own `x-mymcp-tenant` header.
 *  - The `?scope=all` opt-in path (root-operator view) surfaces every
 *    tenant's rows — covers both legacy (pre-v0.11) 5-part keys and
 *    new-tenant-wrapped 6-part keys.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared in-memory KV — raw store. TenantKVStore wraps reads/writes
// with `tenant:<id>:` when tenantId is non-null (mirrors production).
const store = new Map<string, string>();

vi.mock("@/core/kv-store", () => {
  const rawKV = {
    kind: "filesystem" as const,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async (prefix?: string) =>
      Array.from(store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true)),
    mget: async (keys: string[]) => keys.map((k) => store.get(k) ?? null),
    scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
      const match = opts?.match ?? "*";
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      const all = Array.from(store.keys()).filter((k) =>
        match.endsWith("*") ? k.startsWith(prefix) : k === match
      );
      const offset = cursor === "0" ? 0 : parseInt(cursor, 10) || 0;
      const count = opts?.count ?? 100;
      const slice = all.slice(offset, offset + count);
      const nextOffset = offset + count;
      const nextCursor = nextOffset >= all.length ? "0" : String(nextOffset);
      return { cursor: nextCursor, keys: slice };
    },
  };

  function withTenantPrefixLocal(key: string, tenantId: string | null): string {
    if (tenantId === null) return key;
    return `tenant:${tenantId}:${key}`;
  }

  function wrapped(tenantId: string | null) {
    if (tenantId === null) return rawKV;
    const pk = (k: string) => withTenantPrefixLocal(k, tenantId);
    return {
      kind: "filesystem" as const,
      get: async (k: string) => store.get(pk(k)) ?? null,
      set: async (k: string, v: string) => {
        store.set(pk(k), v);
      },
      delete: async (k: string) => {
        store.delete(pk(k));
      },
      list: async (prefix?: string) => {
        const fullPrefix = pk(prefix ?? "");
        return Array.from(store.keys())
          .filter((k) => k.startsWith(fullPrefix))
          .map((k) => k.slice(`tenant:${tenantId}:`.length));
      },
      mget: async (keys: string[]) => keys.map((k) => store.get(pk(k)) ?? null),
      scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
        const prefixedMatch = opts?.match ? pk(opts.match) : pk("*");
        const result = await rawKV.scan(cursor, { ...opts, match: prefixedMatch });
        const stripPrefix = `tenant:${tenantId}:`;
        return {
          cursor: result.cursor,
          keys: result.keys.map((k) =>
            k.startsWith(stripPrefix) ? k.slice(stripPrefix.length) : k
          ),
        };
      },
    };
  }

  return {
    getKVStore: () => rawKV,
    getTenantKVStore: (tenantId: string | null) => wrapped(tenantId),
    kvScanAll: async (kv: ReturnType<typeof wrapped>, match?: string) => {
      if (typeof kv.scan !== "function") {
        const prefix = match?.endsWith("*") ? match.slice(0, -1) : match;
        return kv.list(prefix);
      }
      const all: string[] = [];
      let cursor = "0";
      do {
        // exactOptionalPropertyTypes: omit match when undefined rather than passing it.
        const r = await kv.scan(
          cursor,
          match !== undefined ? { match, count: 100 } : { count: 100 }
        );
        all.push(...r.keys);
        cursor = r.cursor;
      } while (cursor !== "0");
      return all;
    },
  };
});

// Hoisted tenant override. Default tenantId resolves from the request
// header via getTenantId (imported from @/core/tenant — not mocked).
vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

// Mock request-context so the handler's getContextKVStore reads from
// the tenant-wrapped KV keyed by the request header.
let currentTenantFromHeader: string | null = null;
vi.mock("@/core/request-context", async () => {
  const kvMod = await import("@/core/kv-store");
  // Phase 48 (FACADE-02a): see rate-limit-tenant.test.ts for rationale.
  return {
    getCurrentTenantId: () => currentTenantFromHeader,
    getContextKVStore: () => kvMod.getTenantKVStore(currentTenantFromHeader),
    getCredential: (envKey: string) => process.env[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
  };
});

import { GET } from "../../app/api/admin/rate-limits/route";

function makeReq(headers: Record<string, string> = {}, url = "http://x/api/admin/rate-limits") {
  return new Request(url, { method: "GET", headers });
}

// Helper: seed a tenant-wrapped rate-limit bucket in the store.
function seedTenantBucket(
  tenantId: string,
  scope: string,
  hash: string,
  bucket: number,
  count: number
) {
  store.set(`tenant:${tenantId}:ratelimit:${scope}:${hash}:${bucket}`, String(count));
}

// Helper: seed a null-tenant (bare) rate-limit bucket.
function seedNullBucket(scope: string, hash: string, bucket: number, count: number) {
  store.set(`ratelimit:${scope}:${hash}:${bucket}`, String(count));
}

// Helper: seed a legacy (pre-v0.11) 5-part rate-limit bucket.
function seedLegacyBucket(
  tenantId: string,
  scope: string,
  hash: string,
  bucket: number,
  count: number
) {
  store.set(`ratelimit:${tenantId}:${scope}:${hash}:${bucket}`, String(count));
}

describe("/api/admin/rate-limits — Phase 42 tenant isolation", () => {
  beforeEach(() => {
    store.clear();
    currentTenantFromHeader = null;
  });

  it("returns only the requester's tenant rows under x-mymcp-tenant header", async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    seedTenantBucket("alpha", "mcp", "hashA", bucket, 30);
    seedTenantBucket("beta", "mcp", "hashB", bucket, 45);

    // Request from alpha.
    currentTenantFromHeader = "alpha";
    const ctx = { request: makeReq({ "x-mymcp-tenant": "alpha" }) } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.scopes).toBeDefined();
    expect(body.scopes.length).toBe(1);
    expect(body.scopes[0].tenantId).toBe("alpha");
    expect(body.scopes[0].current).toBe(30);
    expect(body.scopes[0].scope).toBe("mcp");
  });

  it("scope=all surfaces every tenant's buckets (root-operator view)", async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    seedTenantBucket("alpha", "mcp", "hashA", bucket, 30);
    seedTenantBucket("beta", "mcp", "hashB", bucket, 45);
    seedNullBucket("mcp", "hashN", bucket, 5);

    currentTenantFromHeader = null;
    const ctx = {
      request: makeReq({}, "http://x/api/admin/rate-limits?scope=all"),
    } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.scopes.length).toBe(3);
    const ids = body.scopes.map((s: { tenantId: string }) => s.tenantId).sort();
    expect(ids).toEqual(["alpha", "beta", "default"]);
  });

  it("scope=all parses legacy pre-v0.11 5-part keys", async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    // Legacy shape: `ratelimit:<tenantId>:<scope>:<hash>:<bucket>`
    seedLegacyBucket("legacy-tenant", "mcp", "hashL", bucket, 22);

    currentTenantFromHeader = null;
    const ctx = {
      request: makeReq({}, "http://x/api/admin/rate-limits?scope=all"),
    } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.scopes.length).toBe(1);
    expect(body.scopes[0].tenantId).toBe("legacy-tenant");
    expect(body.scopes[0].current).toBe(22);
  });

  it("returns empty scopes when no buckets exist for this tenant", async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    // Seed for alpha only.
    seedTenantBucket("alpha", "mcp", "hashA", bucket, 30);

    // Request from beta.
    currentTenantFromHeader = "beta";
    const ctx = { request: makeReq({ "x-mymcp-tenant": "beta" }) } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();

    expect(body.scopes).toEqual([]);
  });
});
