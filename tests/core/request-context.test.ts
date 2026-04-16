/**
 * Tests for request-context: AsyncLocalStorage-based tenant propagation.
 *
 * Verifies that tenant A's writes are invisible to tenant B when both
 * go through the request context — the key scenario CRITICAL-2 fixes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory KV mock
const mockStore: Record<string, string> = {};

vi.mock("@/core/kv-store", () => {
  const makeMockKV = () => ({
    kind: "filesystem" as const,
    get: async (key: string) => mockStore[key] ?? null,
    set: async (key: string, value: string) => {
      mockStore[key] = value;
    },
    delete: async (key: string) => {
      delete mockStore[key];
    },
    list: async (prefix?: string) => {
      const keys = Object.keys(mockStore);
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    },
  });

  const inner = makeMockKV();

  // Re-implement TenantKVStore to match real behavior
  function withTenantPrefixLocal(key: string, tenantId: string | null): string {
    if (tenantId === null) return key;
    return `tenant:${tenantId}:${key}`;
  }

  return {
    getKVStore: () => inner,
    getTenantKVStore: (tenantId: string | null) => {
      if (tenantId === null) return inner;
      return {
        kind: inner.kind,
        get: (key: string) => inner.get(withTenantPrefixLocal(key, tenantId)),
        set: (key: string, value: string) => inner.set(withTenantPrefixLocal(key, tenantId), value),
        delete: (key: string) => inner.delete(withTenantPrefixLocal(key, tenantId)),
        list: (prefix?: string) => inner.list(withTenantPrefixLocal(prefix ?? "", tenantId)),
      };
    },
  };
});

import { requestContext, getCurrentTenantId, getContextKVStore } from "@/core/request-context";

describe("request-context", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockStore)) delete mockStore[key];
  });

  it("getCurrentTenantId returns null when no context is active", () => {
    expect(getCurrentTenantId()).toBeNull();
  });

  it("getCurrentTenantId returns tenantId inside run()", () => {
    requestContext.run({ tenantId: "acme" }, () => {
      expect(getCurrentTenantId()).toBe("acme");
    });
  });

  it("getContextKVStore isolates tenants — tenant A write, tenant B read returns null", async () => {
    // Tenant A writes a key
    await requestContext.run({ tenantId: "tenant-a" }, async () => {
      const kv = getContextKVStore();
      await kv.set("webhook:last:stripe", "tenant-a-data");
    });

    // Tenant B reads same key — should be null
    await requestContext.run({ tenantId: "tenant-b" }, async () => {
      const kv = getContextKVStore();
      const value = await kv.get("webhook:last:stripe");
      expect(value).toBeNull();
    });

    // Tenant A can still read it
    await requestContext.run({ tenantId: "tenant-a" }, async () => {
      const kv = getContextKVStore();
      const value = await kv.get("webhook:last:stripe");
      expect(value).toBe("tenant-a-data");
    });
  });

  it("default tenant (null) sees unprefixed keys", async () => {
    await requestContext.run({ tenantId: null }, async () => {
      const kv = getContextKVStore();
      await kv.set("mykey", "default-value");
    });

    expect(mockStore["mykey"]).toBe("default-value");
  });

  it("tenanted context prefixes keys in the store", async () => {
    await requestContext.run({ tenantId: "org1" }, async () => {
      const kv = getContextKVStore();
      await kv.set("mykey", "org1-value");
    });

    expect(mockStore["tenant:org1:mykey"]).toBe("org1-value");
    expect(mockStore["mykey"]).toBeUndefined();
  });
});
