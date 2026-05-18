/**
 * Phase 70 / Plan 01 / Task 1 — verifier tests (TDD RED).
 *
 * Coverage (per plan <behavior>):
 *  - HMAC header valid → mode: "hmac", ok: true
 *  - HMAC header present + mismatched → mode: "hmac", ok: false, reason: "hmac_mismatch"
 *    (CRITICAL: MUST NOT fall through to static path — downgrade-attack guard)
 *  - HMAC header ABSENT + Unipile-Auth valid → mode: "static", ok: true
 *  - HMAC header ABSENT + Unipile-Auth mismatched → mode: "static", ok: false,
 *    reason: "static_mismatch"
 *  - both headers absent → mode: "rejected", ok: false,
 *    reason: "no_signature_or_auth_header"
 *  - equal-length-protection: an HMAC value of a DIFFERENT length than the
 *    expected hex digest still resolves to a clean false (does NOT throw on
 *    timingSafeEqual length mismatch).
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyUnipileWebhook } from "../verifier";

const SECRET = "unit-test-secret-do-not-leak";
const BODY = JSON.stringify({ event: "message_received", message_id: "abc-123", is_sender: false });

function hmacOf(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyUnipileWebhook — HMAC path (X-Unipile-Signature)", () => {
  it("returns mode:hmac ok:true on valid HMAC", () => {
    const sig = hmacOf(BODY, SECRET);
    const headers = new Headers({ "x-unipile-signature": sig });
    const result = verifyUnipileWebhook(BODY, headers, SECRET);
    expect(result).toEqual({ mode: "hmac", ok: true });
  });

  it("returns mode:hmac ok:false reason:hmac_mismatch when HMAC differs (no static fallthrough)", () => {
    const headers = new Headers({
      "x-unipile-signature": hmacOf(BODY, "different-secret"),
      // CRITICAL: also include a VALID static auth header. The verifier MUST
      // NOT fall through to static after an HMAC mismatch (downgrade-attack
      // guard). Result must remain hmac/false.
      "unipile-auth": SECRET,
    });
    const result = verifyUnipileWebhook(BODY, headers, SECRET);
    expect(result.mode).toBe("hmac");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hmac_mismatch");
  });

  it("returns mode:hmac ok:false on differently-shaped HMAC value (length-mismatch-safe)", () => {
    const headers = new Headers({ "x-unipile-signature": "too-short" });
    const result = verifyUnipileWebhook(BODY, headers, SECRET);
    expect(result.mode).toBe("hmac");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hmac_mismatch");
  });
});

describe("verifyUnipileWebhook — static path (Unipile-Auth)", () => {
  it("returns mode:static ok:true on matching Unipile-Auth", () => {
    const headers = new Headers({ "unipile-auth": SECRET });
    const result = verifyUnipileWebhook(BODY, headers, SECRET);
    expect(result).toEqual({ mode: "static", ok: true });
  });

  it("returns mode:static ok:false reason:static_mismatch on bad Unipile-Auth", () => {
    const headers = new Headers({ "unipile-auth": "wrong-token" });
    const result = verifyUnipileWebhook(BODY, headers, SECRET);
    expect(result.mode).toBe("static");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("static_mismatch");
  });
});

describe("verifyUnipileWebhook — rejection", () => {
  it("returns mode:rejected ok:false reason:no_signature_or_auth_header when both absent", () => {
    const headers = new Headers({ "user-agent": "axios/1.7.7" });
    const result = verifyUnipileWebhook(BODY, headers, SECRET);
    expect(result).toEqual({
      mode: "rejected",
      ok: false,
      reason: "no_signature_or_auth_header",
    });
  });
});
