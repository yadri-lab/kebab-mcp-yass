/**
 * Phase 71 / Plan 71-02 / Task 2 — admin quota summary matrix route.
 *
 * GET /api/admin/metrics/unipile-quotas/summary
 *
 * Coverage (5 cases per plan <behavior>):
 *   1. Empty KV → { rows: [] }
 *   2. 3 active buckets across 2 accounts → 3 rows, sorted DESC by percent_used
 *   3. Mixed daily+weekly keys → only daily appear in response (weekly skipped)
 *   4. Yesterday's bucket present → SKIPPED (current-day-only)
 *   5. Unknown tool string in a KV key (poisoned KV) → row OMITTED (defensive)
 *
 * Bonus:
 *   6. Cache-Control: private, max-age=30 header set
 *
 * Mock strategy — mirrors the quota single-route test (config-facade mocked
 * so we don't mutate process.env; kebab/no-direct-process-env rule applies
 * to app/**).
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
    scan: vi.fn(async (cursor: string, opts?: { match?: string; count?: number }) => {
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
    }),
  };
  return { store, kvMock };
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
  getConfigInt: (_k: string, def: number) => def,
}));

import { GET } from "../route";
import { dailyBucket, isoWeekBucket } from "@/connectors/unipile/lib/rate-limiter";

beforeEach(() => {
  hoist.store.clear();
  vi.clearAllMocks();
  hoist.kvMock.get.mockImplementation(async (k: string) => hoist.store.get(k) ?? null);
  hoist.kvMock.list.mockImplementation(async (prefix?: string) =>
    Array.from(hoist.store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true))
  );
  hoist.kvMock.scan.mockImplementation(
    async (cursor: string, opts?: { match?: string; count?: number }) => {
      const match = opts?.match ?? "*";
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      const all = Array.from(hoist.store.keys()).filter((k) =>
        match.endsWith("*") ? k.startsWith(prefix) : k === match
      );
      const offset = cursor === "0" ? 0 : parseInt(cursor, 10) || 0;
      const count = opts?.count ?? 100;
      const slice = all.slice(offset, offset + count);
      const nextOffset = offset + count;
      const nextCursor = nextOffset >= all.length ? "0" : String(nextOffset);
      return { cursor: nextCursor, keys: slice };
    }
  );
});

function makeReq(): { request: Request } {
  return {
    request: new Request("http://x/api/admin/metrics/unipile-quotas/summary", {
      method: "GET",
    }),
  } as { request: Request };
}

describe("GET /api/admin/metrics/unipile-quotas/summary", () => {
  it("returns { rows: [] } when KV is empty", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rows: [] });
  });

  it("returns 3 rows sorted DESC by percent_used across 2 accounts", async () => {
    const today = dailyBucket();
    // accountA → send_connection 18/25 (72%), send_message 30/50 (60%)
    hoist.store.set(`unipile:ratelimit:accountA:send_connection:${today}:daily`, "18");
    hoist.store.set(`unipile:ratelimit:accountA:send_message:${today}:daily`, "30");
    // accountB → send_inmail 12/15 (80%)
    hoist.store.set(`unipile:ratelimit:accountB:send_inmail:${today}:daily`, "12");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(3);
    // Sorted by percent_used DESC → inmail (80) > connection (72) > message (60)
    expect(body.rows[0]).toMatchObject({
      account_id: "accountB",
      tool: "send_inmail",
      daily_used: 12,
      daily_limit: 15,
      percent_used: 80,
    });
    expect(body.rows[1]).toMatchObject({
      account_id: "accountA",
      tool: "send_connection",
      daily_used: 18,
      daily_limit: 25,
      percent_used: 72,
    });
    expect(body.rows[2]).toMatchObject({
      account_id: "accountA",
      tool: "send_message",
      daily_used: 30,
      daily_limit: 50,
      percent_used: 60,
    });
  });

  it("skips weekly buckets (only daily rows appear in response)", async () => {
    const today = dailyBucket();
    const thisWeek = isoWeekBucket();
    hoist.store.set(`unipile:ratelimit:accountA:send_connection:${today}:daily`, "5");
    // Weekly bucket — must NOT appear in response
    hoist.store.set(`unipile:ratelimit:accountA:send_connection:${thisWeek}:weekly`, "20");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].daily_used).toBe(5);
  });

  it("skips stale-day buckets (yesterday's daily bucket NOT included)", async () => {
    const today = dailyBucket();
    const yesterday = dailyBucket(new Date(Date.now() - 86_400_000));
    hoist.store.set(`unipile:ratelimit:accountA:send_connection:${today}:daily`, "7");
    hoist.store.set(`unipile:ratelimit:accountA:send_connection:${yesterday}:daily`, "99");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].daily_used).toBe(7);
  });

  it("OMITS rows where the tool segment in the KV key is unknown (poisoned KV defense)", async () => {
    const today = dailyBucket();
    hoist.store.set(`unipile:ratelimit:accountA:send_connection:${today}:daily`, "3");
    // Manually-inserted poisoned key with bogus tool segment → must be skipped
    hoist.store.set(`unipile:ratelimit:accountA:bogus_tool:${today}:daily`, "999");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].tool).toBe("send_connection");
  });

  it("sets Cache-Control: private, max-age=30", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=30");
  });
});
