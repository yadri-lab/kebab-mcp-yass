/**
 * Phase 063 CRON-03 — formatRelativeTime helper unit tests.
 *
 * Pure-helper tests for time-bucket formatting:
 *   < 60s         → "just now"
 *   < 60min       → "Nm ago"
 *   < 24h         → "Nh ago"
 *   else          → "Nd ago"
 *   invalid input → "unknown"
 *   future input  → "just now" (clock-skew tolerance)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeTime } from "@/core/relative-time";

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-04-26T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function ago(ms: number): string {
    return new Date(NOW - ms).toISOString();
  }

  it("returns 'just now' for the current instant", () => {
    expect(formatRelativeTime(new Date(NOW).toISOString())).toBe("just now");
  });

  it("returns 'just now' for sub-minute past", () => {
    expect(formatRelativeTime(ago(30_000))).toBe("just now");
  });

  it("returns 'Nm ago' for 2 minutes", () => {
    expect(formatRelativeTime(ago(2 * 60_000))).toBe("2m ago");
  });

  it("returns '1h ago' for exactly 1 hour", () => {
    expect(formatRelativeTime(ago(60 * 60_000))).toBe("1h ago");
  });

  it("returns '3h ago' for 3 hours", () => {
    expect(formatRelativeTime(ago(3 * 60 * 60_000))).toBe("3h ago");
  });

  it("returns '2d ago' for 2 days", () => {
    expect(formatRelativeTime(ago(2 * 24 * 60 * 60_000))).toBe("2d ago");
  });

  it("returns 'unknown' for invalid string", () => {
    expect(formatRelativeTime("not-a-date")).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(formatRelativeTime("")).toBe("unknown");
  });

  it("returns 'just now' for future timestamps (clock-skew tolerance)", () => {
    const future = new Date(NOW + 5 * 60_000).toISOString();
    expect(formatRelativeTime(future)).toBe("just now");
  });
});
