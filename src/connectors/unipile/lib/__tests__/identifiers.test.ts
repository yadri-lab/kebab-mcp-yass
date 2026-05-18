/**
 * Phase 68 / Plan 03 / Task 1 — URL → URN resolver tests.
 *
 * Coverage:
 *  - normalizeProfileUrl (D-12): 4 URL variants + locale prefix + case + trailing slash
 *  - normalizeProfileUrl throws on unsupported formats (Sales Navigator, activity URL)
 *  - urnCacheKey: deterministic + correct prefix + 16-hex format + unique per URL
 *  - resolveProviderId cache HIT: returns from cache, does NOT call SDK
 *  - resolveProviderId cache MISS: calls SDK with slug-only identifier, writes KV
 *    with 30-day TTL (D-10) — verifies TTL VALUE PASSED, not actual expiry
 *    (Pitfall 7: FilesystemKV ignores TTL).
 *  - resolveProviderId on Unipile 429 (after withRetry exhausts): propagates per
 *    D-10 strict mode (no stale-while-revalidate).
 *  - resolveProviderId on malformed SDK response (no provider_id): throws.
 *  - resolveProviderId on corrupt cache JSON: falls through to fresh resolve.
 *
 * Mocks: getContextKVStore (KV layer), getUnipileClient (SDK), UnsuccessfulRequestError
 * class via vi.hoisted() per Plan 01/02's canonical pattern for vitest 4.x
 * mock-factory hoisting.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
  };
  const getProfileMock = vi.fn();
  // FakeUnsuccessful must satisfy `err instanceof UnsuccessfulRequestError`
  // inside withRetry; same vi.hoisted() trick Plan 02 retry.test.ts uses.
  class FakeUnsuccessful extends Error {
    body: { status?: number };
    constructor(status: number) {
      super(`Unipile ${status}`);
      this.name = "UnsuccessfulRequestError";
      // exactOptionalPropertyTypes-safe construction (Plan 02 lesson)
      this.body = status === undefined ? {} : { status };
    }
  }
  return { kvMock, getProfileMock, FakeUnsuccessful };
});

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

vi.mock("../client", () => ({
  getUnipileClient: () => ({ users: { getProfile: hoist.getProfileMock } }),
}));

// Identifiers.ts imports getUnipileClient from "./client" (same dir). The mock
// path above ("../client" from the __tests__ dir) intercepts the module
// regardless — vitest module mocks resolve by normalized module ID.

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: hoist.FakeUnsuccessful,
}));

import {
  normalizeProfileUrl,
  urnCacheKey,
  resolveProviderId,
  URN_TTL_SECONDS,
} from "../identifiers";

describe("normalizeProfileUrl (D-12)", () => {
  it.each([
    ["https://linkedin.com/in/antoine-vercken", "https://linkedin.com/in/antoine-vercken"],
    ["https://www.linkedin.com/in/antoine-vercken", "https://linkedin.com/in/antoine-vercken"],
    ["https://fr.linkedin.com/in/antoine-vercken", "https://linkedin.com/in/antoine-vercken"],
    ["https://de.linkedin.com/in/Antoine-Vercken/", "https://linkedin.com/in/antoine-vercken"],
    ["linkedin.com/in/antoine-vercken", "https://linkedin.com/in/antoine-vercken"],
    ["https://linkedin.com/in/ANTOINE-VERCKEN", "https://linkedin.com/in/antoine-vercken"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeProfileUrl(input)).toBe(expected);
  });

  it("throws on Sales Navigator URL (unsupported)", () => {
    expect(() => normalizeProfileUrl("https://linkedin.com/sales/people/abc")).toThrow(/Invalid/);
  });

  it("throws on activity URL", () => {
    expect(() =>
      normalizeProfileUrl("https://linkedin.com/feed/update/urn:li:activity:123")
    ).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => normalizeProfileUrl("")).toThrow(/Invalid/);
  });
});

describe("normalizeProfileUrl — D-44 query string + fragment support (UNI-25)", () => {
  it.each([
    [
      "https://www.linkedin.com/in/john-doe?originalSubdomain=fr",
      "https://linkedin.com/in/john-doe",
    ],
    [
      "https://linkedin.com/in/jane?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAA",
      "https://linkedin.com/in/jane",
    ],
    [
      "https://linkedin.com/in/bob?utm_source=newsletter&utm_campaign=q2",
      "https://linkedin.com/in/bob",
    ],
    ["https://fr.linkedin.com/in/marie?originalSubdomain=fr", "https://linkedin.com/in/marie"],
    ["https://linkedin.com/in/alice/#contact-info", "https://linkedin.com/in/alice"],
  ])("D-44: normalizes %s -> %s", (input, expected) => {
    expect(normalizeProfileUrl(input)).toBe(expected);
  });

  it("D-44: existing inputs without query/fragment unchanged (regression guard)", () => {
    // Sanity check that the regex extension does not perturb the phase-68 paths.
    expect(normalizeProfileUrl("https://linkedin.com/in/antoine-vercken")).toBe(
      "https://linkedin.com/in/antoine-vercken"
    );
  });
});

describe("urnCacheKey", () => {
  it("is deterministic for the same input", () => {
    const k1 = urnCacheKey("https://linkedin.com/in/antoine-vercken");
    const k2 = urnCacheKey("https://linkedin.com/in/antoine-vercken");
    expect(k1).toBe(k2);
  });

  it("uses unipile:urn: prefix + 16 hex chars", () => {
    const k = urnCacheKey("https://linkedin.com/in/antoine-vercken");
    expect(k).toMatch(/^unipile:urn:[a-f0-9]{16}$/);
  });

  it("different URLs produce different keys", () => {
    const a = urnCacheKey("https://linkedin.com/in/antoine-vercken");
    const b = urnCacheKey("https://linkedin.com/in/yassine-citoyen");
    expect(a).not.toBe(b);
  });
});

describe("resolveProviderId - cache HIT path", () => {
  beforeEach(() => {
    hoist.kvMock.get.mockReset();
    hoist.kvMock.set.mockReset();
    hoist.kvMock.delete.mockReset();
    hoist.getProfileMock.mockReset();
  });

  it("returns from cache and does NOT call SDK", async () => {
    hoist.kvMock.get.mockResolvedValue(
      JSON.stringify({ urn: "urn:li:provider:abc", resolved_at: "2026-01-01T00:00:00Z" })
    );
    const r = await resolveProviderId("https://linkedin.com/in/antoine-vercken", "acct_1");
    expect(r).toEqual({ provider_id: "urn:li:provider:abc", from_cache: true });
    expect(hoist.getProfileMock).not.toHaveBeenCalled();
    expect(hoist.kvMock.set).not.toHaveBeenCalled();
  });

  it("falls through on corrupt cache JSON", async () => {
    hoist.kvMock.get.mockResolvedValue("not-json{");
    hoist.getProfileMock.mockResolvedValue({ provider_id: "urn:li:fresh" });
    const r = await resolveProviderId("https://linkedin.com/in/antoine-vercken", "acct_1");
    expect(r.from_cache).toBe(false);
    expect(r.provider_id).toBe("urn:li:fresh");
  });

  it("falls through on cache row missing urn field", async () => {
    hoist.kvMock.get.mockResolvedValue(JSON.stringify({ resolved_at: "..." }));
    hoist.getProfileMock.mockResolvedValue({ provider_id: "urn:li:fresh" });
    const r = await resolveProviderId("https://linkedin.com/in/antoine-vercken", "acct_1");
    expect(r.from_cache).toBe(false);
    expect(r.provider_id).toBe("urn:li:fresh");
  });
});

describe("resolveProviderId - cache MISS path", () => {
  beforeEach(() => {
    hoist.kvMock.get.mockReset();
    hoist.kvMock.set.mockReset();
    hoist.kvMock.delete.mockReset();
    hoist.getProfileMock.mockReset();
  });

  it("calls SDK with slug-only identifier and writes cache with 30-day TTL (D-10)", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    hoist.getProfileMock.mockResolvedValue({ provider_id: "urn:li:fresh" });
    const r = await resolveProviderId("https://www.linkedin.com/in/Antoine-Vercken/", "acct_1");
    expect(hoist.getProfileMock).toHaveBeenCalledWith({
      account_id: "acct_1",
      identifier: "antoine-vercken",
    });
    // Verify TTL VALUE PASSED (Pitfall 7: FilesystemKV ignores TTL — verify call args, not actual expiry).
    expect(hoist.kvMock.set).toHaveBeenCalledWith(
      expect.stringMatching(/^unipile:urn:[a-f0-9]{16}$/),
      expect.stringContaining("urn:li:fresh"),
      URN_TTL_SECONDS
    );
    expect(URN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(r).toEqual({ provider_id: "urn:li:fresh", from_cache: false });
  });

  it("normalizes URL before computing cache key (locale + case + trailing slash)", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    hoist.getProfileMock.mockResolvedValue({ provider_id: "urn:li:fresh" });
    await resolveProviderId("https://fr.linkedin.com/in/Antoine-Vercken/", "acct_1");
    // Both calls should hit the SAME cache key as the canonical URL
    const canonicalKey = urnCacheKey("https://linkedin.com/in/antoine-vercken");
    expect(hoist.kvMock.get).toHaveBeenCalledWith(canonicalKey);
    expect(hoist.kvMock.set).toHaveBeenCalledWith(
      canonicalKey,
      expect.any(String),
      URN_TTL_SECONDS
    );
  });

  it("throws when SDK returns no provider_id (malformed response)", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    hoist.getProfileMock.mockResolvedValue({
      /* no provider_id */
    });
    await expect(resolveProviderId("https://linkedin.com/in/x", "acct_1")).rejects.toThrow(
      /provider_id/
    );
    expect(hoist.kvMock.set).not.toHaveBeenCalled();
  });

  it("throws when SDK returns empty string provider_id", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    hoist.getProfileMock.mockResolvedValue({ provider_id: "" });
    await expect(resolveProviderId("https://linkedin.com/in/x", "acct_1")).rejects.toThrow(
      /provider_id/
    );
    expect(hoist.kvMock.set).not.toHaveBeenCalled();
  });

  it("propagates Unipile 429 (D-10 strict: no stale-while-revalidate)", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    // withRetry will retry up to 3 times before re-throwing. Use fake timers to
    // collapse the natural ~1.4s wall-clock to ~0ms (Plan 02 retry.test.ts pattern).
    vi.useFakeTimers();
    hoist.getProfileMock.mockRejectedValue(new hoist.FakeUnsuccessful(429));
    const p = resolveProviderId("https://linkedin.com/in/x", "acct_1");
    // Detach assertion BEFORE running timers (Plan 02 lesson:
    // prevents stray unhandled-rejection in vitest output).
    const assertion = expect(p).rejects.toBeInstanceOf(hoist.FakeUnsuccessful);
    await vi.runAllTimersAsync();
    await assertion;
    expect(hoist.kvMock.set).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
