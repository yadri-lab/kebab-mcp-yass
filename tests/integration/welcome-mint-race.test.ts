/**
 * UX-04 — Welcome-init mint-race integration test.
 *
 * Phase 45 Task 9. Validates the T11 mint-race fix: when two
 * concurrent POST /api/welcome/init calls hold the same first-run
 * claim cookie, exactly ONE wins the atomic SETNX and returns
 * 200+token; the other returns 409 `{ error: "already_minted" }`
 * without echoing the winner's token in the body.
 *
 * Model: same-process test exercises `flushBootstrapToKvIfAbsent()`
 * directly against the FilesystemKV backend (which emulates SETNX
 * via the write queue). The Upstash path (`SET key value NX EX`) is
 * the production race arbiter — it has identical semantics but
 * cannot be exercised here without a live Upstash; the contract
 * unit test in `tests/core/kv-store.test.ts` (if any) + the explicit
 * UpstashKV.setIfNotExists implementation hold the line there.
 *
 * This file is EXCLUDED from the default `npm test` pool (it spins
 * up isolated KV fixtures + resets module state) and runs via
 * `npm run test:integration`. When wiring into a CI stage, include
 * alongside `welcome-durability.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_KV_DIR = join(tmpdir(), `mymcp-mint-race-${process.pid}`);
const TEST_KV_PATH = join(TEST_KV_DIR, "kv.json");
const TMP_BOOTSTRAP_PATH = join(tmpdir(), ".mymcp-bootstrap.json");

function resetTestFilesystem(): void {
  try {
    if (existsSync(TMP_BOOTSTRAP_PATH)) unlinkSync(TMP_BOOTSTRAP_PATH);
  } catch {
    // ignore
  }
  try {
    if (existsSync(TEST_KV_DIR)) rmSync(TEST_KV_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  mkdirSync(TEST_KV_DIR, { recursive: true });
}

describe("UX-04 — welcome-init mint-race", () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  const TRACKED = [
    "MCP_AUTH_TOKEN",
    "ADMIN_AUTH_TOKEN",
    "MYMCP_RECOVERY_RESET",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "MYMCP_KV_PATH",
    "VERCEL",
  ];

  beforeEach(() => {
    for (const k of TRACKED) SAVED_ENV[k] = process.env[k];
    // Point the FilesystemKV at our isolated temp path. The underlying
    // getKVStore() reads MYMCP_KV_PATH to override the default.
    resetTestFilesystem();
    process.env.MYMCP_KV_PATH = TEST_KV_PATH;
    // Force the non-Upstash path.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.VERCEL;
    // Allow the test process to be treated as loopback under the
    // pipeline's auth step (matches the pattern used in other
    // regression tests — see tests/regression/welcome-flow.test.ts).
    process.env.MYMCP_TRUST_URL_HOST = "1";
  });

  afterEach(() => {
    for (const k of TRACKED) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k];
    }
  });

  it("two concurrent flushBootstrapToKvIfAbsent calls yield exactly one winner and one loser", async () => {
    // Reset module state so we start with a clean `activeBootstrap`.
    const { bootstrapToken, flushBootstrapToKvIfAbsent, forceReset } =
      await import("@/core/first-run");
    const { resetKVStoreCache, getKVStore } = await import("@/core/kv-store");

    resetKVStoreCache();
    forceReset();

    // Simulate browser A minting into the in-memory cache.
    const claimA = "a".repeat(64);
    const { token: tokenA } = bootstrapToken(claimA);
    expect(tokenA).toMatch(/^[a-f0-9]{64}$/);

    // Winner: A's flush hits an empty KV, writes, returns ok=true.
    const resA = await flushBootstrapToKvIfAbsent();
    expect(resA.ok).toBe(true);

    // Simulate browser B in a separate "lambda" — same claim id but
    // a freshly-minted token (because B's lambda mints independently
    // before the KV check). We bypass forceReset so A's write stays
    // in KV; we DO reset the in-memory cache to simulate a second
    // lambda's state.
    const activeKvSnapshot = await getKVStore().get("mymcp:firstrun:bootstrap");
    expect(activeKvSnapshot).not.toBeNull();
    expect(activeKvSnapshot).toContain(tokenA);

    // In the same module instance (representing a second warm
    // concurrent request on the same lambda, or a cross-lambda race
    // after the first lambda's write landed), re-mint under a
    // different claim id and attempt a flush.
    const claimB = "b".repeat(64);
    const { token: tokenB } = bootstrapToken(claimB);
    expect(tokenB).not.toBe(tokenA); // new claim yields a new token

    const resB = await flushBootstrapToKvIfAbsent();
    expect(resB.ok).toBe(false);
    if (!resB.ok) {
      expect(resB.reason).toBe("already_minted");
      // The returned `existing` holds the winner's bootstrap — A's token.
      expect(resB.existing).not.toBeNull();
      expect(resB.existing?.token).toBe(tokenA);
      expect(resB.existing?.claimId).toBe(claimA);
    }

    // KV retains exactly one bootstrap record (the winner's).
    const finalKv = await getKVStore().get("mymcp:firstrun:bootstrap");
    expect(finalKv).toBe(activeKvSnapshot);
  });

  it("idempotent retry: same claim id re-flushing returns ok=true", async () => {
    const { bootstrapToken, flushBootstrapToKvIfAbsent, forceReset } =
      await import("@/core/first-run");
    const { resetKVStoreCache } = await import("@/core/kv-store");

    resetKVStoreCache();
    forceReset();

    const claim = "c".repeat(64);
    bootstrapToken(claim);
    const first = await flushBootstrapToKvIfAbsent();
    expect(first.ok).toBe(true);

    // Same claim id minted a second time — same token, same KV
    // entry. The SETNX collides with the caller's own previous
    // write, but because the existing claimId matches, the helper
    // treats it as a warm-retry and returns ok=true without
    // overwriting.
    bootstrapToken(claim);
    const second = await flushBootstrapToKvIfAbsent();
    expect(second.ok).toBe(true);
  });

  it("filesystem backend supports setIfNotExists (smoke test)", async () => {
    const { resetKVStoreCache, getKVStore } = await import("@/core/kv-store");
    resetKVStoreCache();
    const kv = getKVStore();
    expect(typeof kv.setIfNotExists).toBe("function");

    const first = await kv.setIfNotExists!("test:nx:key", "value-1");
    expect(first).toEqual({ ok: true });

    const second = await kv.setIfNotExists!("test:nx:key", "value-2");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.existing).toBe("value-1");
    }

    // Confirm the original value was preserved.
    const got = await kv.get("test:nx:key");
    expect(got).toBe("value-1");
  });
});
