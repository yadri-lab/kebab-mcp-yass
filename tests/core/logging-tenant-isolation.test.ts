/**
 * Phase 48 — ISO-01 / ISO-03.
 *
 * Per-tenant ring buffer isolation: tenant A writes logs under
 * `requestContext.run({tenantId:'alpha'}, ...)` cannot be observed by
 * tenant B calling `getRecentLogs()`. Root-scope reads (`opts.scope='all'`)
 * return the flattened union across all buckets.
 *
 * Covers Phase 42 FOLLOW-UP §1 + POST-V0.11-AUDIT §A.3 NIT.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  logToolCall,
  getRecentLogs,
  getToolStats,
  __resetRingBufferForTests,
  type ToolLog,
} from "@/core/logging";
import { requestContext } from "@/core/request-context";

function fakeLog(tool: string, status: "success" | "error" = "success"): ToolLog {
  return {
    tool,
    durationMs: 10,
    status,
    timestamp: new Date().toISOString(),
  };
}

describe("logging ring buffer — per-tenant isolation (ISO-01, ISO-03)", () => {
  beforeEach(() => {
    __resetRingBufferForTests();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetRingBufferForTests();
  });

  it("Test 1 — alpha-written logs are invisible to beta readers", async () => {
    await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
      logToolCall(fakeLog("tool-a"));
      logToolCall(fakeLog("tool-a"));
      logToolCall(fakeLog("tool-a"));
    });

    const betaLogs = await requestContext.run({ tenantId: "beta", credentials: {} }, async () =>
      getRecentLogs(20)
    );
    expect(betaLogs).toHaveLength(0);

    const alphaLogs = await requestContext.run({ tenantId: "alpha", credentials: {} }, async () =>
      getRecentLogs(20)
    );
    expect(alphaLogs).toHaveLength(3);
  });

  it("Test 2 — scope:'all' returns union across tenants (root read)", async () => {
    await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
      logToolCall(fakeLog("tool-a"));
      logToolCall(fakeLog("tool-a"));
      logToolCall(fakeLog("tool-a"));
    });
    await requestContext.run({ tenantId: "beta", credentials: {} }, async () => {
      logToolCall(fakeLog("tool-b"));
      logToolCall(fakeLog("tool-b"));
    });

    const all = getRecentLogs(20, { scope: "all" });
    expect(all).toHaveLength(5);
    const tools = all.map((l) => l.tool).sort();
    expect(tools).toEqual(["tool-a", "tool-a", "tool-a", "tool-b", "tool-b"]);
  });

  it("Test 3 — per-tenant LRU cap keeps most recent 100 per bucket", async () => {
    await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
      for (let i = 0; i < 105; i++) logToolCall(fakeLog(`tool-${i}`));
    });

    const alpha = getRecentLogs(200, { tenantId: "alpha" });
    expect(alpha).toHaveLength(100);
    // Oldest 5 should have rolled off: tool-0..tool-4 evicted; newest is tool-104
    expect(alpha[0].tool).toBe("tool-5");
    expect(alpha[alpha.length - 1].tool).toBe("tool-104");

    const beta = getRecentLogs(200, { tenantId: "beta" });
    expect(beta).toHaveLength(0);
  });

  it("Test 4 — null-tenant writes land in __root__ bucket", async () => {
    // Outside any requestContext — writes go to __root__
    logToolCall(fakeLog("root-tool"));
    logToolCall(fakeLog("root-tool"));

    const rootLogs = getRecentLogs(20);
    expect(rootLogs).toHaveLength(2);

    // From inside a tenant context, root entries are invisible.
    const alphaLogs = await requestContext.run({ tenantId: "alpha", credentials: {} }, async () =>
      getRecentLogs(20)
    );
    expect(alphaLogs).toHaveLength(0);

    // scope:'all' sees both.
    const all = getRecentLogs(20, { scope: "all" });
    expect(all).toHaveLength(2);
  });

  it("Test 5 — KEBAB_LOG_BUFFER_PER_TENANT=50 is honored", async () => {
    vi.stubEnv("KEBAB_LOG_BUFFER_PER_TENANT", "50");
    // The module caches its cap at module-load; we must re-evaluate.
    const mod = await import("@/core/logging");
    // Using __resetRingBufferForTests also clears buckets; cap is re-read.
    mod.__resetRingBufferForTests();

    await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
      for (let i = 0; i < 60; i++) logToolCall(fakeLog(`tool-${i}`));
    });

    const alpha = getRecentLogs(200, { tenantId: "alpha" });
    expect(alpha).toHaveLength(50);
  });

  it("Test 6 — getToolStats aggregates across all tenant buckets (operator-wide)", async () => {
    await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
      logToolCall(fakeLog("shared-tool", "success"));
      logToolCall(fakeLog("shared-tool", "error"));
    });
    await requestContext.run({ tenantId: "beta", credentials: {} }, async () => {
      logToolCall(fakeLog("shared-tool", "success"));
    });

    const stats = getToolStats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.errorCount).toBe(1);
    expect(stats.byTool["shared-tool"].calls).toBe(3);
    expect(stats.byTool["shared-tool"].errors).toBe(1);
  });

  it("Test 7 — __resetRingBufferForTests clears all buckets", async () => {
    await requestContext.run({ tenantId: "alpha", credentials: {} }, async () => {
      logToolCall(fakeLog("tool-a"));
    });
    await requestContext.run({ tenantId: "beta", credentials: {} }, async () => {
      logToolCall(fakeLog("tool-b"));
    });
    expect(getRecentLogs(20, { scope: "all" })).toHaveLength(2);

    __resetRingBufferForTests();
    expect(getRecentLogs(20, { scope: "all" })).toHaveLength(0);
  });
});
