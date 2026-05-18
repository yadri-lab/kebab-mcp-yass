/**
 * Phase 68 / Plan 02 / Task 2 — withRetry helper tests.
 *
 * vi.useFakeTimers() + vi.runAllTimersAsync() so the natural exponential
 * backoff (200+400+800ms = ~1.4s) doesn't slow the suite. Tests assert on
 * retry COUNT and final outcome, not exact delay values — the jitter is
 * intentionally non-deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// vi.mock factories hoist above top-level class/const decls — share the
// FakeUnsuccessful class via vi.hoisted() so the mock factory and the
// test bodies see the same constructor (instanceof checks rely on it).
const hoist = vi.hoisted(() => {
  class FakeUnsuccessful extends Error {
    body: { status?: number };
    constructor(status?: number) {
      super(`Unipile HTTP ${status}`);
      // Build body conditionally so exactOptionalPropertyTypes accepts the
      // shape — `status?: number` doesn't allow an explicit `undefined`.
      this.body = status === undefined ? {} : { status };
    }
  }
  return { FakeUnsuccessful };
});

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: hoist.FakeUnsuccessful,
}));

import { withRetry } from "../retry";

const FakeUnsuccessful = hoist.FakeUnsuccessful;

describe("Phase 68 / Plan 02 — unipile/lib/retry.ts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns value on first success (no retries)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const p = withRetry(fn);
    await vi.runAllTimersAsync();
    expect(await p).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to 3 attempts total on 429 then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new FakeUnsuccessful(429))
      .mockRejectedValueOnce(new FakeUnsuccessful(429))
      .mockResolvedValueOnce("ok");
    const p = withRetry(fn, { baseMs: 1 });
    await vi.runAllTimersAsync();
    expect(await p).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on 502, 503, 504", async () => {
    for (const status of [502, 503, 504]) {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new FakeUnsuccessful(status))
        .mockResolvedValue("ok");
      const p = withRetry(fn, { baseMs: 1 });
      await vi.runAllTimersAsync();
      await p;
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("does NOT retry on 400, 403, 404, 422 (non-retryable client errors)", async () => {
    for (const status of [400, 403, 404, 422]) {
      const fn = vi.fn().mockRejectedValue(new FakeUnsuccessful(status));
      await expect(withRetry(fn, { baseMs: 1 })).rejects.toBeInstanceOf(FakeUnsuccessful);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT retry on non-SDK errors (e.g., plain Error / network down)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toThrow("network down");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after max attempts exhausted on persistent 429", async () => {
    const fn = vi.fn().mockRejectedValue(new FakeUnsuccessful(429));
    // Attach the rejection assertion BEFORE running timers so the rejection
    // is not orphaned in vitest's unhandled-rejection tracker.
    const p = withRetry(fn, { max: 3, baseMs: 1 });
    const assertion = expect(p).rejects.toBeInstanceOf(FakeUnsuccessful);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
