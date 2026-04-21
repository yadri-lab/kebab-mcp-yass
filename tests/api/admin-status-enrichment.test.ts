/**
 * OBS-02: /api/admin/status firstRun section tests.
 *
 * Closes .planning/milestones/v0.10-durability-ROADMAP.md Phase 38 OBS-02.
 * Verifies: rehydrateCount shape, kvLatencySamples array, envPresent
 * boolean-only contract, auth regression guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "@/../app/api/admin/status/route";
import { __resetFirstRunForTests } from "@/core/first-run";
import { resetKVStoreCache, __resetKVLatencyBufferForTests } from "@/core/kv-store";

const ADMIN_TOKEN = "admin-token-for-tests";

function makeReq(auth = true): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  return new Request("http://localhost/api/admin/status", { headers });
}

describe("/api/admin/status firstRun enrichment (OBS-02)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "NODE_ENV",
    "ADMIN_AUTH_TOKEN",
    "MCP_AUTH_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "VERCEL",
  ];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
    // Set a real admin token so checkAdminAuth uses token-compare path
    // (avoids loopback-bypass flakes under different test harnesses).
    process.env.ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
    resetKVStoreCache();
    __resetKVLatencyBufferForTests();
    __resetFirstRunForTests();
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    resetKVStoreCache();
    __resetFirstRunForTests();
  });

  it("returns 401 without admin auth", async () => {
    const res = await GET(makeReq(false));
    expect(res.status).toBe(401);
  });

  it("authorized GET includes a firstRun section with all three subfields", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firstRun).toBeDefined();
    expect(body.firstRun.rehydrateCount).toBeDefined();
    expect(body.firstRun.rehydrateCount.total).toBeTypeOf("number");
    expect(body.firstRun.rehydrateCount.last24h).toBeTypeOf("number");
    expect(Array.isArray(body.firstRun.kvLatencySamples)).toBe(true);
    expect(body.firstRun.envPresent).toBeDefined();
  });

  it("envPresent contains only booleans — zero value leak", async () => {
    process.env.MCP_AUTH_TOKEN = "leaky-secret-value";
    const res = await GET(makeReq());
    const body = await res.json();
    const presence = body.firstRun.envPresent as Record<string, unknown>;
    expect(Object.keys(presence).length).toBeGreaterThan(5);
    for (const [, v] of Object.entries(presence)) {
      expect(typeof v).toBe("boolean");
    }
    const serialized = JSON.stringify(presence);
    expect(serialized).not.toContain("leaky-secret-value");
  });

  it("envPresent surfaces ADMIN_AUTH_TOKEN and MCP_AUTH_TOKEN as true when set", async () => {
    process.env.MCP_AUTH_TOKEN = "dummy";
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.firstRun.envPresent.ADMIN_AUTH_TOKEN).toBe(true);
    expect(body.firstRun.envPresent.MCP_AUTH_TOKEN).toBe(true);
  });

  it("existing fields (version, packs, config) are preserved", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.version).toBeDefined();
    expect(Array.isArray(body.packs)).toBe(true);
    expect(body.config).toBeDefined();
    expect(body.config.timezone).toBeDefined();
  });

  it("rehydrateCount defaults to zeros when KV is unconfigured (Vercel /tmp only)", async () => {
    // Force the "no external KV" path: VERCEL=1 + no Upstash → rehydrate
    // counter skips KV and returns the default { total: 0, last24h: 0 }.
    process.env.VERCEL = "1";
    resetKVStoreCache();
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.firstRun.rehydrateCount.total).toBe(0);
    expect(body.firstRun.rehydrateCount.last24h).toBe(0);
  });
});
