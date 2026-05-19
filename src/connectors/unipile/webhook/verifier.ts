/**
 * Phase 70 / Plan 01 / Task 1 — Dual-mode Unipile webhook verifier (D-52).
 *
 * Unipile's dashboard ships webhook subscriptions with a static
 * `Unipile-Auth: <secret>` header on every POST; the empirical traffic
 * captured 2026-05-18 (RESEARCH §1) uses ONLY this path. The HMAC-SHA256
 * branch (`X-Unipile-Signature`) is documented for some sources but has
 * NEVER been observed live. We honor both as defense-in-depth: if Unipile
 * ever flips a tenant to HMAC (or a future source ships with HMAC by
 * default) we accept it without redeploying.
 *
 * CRITICAL — downgrade-attack guard (RESEARCH AntiPattern):
 *   When `X-Unipile-Signature` is PRESENT but does not match, we REJECT
 *   the request hard with `mode:"hmac", ok:false, reason:"hmac_mismatch"`.
 *   We do NOT fall through to the static-header path — that would let an
 *   attacker who learns the static secret bypass HMAC by stripping the
 *   signature header (a downgrade attack).
 *
 * Both branches use `timingSafeEqual` on equal-length sha256-hashed
 * buffers (`createHash("sha256").update(x).digest()`). Hashing both sides
 * to a fixed 32-byte digest before comparison avoids:
 *   (a) `timingSafeEqual`'s throw on different-length buffers (which would
 *       crash the route on a malformed header — e.g. user-typed "wrong")
 *   (b) the length-leak side-channel: comparing length-N vs length-M takes
 *       O(0) time, comparing N==N takes O(N) — disclosing the expected
 *       length to anyone who can measure response time.
 *
 * Mirrors the existing HMAC-+-timingSafeEqual idiom from the generic
 * `app/api/webhook/[name]/route.ts:44-55` verifier.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export type VerifyMode = "hmac" | "static" | "rejected";

export interface VerifyResult {
  mode: VerifyMode;
  ok: boolean;
  reason?: string;
}

export function verifyUnipileWebhook(
  rawBody: string,
  headers: Headers,
  secret: string
): VerifyResult {
  // Path 1: HMAC-SHA256 over the raw body via `X-Unipile-Signature`.
  // Defensive — D-76 says this branch will likely never fire on the
  // current live tenant, but it's cheap insurance against future
  // source-type changes by Unipile.
  // L-04: trim + lowercase the incoming sig so accidental whitespace from
  // an upstream proxy or mixed-case hex from a different SDK don't trigger
  // a false `hmac_mismatch`. Hex is case-insensitive by spec — normalize on
  // ingress before hashing.
  const sig = headers.get("x-unipile-signature")?.trim().toLowerCase();
  if (sig) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const expHash = createHash("sha256").update(expected).digest();
    const sigHash = createHash("sha256").update(sig).digest();
    if (timingSafeEqual(expHash, sigHash)) {
      return { mode: "hmac", ok: true };
    }
    // HMAC header present but mismatched — REJECT HARD.
    // downgrade-attack guard: DO NOT fall through to the static path.
    return { mode: "hmac", ok: false, reason: "hmac_mismatch" };
  }

  // Path 2: static-secret equality on `Unipile-Auth` header.
  // This is the empirical path observed on the live tenant 2026-05-18.
  const authHdr = headers.get("unipile-auth");
  if (authHdr) {
    const a = createHash("sha256").update(secret).digest();
    const b = createHash("sha256").update(authHdr).digest();
    if (timingSafeEqual(a, b)) {
      return { mode: "static", ok: true };
    }
    return { mode: "static", ok: false, reason: "static_mismatch" };
  }

  return { mode: "rejected", ok: false, reason: "no_signature_or_auth_header" };
}
