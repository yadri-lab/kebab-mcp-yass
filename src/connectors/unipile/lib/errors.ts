/**
 * Phase 68 / Plan 02 / Task 3 — Unipile typed error taxonomy + classifier.
 *
 * Two surfaces:
 *  1. Four typed McpToolError subclasses for handlers to throw with
 *     proper retryable flag + LLM-safe recovery hints (mirrors the
 *     Google/Vault classes in src/core/connector-errors.ts; lives in the
 *     connector tree to keep core untouched per PATTERNS.md guidance).
 *  2. classifyUnipileError(err) — pure function mapping SDK errors to the
 *     audit `result` enum used by the audit log (Plan 04). The success +
 *     unverified_timeout values are handled by callers, NOT here — this
 *     classifier only covers the 4 error variants.
 *
 * Status → enum mapping (D-15 + RESEARCH.md §Code Examples):
 *   429                         → error_rate_limit
 *   422 with type "cannot_resend*" → error_rate_limit (LinkedIn-side cap)
 *   401 / 403                   → error_account_restricted
 *   404                         → error_not_connected
 *   >=500                       → error_unipile_5xx
 *   anything else / non-SDK     → error_unipile_5xx (fail-safe default,
 *                                 per RESEARCH §Pitfall 4 + Assumption A2)
 *
 * Note on ErrorCode aliasing: the plan sketch referenced ErrorCode.AUTH /
 * ErrorCode.UPSTREAM, but src/core/errors.ts exposes AUTH_FAILED /
 * EXTERNAL_API_ERROR — we use the actual exported names. The plan
 * explicitly authorized this adaptation in <action> rather than expanding
 * the enum in core.
 */

import { UnsuccessfulRequestError } from "unipile-node-sdk";
import { McpToolError, ErrorCode } from "@/core/errors";

export class UnipileRateLimitError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.RATE_LIMITED,
      toolName: "unipile",
      message,
      userMessage: "Unipile rate limit reached. Please try again in a moment.",
      retryable: true,
      cause: opts?.cause,
      recovery:
        "Wait 30-60 seconds before retrying. LinkedIn enforces 80-100 connects/day on paid accounts.",
      internalRecovery:
        "Check UNIPILE_TOKEN quota in Unipile dashboard; consider per-account rate limiter (phase 69 UNI-11).",
    });
    this.name = "UnipileRateLimitError";
  }
}

export class UnipileAccountRestrictedError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.AUTH_FAILED,
      toolName: "unipile",
      message,
      userMessage:
        "Unipile LinkedIn account is restricted or unauthenticated. Reconnect in /config.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Reconnect the LinkedIn account in the Unipile dashboard.",
      internalRecovery:
        "Check UNIPILE_TOKEN env var and account.getAll() returns the LinkedIn account with status OK.",
    });
    this.name = "UnipileAccountRestrictedError";
  }
}

export class UnipileNotConnectedError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.NOT_FOUND,
      toolName: "unipile",
      message,
      userMessage: "Profile not found or unreachable from this LinkedIn account's network.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Verify the LinkedIn profile URL is public and not blocked by privacy settings.",
    });
    this.name = "UnipileNotConnectedError";
  }
}

export class Unipile5xxError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "unipile",
      message,
      userMessage: "Unipile API is unavailable. Please try again in a few minutes.",
      retryable: true,
      cause: opts?.cause,
      recovery: "Wait a few minutes and retry. Check Unipile status page for outages.",
    });
    this.name = "Unipile5xxError";
  }
}

/**
 * Phase 69 / Plan 01 — NEW error subclasses (D-23, D-26, D-29, D-45).
 *
 * Each subclass mirrors the phase-68 shape (extends McpToolError, sets
 * `this.name` after super) so caller-side `instanceof` checks and
 * audit-log classifiers stay consistent.
 */

/** D-26: caller did not set `allow_inmail: true` on linkedin_send_inmail (operator-side gate). */
export class UnipileInmailNotAuthorizedError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.INVALID_INPUT,
      toolName: "unipile",
      message,
      userMessage: "InMail not authorized — set allow_inmail: true to confirm credit usage.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Re-call the tool with allow_inmail: true if you want to spend an InMail credit.",
    });
    this.name = "UnipileInmailNotAuthorizedError";
  }
}

/** D-29: account lacks Premium / Sales Nav / Recruiter — no InMail credits available. */
export class UnipileInmailRequiresPremiumError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.AUTH_FAILED,
      toolName: "unipile",
      message,
      userMessage:
        "This LinkedIn account does not have InMail credits. Upgrade to Premium, Sales Navigator, or Recruiter.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Use linkedin_send_connection (free) or upgrade the LinkedIn account.",
    });
    this.name = "UnipileInmailRequiresPremiumError";
  }
}

/** D-45 (UNI-26): 422 invalid_recipient — recipient out-of-network / deleted / privacy-blocked. */
export class UnipileRecipientUnreachableError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.NOT_FOUND,
      toolName: "unipile",
      message,
      userMessage:
        "Recipient is not reachable from this LinkedIn account (out of network, deleted, or privacy-blocked).",
      retryable: false,
      cause: opts?.cause,
      recovery: "Verify the profile URL or try a different account that may be connected.",
    });
    this.name = "UnipileRecipientUnreachableError";
  }
}

/** D-45 (UNI-26): 400 invalid_parameters — request to LinkedIn was malformed. */
export class UnipileInvalidRequestError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.INVALID_INPUT,
      toolName: "unipile",
      message,
      userMessage: "Request to LinkedIn was malformed (invalid parameters).",
      retryable: false,
      cause: opts?.cause,
      recovery:
        "Check the profile URL format, note length (≤300 chars), and attachment count (≤5).",
    });
    this.name = "UnipileInvalidRequestError";
  }
}

/** D-23: attachment size exceeds the LinkedIn 15 MB hard limit. */
export class UnipileAttachmentTooLargeError extends McpToolError {
  constructor(message: string, sizeBytes: number) {
    super({
      code: ErrorCode.INVALID_INPUT,
      toolName: "unipile",
      message: `${message} (size: ${sizeBytes} bytes, limit: 15728640)`,
      userMessage: "Attachment exceeds the 15 MB LinkedIn limit.",
      retryable: false,
      recovery: "Compress the file or remove it.",
    });
    this.name = "UnipileAttachmentTooLargeError";
  }
}

export type UnipileErrorResult =
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  | "error_recipient_unreachable" // NEW D-45 (UNI-26)
  | "error_invalid_request" // NEW D-45 (UNI-26)
  | "error_inmail_requires_premium"; // NEW D-29

/**
 * Maps an arbitrary thrown value (typically from the Unipile SDK) onto the
 * audit `result` enum consumed by Plan 04's audit log writer.
 *
 * Runtime guard required because UnsuccessfulRequestError.body is typed as
 * `unknown` in the SDK and response shapes drift across endpoints (per
 * RESEARCH §Pitfall 4). Defaults to `error_unipile_5xx` on any unparseable
 * input — a loud "unknown upstream failure" is safer than a silent success
 * or a misleading "not_connected" (per RESEARCH §Assumption A2).
 */
export function classifyUnipileError(err: unknown): UnipileErrorResult {
  if (!(err instanceof UnsuccessfulRequestError)) return "error_unipile_5xx";
  const body = (err.body ?? {}) as { status?: unknown; type?: unknown };
  const status = typeof body.status === "number" ? body.status : 0;
  const type = typeof body.type === "string" ? body.type : "";

  if (status === 429) return "error_rate_limit";
  if (status === 422 && type.includes("cannot_resend")) return "error_rate_limit"; // LinkedIn-side cap
  // Phase 69 / D-45 (UNI-26) — specific 422 variants BEFORE the generic fall-through.
  if (status === 422 && type.includes("invalid_recipient")) return "error_recipient_unreachable";
  if (status === 422 && type.includes("inmail_requires_premium"))
    return "error_inmail_requires_premium"; // D-29
  // Phase 69 / D-45 (UNI-26) — distinct 400 mapping (was previously falling through to 5xx).
  if (status === 400 && type.includes("invalid_parameters")) return "error_invalid_request";
  if (status === 401 || status === 403) {
    // Phase 69 / D-29 — 403/401 with explicit inmail premium hint maps to the premium error,
    // NOT the generic account-restricted bucket (the operator needs to upgrade, not reconnect).
    if (type.includes("inmail_requires_premium")) return "error_inmail_requires_premium";
    return "error_account_restricted";
  }
  if (status === 404) return "error_not_connected";
  if (status >= 500) return "error_unipile_5xx";
  return "error_unipile_5xx";
}
