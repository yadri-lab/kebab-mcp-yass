/**
 * Phase 68 / Plan 02 / Task 3 — Unipile error taxonomy tests.
 *
 * Covers:
 *  - classifyUnipileError() mapping for the 9 documented status/type
 *    combinations + the fail-safe default for non-SDK / malformed inputs.
 *  - 4 typed error classes (rate-limit, account-restricted, not-connected,
 *    5xx) each carrying the right retryable flag + recovery hints.
 */
import { describe, it, expect, vi } from "vitest";

const hoist = vi.hoisted(() => {
  class FakeUnsuccessful extends Error {
    body: { status?: number; type?: string };
    constructor(body: { status?: number; type?: string }) {
      super(`Unipile error ${JSON.stringify(body)}`);
      this.body = body;
    }
  }
  return { FakeUnsuccessful };
});

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: hoist.FakeUnsuccessful,
}));

import {
  classifyUnipileError,
  UnipileRateLimitError,
  UnipileAccountRestrictedError,
  UnipileNotConnectedError,
  Unipile5xxError,
} from "../errors";

const FakeUnsuccessful = hoist.FakeUnsuccessful;

describe("Phase 68 / Plan 02 — classifyUnipileError", () => {
  it.each<[number, string | undefined, string]>([
    [429, undefined, "error_rate_limit"],
    [422, "cannot_resend_yet", "error_rate_limit"],
    [422, "validation_error", "error_unipile_5xx"], // 422 without cannot_resend → fallback
    [401, undefined, "error_account_restricted"],
    [403, undefined, "error_account_restricted"],
    [404, undefined, "error_not_connected"],
    [500, undefined, "error_unipile_5xx"],
    [502, undefined, "error_unipile_5xx"],
    [503, undefined, "error_unipile_5xx"],
  ])("status %i type=%s → %s", (status, type, expected) => {
    const body = type === undefined ? { status } : { status, type };
    expect(classifyUnipileError(new FakeUnsuccessful(body))).toBe(expected);
  });

  it("returns error_unipile_5xx for non-SDK errors (fail-safe default)", () => {
    expect(classifyUnipileError(new Error("network down"))).toBe("error_unipile_5xx");
    expect(classifyUnipileError(null)).toBe("error_unipile_5xx");
    expect(classifyUnipileError("string")).toBe("error_unipile_5xx");
    expect(classifyUnipileError(undefined)).toBe("error_unipile_5xx");
  });

  it("returns error_unipile_5xx when body is missing/empty", () => {
    const err = new FakeUnsuccessful({});
    expect(classifyUnipileError(err)).toBe("error_unipile_5xx");
  });

  it("returns error_unipile_5xx when status is not a number", () => {
    const err = new FakeUnsuccessful({} as { status?: number });
    // simulate corrupt body
    (err as unknown as { body: unknown }).body = { status: "oops" };
    expect(classifyUnipileError(err)).toBe("error_unipile_5xx");
  });
});

describe("Phase 68 / Plan 02 — typed error classes", () => {
  it("UnipileRateLimitError is retryable, name + message preserved", () => {
    const e = new UnipileRateLimitError("429 from upstream");
    expect(e.name).toBe("UnipileRateLimitError");
    expect(e.message).toBe("429 from upstream");
    expect(e.retryable).toBe(true);
  });

  it("UnipileAccountRestrictedError is NOT retryable", () => {
    const e = new UnipileAccountRestrictedError("403 forbidden");
    expect(e.name).toBe("UnipileAccountRestrictedError");
    expect(e.retryable).toBe(false);
  });

  it("UnipileNotConnectedError is NOT retryable", () => {
    const e = new UnipileNotConnectedError("404 not in network");
    expect(e.name).toBe("UnipileNotConnectedError");
    expect(e.retryable).toBe(false);
  });

  it("Unipile5xxError IS retryable", () => {
    const e = new Unipile5xxError("503 unavailable");
    expect(e.name).toBe("Unipile5xxError");
    expect(e.retryable).toBe(true);
  });

  it("typed errors preserve cause when provided", () => {
    const root = new Error("root cause");
    const e = new UnipileRateLimitError("wrapped", { cause: root });
    expect(e.cause).toBe(root);
  });

  it("typed errors expose recovery hints (LLM-safe)", () => {
    const rate = new UnipileRateLimitError("x");
    const restricted = new UnipileAccountRestrictedError("x");
    const notConn = new UnipileNotConnectedError("x");
    const fiveXx = new Unipile5xxError("x");
    expect(rate.recovery).toBeTruthy();
    expect(restricted.recovery).toBeTruthy();
    expect(notConn.recovery).toBeTruthy();
    expect(fiveXx.recovery).toBeTruthy();
  });
});
