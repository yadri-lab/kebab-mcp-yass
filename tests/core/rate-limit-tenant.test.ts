/**
 * Tests for per-tenant rate limit bucket isolation (INFRA-01).
 *
 * Verifies that Tenant A's rate limit is independent of Tenant B's,
 * and that the default (global) tenant is isolated from named tenants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory KV mock
const mockKV: Record<string, string> = {};

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => ({
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
  }),
}));

// Mock request-context to control tenantId
let mockTenantId: string | null = null;
vi.mock("@/core/request-context", () => ({
  getCurrentTenantId: () => mockTenantId,
}));

import { checkRateLimit } from "@/core/rate-limit";

describe("per-tenant rate limit isolation", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    mockTenantId = null;
  });

  it("uses global bucket when no tenant is set", async () => {
    const result = await checkRateLimit("token-abc", { limit: 10 });
    expect(result.allowed).toBe(true);
    // Key should contain "global"
    const keys = Object.keys(mockKV);
    expect(keys.some((k) => k.startsWith("ratelimit:global:"))).toBe(true);
  });

  it("uses tenant-specific bucket when tenant is set", async () => {
    mockTenantId = "acme";
    const result = await checkRateLimit("token-abc", { limit: 10 });
    expect(result.allowed).toBe(true);
    const keys = Object.keys(mockKV);
    expect(keys.some((k) => k.startsWith("ratelimit:acme:"))).toBe(true);
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

  it("isolates global tenant from named tenants", async () => {
    const limit = 1;

    // Exhaust global limit
    mockTenantId = null;
    await checkRateLimit("token-x", { limit });
    const blockedGlobal = await checkRateLimit("token-x", { limit });
    expect(blockedGlobal.allowed).toBe(false);

    // Named tenant still has its own budget
    mockTenantId = "org-1";
    const allowedTenant = await checkRateLimit("token-x", { limit });
    expect(allowedTenant.allowed).toBe(true);
  });
});
