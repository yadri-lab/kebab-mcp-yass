/**
 * Phase 71 / Plan 71-02 / Task 1 — admin quota route (per-account/per-tool).
 *
 * Coverage matrix:
 *   - missing account_id → 400
 *   - missing or invalid tool → 400
 *   - happy path send_connection → daily + weekly fields populated
 *   - happy path send_message → weekly fields OMITTED (caps.weekly === null)
 *   - KV returns null for both keys → used counters = 0, percent_used = 0
 *   - env-override (mocked via getConfigInt) → daily_limit reflects override
 *   - Cache-Control: private, max-age=30 header set
 *
 * Mock strategy:
 *   - vi.hoisted() in-memory KV map.
 *   - vi.mock("@/core/with-admin-auth") → identity wrapper (admin-auth
 *     integration is covered by the pipeline contract tests, not per-route).
 *   - vi.mock("@/core/request-context") → returns the hoisted KV.
 *   - vi.mock("@/core/config-facade") → controllable cap overrides without
 *     mutating process.env (lint rule kebab/no-direct-process-env forbids
 *     direct process.env writes outside the allowlisted boot paths).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const store = new Map<string, string>();
  const kvMock = {
    kind: "filesystem" as const,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async (prefix?: string) =>
      Array.from(store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true))
    ),
  };
  // Per-env-var overrides for getConfigInt. Empty by default → fall through
  // to the literal default cap passed by the caller.
  const configIntOverrides = new Map<string, number>();
  return { store, kvMock, configIntOverrides };
});

vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
  requestContext: { getStore: () => undefined },
  getCredential: () => undefined,
}));

vi.mock("@/core/config-facade", () => ({
  getConfig: (_k: string) => undefined,
  getConfigInt: (k: string, def: number) => hoist.configIntOverrides.get(k) ?? def,
}));

import { GET } from "../route";
import { dailyBucket, isoWeekBucket } from "@/connectors/unipile/lib/rate-limiter";

beforeEach(() => {
  hoist.store.clear();
  hoist.configIntOverrides.clear();
  vi.clearAllMocks();
  hoist.kvMock.get.mockImplementation(async (k: string) => hoist.store.get(k) ?? null);
  hoist.kvMock.list.mockImplementation(async (prefix?: string) =>
    Array.from(hoist.store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true))
  );
});

function makeReq(url: string): { request: Request } {
  return { request: new Request(url, { method: "GET" }) } as { request: Request };
}

describe("GET /api/admin/metrics/unipile-quotas", () => {
  it("returns 400 when account_id is missing", async () => {
    const ctx = makeReq("http://x/api/admin/metrics/unipile-quotas?tool=send_connection");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/account_id/i);
  });

  it("returns 400 when tool is missing", async () => {
    const ctx = makeReq("http://x/api/admin/metrics/unipile-quotas?account_id=acc1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tool/i);
  });

  it("returns 400 when tool is not a UnipileRateLimitedTool member", async () => {
    const ctx = makeReq("http://x/api/admin/metrics/unipile-quotas?account_id=acc1&tool=bogus");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tool/i);
  });

  it("returns daily+weekly fields for send_connection (caps.weekly !== null)", async () => {
    const accountId = "acc1";
    const tool = "send_connection";
    hoist.store.set(`unipile:ratelimit:${accountId}:${tool}:${dailyBucket()}:daily`, "7");
    hoist.store.set(`unipile:ratelimit:${accountId}:${tool}:${isoWeekBucket()}:weekly`, "31");

    const ctx = makeReq(
      `http://x/api/admin/metrics/unipile-quotas?account_id=${accountId}&tool=${tool}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      account_id: accountId,
      tool,
      daily_used: 7,
      daily_limit: 25,
      weekly_used: 31,
      weekly_limit: 100,
    });
    expect(body.percent_used).toBe(Math.round((7 / 25) * 100)); // 28
    expect(typeof body.reset_at).toBe("string");
    expect(typeof body.weekly_reset_at).toBe("string");
  });

  it("OMITS weekly_* fields for send_message (caps.weekly === null)", async () => {
    const accountId = "acc1";
    const tool = "send_message";
    hoist.store.set(`unipile:ratelimit:${accountId}:${tool}:${dailyBucket()}:daily`, "20");

    const ctx = makeReq(
      `http://x/api/admin/metrics/unipile-quotas?account_id=${accountId}&tool=${tool}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily_used).toBe(20);
    expect(body.daily_limit).toBe(50);
    expect(body.percent_used).toBe(40);
    expect(body).not.toHaveProperty("weekly_used");
    expect(body).not.toHaveProperty("weekly_limit");
    expect(body).not.toHaveProperty("weekly_reset_at");
  });

  it("returns zero counters when KV has no rows for this account+tool", async () => {
    const ctx = makeReq(
      "http://x/api/admin/metrics/unipile-quotas?account_id=acc1&tool=send_connection"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily_used).toBe(0);
    expect(body.weekly_used).toBe(0);
    expect(body.percent_used).toBe(0);
  });

  it("honors env-override KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP=10 (via getConfigInt)", async () => {
    hoist.configIntOverrides.set("KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP", 10);
    hoist.store.set(`unipile:ratelimit:acc1:send_connection:${dailyBucket()}:daily`, "5");
    const ctx = makeReq(
      "http://x/api/admin/metrics/unipile-quotas?account_id=acc1&tool=send_connection"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    const body = await res.json();
    expect(body.daily_limit).toBe(10);
    expect(body.percent_used).toBe(50); // 5/10
  });

  it("sets Cache-Control: private, max-age=30", async () => {
    const ctx = makeReq(
      "http://x/api/admin/metrics/unipile-quotas?account_id=acc1&tool=send_connection"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(ctx);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=30");
  });
});
