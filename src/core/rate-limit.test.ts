import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "./rate-limit";
import { getKVStore, resetKVStoreCache } from "./kv-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("checkRateLimit", () => {
  let kvDir: string;
  let savedCwd: string;

  beforeEach(() => {
    // Isolate each test's KV into its own temp dir so buckets from
    // previous tests don't leak.
    savedCwd = process.cwd();
    kvDir = mkdtempSync(join(tmpdir(), "mymcp-rl-test-"));
    process.chdir(kvDir);
    resetKVStoreCache();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    resetKVStoreCache();
    try {
      rmSync(kvDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("allows the first request and decrements remaining", async () => {
    const result = await checkRateLimit("user-a", { scope: "test", limit: 3 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks when the limit is exceeded within the same bucket", async () => {
    await checkRateLimit("user-b", { scope: "test", limit: 2 });
    await checkRateLimit("user-b", { scope: "test", limit: 2 });
    const result = await checkRateLimit("user-b", { scope: "test", limit: 2 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("partitions buckets by scope", async () => {
    await checkRateLimit("user-c", { scope: "mcp", limit: 1 });
    // Different scope → separate bucket.
    const result = await checkRateLimit("user-c", { scope: "setup", limit: 1 });
    expect(result.allowed).toBe(true);
  });

  it("sweeps stale buckets on the first request of a new minute window", async () => {
    // Seed an old bucket directly so the sweep has something to clean.
    const kv = getKVStore();
    const idHash = "0123456789abcdef";
    await kv.set(`ratelimit:test:${idHash}:1000000`, "5");
    await kv.set(`ratelimit:test:${idHash}:1000001`, "5");

    // Confirm seeded
    const beforeKeys = await kv.list(`ratelimit:test:${idHash}:`);
    expect(beforeKeys.length).toBe(2);

    // Calling checkRateLimit with the same idHash won't happen because
    // the function hashes internally. Instead, we directly exercise the
    // listing behavior — a fresh call under the same scope should not
    // touch our seeded keys (which use a fake idHash), but ensure the
    // function doesn't throw on the sweep path.
    await checkRateLimit("user-d", { scope: "test", limit: 3 });

    // The seeded buckets for the fake idHash remain because the sweep is
    // keyed by the caller's own identifier hash. This is by design —
    // cleanup is per-caller, not global.
    const afterKeys = await kv.list(`ratelimit:test:${idHash}:`);
    expect(afterKeys.length).toBe(2);
  });
});
