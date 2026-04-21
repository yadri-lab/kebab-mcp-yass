/**
 * P0 fold-in (Phase 38): UpstashLogStore 5xx retry heuristic.
 *
 * Pre-v0.10 the circuit-breaker used `lastError.message.includes("5")`,
 * which tripped on any error message containing the digit "5" (e.g.
 * "timeout after 5s"). The fix parses an actual 3-digit HTTP status
 * code and trips only on 5xx.
 */
import { describe, it, expect } from "vitest";
import { extractHttpStatus } from "@/core/log-store";

describe("extractHttpStatus (P0 fold-in)", () => {
  it("returns null for 'timeout after 5s' (regression of the bug)", () => {
    expect(extractHttpStatus(new Error("timeout after 5s"))).toBe(null);
  });

  it("extracts 503 from 'Upstash LPUSH failed: 503 Service Unavailable'", () => {
    expect(extractHttpStatus(new Error("Upstash LPUSH failed: 503 Service Unavailable"))).toBe(503);
  });

  it("extracts 404 (not 5xx) from 'HTTP 404 not found'", () => {
    expect(extractHttpStatus(new Error("HTTP 404 not found"))).toBe(404);
  });

  it("returns null for 'rate limit' (no digits)", () => {
    expect(extractHttpStatus(new Error("rate limit"))).toBe(null);
  });

  it("returns null for 'retry 5 of 10' (single digit, not 3-digit code)", () => {
    expect(extractHttpStatus(new Error("retry 5 of 10"))).toBe(null);
  });

  it("returns 500 from 'Upstash 500 internal error'", () => {
    expect(extractHttpStatus(new Error("Upstash 500 internal error"))).toBe(500);
  });

  it("returns 200 if the error-stringification somehow captured a 2xx (edge case — will NOT trip 5xx)", () => {
    // Exercise: extractor returns 200, caller's `is5xx` check gates.
    expect(extractHttpStatus(new Error("got 200 but expected error"))).toBe(200);
  });
});
