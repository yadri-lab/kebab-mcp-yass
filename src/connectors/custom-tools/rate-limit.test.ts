import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTestRunRateLimit, _TEST_RUNS_PER_MINUTE_FOR_TESTS } from "./rate-limit";
import { resetKVStoreCache } from "@/core/kv-store";

/**
 * `/test` endpoint rate-limit unit tests.
 *
 * The helper delegates to the shared `checkRateLimit`, so this file
 * only needs to assert that:
 *  - the first N runs (N = TEST_RUNS_PER_MINUTE) are allowed
 *  - the (N+1)-th run is denied with a positive `retryAfterSeconds`
 *  - distinct tokenIds get distinct buckets
 *
 * We use a fresh per-test temp KV dir so buckets from earlier tests
 * don't leak — same pattern as src/core/rate-limit.test.ts.
 */

describe("checkTestRunRateLimit", () => {
  let kvDir: string;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    kvDir = mkdtempSync(join(tmpdir(), "kebab-customtool-rl-"));
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

  it("allows the first 10 runs and denies the 11th within the same minute", async () => {
    expect(_TEST_RUNS_PER_MINUTE_FOR_TESTS).toBe(10);

    const tokenId = "admin-token-id-1";
    for (let i = 0; i < _TEST_RUNS_PER_MINUTE_FOR_TESTS; i++) {
      const r = await checkTestRunRateLimit(tokenId);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkTestRunRateLimit(tokenId);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // Bucket window is 60s; retryAfter must be in (0, 60].
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("partitions buckets by tokenId", async () => {
    // Burn one token's bucket to the cap.
    const tokenA = "token-a";
    for (let i = 0; i < _TEST_RUNS_PER_MINUTE_FOR_TESTS; i++) {
      await checkTestRunRateLimit(tokenA);
    }
    const aDenied = await checkTestRunRateLimit(tokenA);
    expect(aDenied.allowed).toBe(false);

    // A different token still has its full quota.
    const bAllowed = await checkTestRunRateLimit("token-b");
    expect(bAllowed.allowed).toBe(true);
  });

  it("treats null tokenId as 'anonymous' (single shared bucket)", async () => {
    // Two anonymous calls share the bucket; this is intentional —
    // anonymous probes shouldn't get a fresh quota per call.
    const r1 = await checkTestRunRateLimit(null);
    expect(r1.allowed).toBe(true);
    const r2 = await checkTestRunRateLimit(null);
    expect(r2.allowed).toBe(true);
    // Different remaining values prove they share the bucket.
    expect(r2.remaining).toBeLessThan(r1.remaining);
  });
});
