/**
 * P1 fold-in (Phase 38): err.message leaks on /api/config/env 500 paths.
 *
 * Pre-v0.10 the catch branches in /api/config/env returned
 * `{ ok: false, error: err.message }`. Upstream errors can embed
 * bearer tokens in their messages, so we now return the canonical
 * `{ error: "internal_error", errorId, hint }` shape and log the
 * sanitized message + errorId server-side.
 */
import { describe, it, expect } from "vitest";
import { errorResponse, generateErrorId } from "@/core/error-response";

describe("error-response canonical shape (P1 fold-in)", () => {
  it("generateErrorId returns err_<timestamp>_<hex>", () => {
    const id = generateErrorId();
    expect(id).toMatch(/^err_[a-z0-9]+_[a-f0-9]{8}$/);
  });

  it("generateErrorId is unique across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add(generateErrorId());
    expect(ids.size).toBe(10);
  });

  it("errorResponse body is { error, errorId, hint } — never err.message", async () => {
    const err = new Error("connection failed with Bearer abc123xyz456");
    const res = errorResponse(err, { status: 500, route: "config/env" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(typeof body.errorId).toBe("string");
    expect(typeof body.hint).toBe("string");
    // The raw message MUST NOT appear in the client response
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("abc123xyz456");
    expect(serialized).not.toContain("connection failed");
  });

  it("errorResponse respects caller-chosen status", async () => {
    const res = errorResponse(new Error("downstream 503"), {
      status: 503,
      route: "config/logs",
    });
    expect(res.status).toBe(503);
  });

  it("errorResponse handles non-Error values gracefully", async () => {
    const res = errorResponse("plain string error", { status: 500, route: "test" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
  });
});
