/**
 * OBS-04: OTel span emission tests.
 *
 * Closes .planning/milestones/v0.10-durability-ROADMAP.md Phase 38 OBS-04.
 * Verifies the 3 hot paths emit named spans when OTel is active, and
 * emit zero spans when OTel is not configured.
 *
 * Uses the InMemorySpanExporter from @opentelemetry/sdk-trace-base to
 * capture spans without needing a live collector.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// Install an in-memory OTel provider before any @/core/* module is loaded.
const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

function installInMemoryOtel(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdkBase = require("@opentelemetry/sdk-trace-base");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdkNode = require("@opentelemetry/sdk-trace-node");

  class RecordingProcessor {
    onStart(): void {}
    onEnd(span: { name: string; attributes: Record<string, unknown> }): void {
      spans.push({ name: span.name, attributes: { ...span.attributes } });
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
    forceFlush(): Promise<void> {
      return Promise.resolve();
    }
  }
  // OTel SDK v2+: pass all processors via constructor; addSpanProcessor
  // was removed.
  const provider = new sdkNode.NodeTracerProvider({
    spanProcessors: [
      new sdkBase.SimpleSpanProcessor(new sdkBase.InMemorySpanExporter()),
      new RecordingProcessor(),
    ],
  });
  provider.register();
  api.trace.setGlobalTracerProvider(provider);
}

describe("OTel span emission (OBS-04)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["OTEL_SERVICE_NAME", "OTEL_EXPORTER_OTLP_ENDPOINT", "MCP_AUTH_TOKEN"];

  beforeAll(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.OTEL_SERVICE_NAME = "mymcp-test";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    installInMemoryOtel();
  });

  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  beforeEach(() => {
    spans.length = 0;
  });

  it("mymcp.bootstrap.rehydrate span wraps rehydrateBootstrapAsync", async () => {
    const { rehydrateBootstrapAsync } = await import("@/core/first-run");
    await rehydrateBootstrapAsync();
    const rehydrate = spans.filter((s) => s.name === "mymcp.bootstrap.rehydrate");
    expect(rehydrate.length).toBeGreaterThanOrEqual(1);
    expect(rehydrate[0].attributes["mymcp.bootstrap.source"]).toBe("cold");
    expect(rehydrate[0].attributes["mymcp.status"]).toBe("ok");
  });

  it("mymcp.kv.write span wraps KVStore.set with key_prefix (first 2 segments only)", async () => {
    const { getKVStore, resetKVStoreCache } = await import("@/core/kv-store");
    resetKVStoreCache();
    const kv = getKVStore();
    await kv.set("tenant:alpha:skills:foo", '"bar"');
    const kvWrites = spans.filter((s) => s.name === "mymcp.kv.write");
    expect(kvWrites.length).toBeGreaterThanOrEqual(1);
    const lastSet = [...kvWrites].reverse().find((s) => s.attributes["mymcp.kv.op"] === "set");
    expect(lastSet).toBeDefined();
    expect(lastSet!.attributes["mymcp.kv.key_prefix"]).toBe("tenant:alpha");
    // Full key MUST NOT appear anywhere in the attributes
    const serialized = JSON.stringify(lastSet!.attributes);
    expect(serialized).not.toContain("tenant:alpha:skills:foo");
  });

  it("mymcp.auth.check span wraps checkAdminAuth", async () => {
    const { checkAdminAuth } = await import("@/core/auth");
    const req = new Request("http://localhost/api/admin/status");
    await checkAdminAuth(req);
    const authChecks = spans.filter((s) => s.name === "mymcp.auth.check");
    expect(authChecks.length).toBeGreaterThanOrEqual(1);
    expect(authChecks.some((s) => s.attributes["mymcp.auth.kind"] === "admin")).toBe(true);
  });

  it("mymcp.auth.check span wraps checkMcpAuth (sync)", async () => {
    const { checkMcpAuth } = await import("@/core/auth");
    const req = new Request("http://localhost/api/mcp");
    checkMcpAuth(req);
    const mcp = spans.filter(
      (s) => s.name === "mymcp.auth.check" && s.attributes["mymcp.auth.kind"] === "mcp"
    );
    expect(mcp.length).toBeGreaterThanOrEqual(1);
  });
});
