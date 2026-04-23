/**
 * Phase 53 — src/core/upstash-rest.ts tests.
 *
 * Covers:
 *   - creds-absent short-circuit (no fetch call)
 *   - parse happy-path (used_memory bytes + used_memory_human string)
 *   - parse garbage fallback
 *   - fetch 200 mocked full round-trip
 *   - AbortError / timeout path
 *   - error-message sanitization (never contains token)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getUpstashInfo, parseUpstashUsedBytes } from "../../src/core/upstash-rest";

describe("parseUpstashUsedBytes", () => {
  it("parses both used_memory and used_memory_human", () => {
    const input = [
      "# Server",
      "redis_version:7.4.0",
      "# Memory",
      "used_memory:1048576",
      "used_memory_human:1.00M",
      "used_memory_peak:2097152",
      "",
    ].join("\r\n");
    expect(parseUpstashUsedBytes(input)).toEqual({
      usedBytes: 1048576,
      usedHuman: "1.00M",
    });
  });

  it("returns nulls on garbage input", () => {
    expect(parseUpstashUsedBytes("garbage")).toEqual({
      usedBytes: null,
      usedHuman: null,
    });
  });

  it("tolerates missing human but present bytes", () => {
    const input = "used_memory:524288\r\n";
    expect(parseUpstashUsedBytes(input)).toEqual({
      usedBytes: 524288,
      usedHuman: null,
    });
  });

  it("tolerates \\n-only line endings", () => {
    const input = "used_memory:2048\nused_memory_human:2.00K\n";
    expect(parseUpstashUsedBytes(input)).toEqual({
      usedBytes: 2048,
      usedHuman: "2.00K",
    });
  });
});

describe("getUpstashInfo", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null when creds are absent", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const result = await getUpstashInfo();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses /info response and returns source: 'upstash'", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://my-upstash.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "SECRETTOKEN123");

    const infoText = "used_memory:2097152\r\nused_memory_human:2.00M\r\n";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: infoText }),
      text: async () => JSON.stringify({ result: infoText }),
    } as Response);

    const result = await getUpstashInfo();
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      usedBytes: 2097152,
      usedHuman: "2.00M",
      source: "upstash",
    });
  });

  it("returns source: 'unknown' on AbortError without unhandled rejection", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://my-upstash.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "SECRETTOKEN123");

    const abortErr = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    global.fetch = vi.fn().mockRejectedValue(abortErr);

    const result = await getUpstashInfo();
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      usedBytes: null,
      usedHuman: null,
      source: "unknown",
    });
    expect(typeof result!.error).toBe("string");
  });

  it("sanitizes error message of the token", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://my-upstash.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "SECRETTOKEN123");

    // Fetch rejects with a message that includes the token.
    global.fetch = vi.fn().mockRejectedValue(new Error("fetch failed for SECRETTOKEN123 endpoint"));

    const result = await getUpstashInfo();
    expect(result).not.toBeNull();
    expect(result!.error ?? "").not.toContain("SECRETTOKEN123");
  });

  it("returns source: 'unknown' on non-ok HTTP status", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://my-upstash.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "SECRETTOKEN123");

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "server error",
    } as Response);

    const result = await getUpstashInfo();
    expect(result).not.toBeNull();
    expect(result!.source).toBe("unknown");
  });
});
