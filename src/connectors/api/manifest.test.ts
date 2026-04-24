import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiConnection, createApiTool, _resetApiToolsCacheForTests } from "./store";
import { apiConnectionsConnector } from "./manifest";
import { resetKVStoreCache } from "@/core/kv-store";

/**
 * Regression coverage for the v0.15 "custom tools return 0 on cold lambda"
 * bug. See skills/manifest.test.ts for the same pattern.
 */

describe("api-connections connector refresh hook", () => {
  let tmp: string;
  const origKv = process.env.MYMCP_KV_PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-api-manifest-"));
    process.env.MYMCP_KV_PATH = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
  });

  afterEach(async () => {
    if (origKv === undefined) delete process.env.MYMCP_KV_PATH;
    else process.env.MYMCP_KV_PATH = origKv;
    resetKVStoreCache();
    _resetApiToolsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("declares a refresh hook", () => {
    expect(typeof apiConnectionsConnector.refresh).toBe("function");
  });

  it("exposes custom tools after refresh() primes the cache", async () => {
    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    await createApiTool({
      connectionId: conn.id,
      name: "ping",
      method: "GET",
      pathTemplate: "/ping",
    });

    // Drop the cache to simulate a fresh cold lambda.
    _resetApiToolsCacheForTests();
    expect(apiConnectionsConnector.tools).toHaveLength(0);

    // Prime via the manifest hook.
    await apiConnectionsConnector.refresh?.();

    const after = apiConnectionsConnector.tools;
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("ping");
  });

  it("createApiTool updates the sync cache in lock-step", async () => {
    await apiConnectionsConnector.refresh?.();
    expect(apiConnectionsConnector.tools).toHaveLength(0);

    const conn = await createApiConnection({
      name: "Acme",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "none" },
    });
    await createApiTool({
      connectionId: conn.id,
      name: "live_tool",
      method: "GET",
      pathTemplate: "/x",
    });

    // No explicit refresh required — the write path populated the cache.
    expect(apiConnectionsConnector.tools).toHaveLength(1);
  });
});
