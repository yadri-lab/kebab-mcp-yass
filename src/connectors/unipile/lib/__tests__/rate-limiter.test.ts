/**
 * Phase 69 / Plan 02 / Task 2 — unipile rate-limiter test suite.
 *
 * Coverage matrix (D-38..D-41):
 *   D-38 (key format)   — 2 tests: daily key shape + weekly key shape
 *   D-39 (default caps) — 6 tests: 3 happy-path (1 per tool) + 3 blocked-paths
 *                         (send_connection daily/weekly cap + send_inmail daily cap)
 *                         + 2 env-override tests (daily + weekly — INFO 7 fix)
 *   D-40 (fail-CLOSED)  — 3 tests: kv.incr throws, kv lacks .incr method,
 *                         escape-hatch KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open
 *   D-41 (never throws) — implicit across the suite; explicit isolation
 *                         test confirms multi-tool counters don't share keys
 *
 * Mock strategy: vi.hoisted() + kvMock with spy-controllable `incr` —
 * lifted verbatim from identifiers.test.ts. getContextKVStore returns the
 * mock so the rate-limiter sees a happy KVStore-shaped object whose
 * behavior the test controls per-case.
 *
 * Env-var hygiene: beforeEach deletes the 5 env vars the rate-limiter
 * reads, so cap-override tests don't leak into later cases. This also
 * verifies (by construction) that getConfigInt reads at CALL TIME — if it
 * read at module load, the env-override tests would all fail.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const kvMock = {
    kind: "filesystem" as const,
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
    list: vi.fn<() => Promise<string[]>>(),
    incr: vi.fn<(k: string, opts?: { ttlSeconds?: number }) => Promise<number>>(),
    expire: vi.fn<(k: string, ttl: number) => Promise<void>>(),
  };
  return { kvMock };
});

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
  // config-facade.ts imports `requestContext` + `getCredential` from this
  // module — must be present in the mock or every getConfig/getConfigInt
  // call throws "No <export> defined on the mock". Mirror them as minimal
  // stubs: no active context (getStore() === undefined) → config-facade
  // falls through to process.env directly, which is exactly what we want.
  requestContext: { getStore: () => undefined },
  getCredential: () => undefined,
}));

import { checkUnipileRateLimit } from "../rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KEBAB_UNIPILE_RATELIMIT_FAIL_MODE;
  delete process.env.KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP;
  delete process.env.KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP;
  delete process.env.KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP;
  delete process.env.KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP;
  // Restore a fresh incr spy on every test in case a fail-closed-no-incr
  // test stomped it.
  hoist.kvMock.incr = vi.fn<(k: string, opts?: { ttlSeconds?: number }) => Promise<number>>();
});

describe("checkUnipileRateLimit (D-38..D-41)", () => {
  // === D-39 happy path (1 per tool) ===

  it("D-39: allows send_connection when daily=1 / weekly=1 (caps 25 / 100)", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(false);
    expect(r.daily_used).toBe(1);
    expect(r.daily_limit).toBe(25);
    expect(r.weekly_used).toBe(1);
    expect(r.weekly_limit).toBe(100);
  });

  it("D-39: send_message has no weekly cap (returns no weekly fields, no weekly incr)", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(10);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_message",
    });
    expect(r.blocked).toBe(false);
    expect(r.daily_limit).toBe(50);
    expect(r.weekly_used).toBeUndefined();
    expect(r.weekly_limit).toBeUndefined();
    // Weekly key was NEVER incremented (only daily).
    expect(hoist.kvMock.incr).toHaveBeenCalledTimes(1);
  });

  it("D-39: send_inmail default daily=15, no weekly cap", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(5);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_inmail",
    });
    expect(r.blocked).toBe(false);
    expect(r.daily_limit).toBe(15);
    expect(r.weekly_limit).toBeUndefined();
  });

  // === D-39 blocked: daily cap ===

  it("D-39: blocks send_connection when daily=26 (>25), skips weekly incr to avoid double-burn", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(26);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("daily_cap");
    expect(r.daily_used).toBe(26);
    expect(r.retry_after).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    // Weekly key was NOT incremented (avoids double-burn).
    expect(hoist.kvMock.incr).toHaveBeenCalledTimes(1);
  });

  it("D-39: blocks send_inmail when daily=16 (>15)", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(16);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_inmail",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("daily_cap");
    expect(r.daily_limit).toBe(15);
  });

  // === D-39 blocked: weekly cap ===

  it("D-39: blocks send_connection when weekly=101 (>100) even with daily under cap", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(20).mockResolvedValueOnce(101);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("weekly_cap");
    expect(r.daily_used).toBe(20);
    expect(r.weekly_used).toBe(101);
    expect(r.weekly_limit).toBe(100);
    // retry_after = next Monday UTC midnight ISO
    expect(r.retry_after).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  // === Env overrides (read at CALL time, not module load) ===

  it("respects KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP env override", async () => {
    process.env.KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP = "10";
    hoist.kvMock.incr.mockResolvedValueOnce(11);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("daily_cap");
    expect(r.daily_limit).toBe(10);
  });

  it("respects KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP env override (INFO 7 — mirrors daily-override coverage)", async () => {
    process.env.KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP = "50";
    // daily under (20 <= 25 default), weekly over the 50 override
    hoist.kvMock.incr.mockResolvedValueOnce(20).mockResolvedValueOnce(51);
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("weekly_cap");
    expect(r.weekly_limit).toBe(50);
    expect(r.weekly_used).toBe(51);
  });

  // === D-40 fail-CLOSED (default) — 2 paths ===

  it("D-40 default: fails CLOSED when kv.incr() throws", async () => {
    hoist.kvMock.incr.mockRejectedValueOnce(new Error("KV down"));
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("kv_unavailable");
    expect(r.retry_after).toBeDefined();
    // retry_after = now + 60s ISO — sanity-check it's a valid future ISO.
    expect(new Date(r.retry_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it("D-40 default: fails CLOSED when KVStore impl has no .incr method", async () => {
    // Stomp incr to undefined on the shared mock for this case only.
    (hoist.kvMock as { incr?: unknown }).incr = undefined;
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("kv_unavailable");
    expect(r.retry_after).toBeDefined();
  });

  // === D-40 escape hatch (opt-in fail-OPEN) ===

  it("D-40 escape hatch: KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open returns allowed on KV failure", async () => {
    process.env.KEBAB_UNIPILE_RATELIMIT_FAIL_MODE = "open";
    hoist.kvMock.incr.mockRejectedValueOnce(new Error("KV down"));
    const r = await checkUnipileRateLimit({
      account_id: "acct1",
      tool: "send_connection",
    });
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("kv_unavailable");
    // No retry_after on fail-open — caller proceeds with the write.
    expect(r.retry_after).toBeUndefined();
  });

  // === D-38 key format (exact-shape assertions) ===

  it("D-38: uses correct daily key format `unipile:ratelimit:<acct>:<tool>:<YYYY-MM-DD>:daily` with 36h TTL", async () => {
    hoist.kvMock.incr.mockResolvedValue(1);
    await checkUnipileRateLimit({
      account_id: "acct_abc",
      tool: "send_connection",
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(hoist.kvMock.incr).toHaveBeenNthCalledWith(
      1,
      `unipile:ratelimit:acct_abc:send_connection:${today}:daily`,
      { ttlSeconds: 36 * 3600 }
    );
  });

  it("D-38: uses correct weekly key format `unipile:ratelimit:<acct>:<tool>:<YYYY-Www>:weekly` with 9d TTL", async () => {
    hoist.kvMock.incr.mockResolvedValue(1);
    await checkUnipileRateLimit({
      account_id: "acct_abc",
      tool: "send_connection",
    });
    expect(hoist.kvMock.incr).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^unipile:ratelimit:acct_abc:send_connection:\d{4}-W\d{2}:weekly$/),
      { ttlSeconds: 9 * 86_400 }
    );
  });

  // === D-41 multi-tool isolation ===

  it("D-41: counters are isolated per tool (send_connection and send_message share no key)", async () => {
    hoist.kvMock.incr.mockResolvedValue(1);
    await checkUnipileRateLimit({ account_id: "acct1", tool: "send_connection" });
    await checkUnipileRateLimit({ account_id: "acct1", tool: "send_message" });
    const calls = hoist.kvMock.incr.mock.calls.map((c) => c[0] as string);
    expect(calls.some((k) => /:send_connection:.+:daily$/.test(k))).toBe(true);
    expect(calls.some((k) => /:send_message:.+:daily$/.test(k))).toBe(true);
    // Three calls total: send_connection daily + send_connection weekly + send_message daily.
    expect(calls.length).toBe(3);
    expect(new Set(calls).size).toBe(3);
  });
});
