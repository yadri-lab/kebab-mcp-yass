/**
 * Custom Tools — `/test` endpoint rate limiter.
 *
 * Phase 2: an admin can hammer `/api/admin/custom-tools/[id]/test` in
 * a tight loop, and each run can invoke up to 32 LLM-backed steps
 * (web_agent, paywall_read, etc). Without a guardrail a careless
 * "Run test" button click in a debugger can cost real money in
 * minutes.
 *
 * We delegate to the existing `checkRateLimit` from `src/core/rate-limit.ts`
 * — it already handles Upstash atomic incr, filesystem fallback,
 * tenant scoping, in-memory test path, and the "fail open on KV
 * error" policy. We just pick a scope (`customtool-test`) and a
 * limit (10 per minute per admin token) so the bucket key shape
 * stays consistent with the rest of the app:
 *
 *   ratelimit:customtool-test:<idHash>:<minuteBucket>
 *
 * The TEST endpoint has its OWN limiter (always on), independent of
 * the project-wide opt-in flag for the pipeline limiter on MCP
 * transport. Admin write/test operations are always quota-bounded
 * regardless of that flag.
 */

import { checkRateLimit, type RateLimitResult } from "@/core/rate-limit";

/** Default: 10 runs per minute per admin tokenId. */
const TEST_RUNS_PER_MINUTE = 10;

const SCOPE = "customtool-test";

export interface CustomToolTestRateLimitDecision {
  allowed: boolean;
  /** Seconds the caller must wait before retrying. 0 when allowed. */
  retryAfterSeconds: number;
  /** How many runs remain in the current bucket. -1 if KV failed open. */
  remaining: number;
}

/**
 * Check whether this admin tokenId may invoke `/test` right now.
 *
 * `tokenId` should be `ctx.tokenId` from the pipeline (it's the
 * sha256-first-8 of the admin token; see auth-step.ts). When the
 * pipeline didn't surface a tokenId (anonymous probe), pass
 * "anonymous" — those callers fall under a single shared bucket
 * by design.
 */
export async function checkTestRunRateLimit(
  tokenId: string | null
): Promise<CustomToolTestRateLimitDecision> {
  const id = tokenId ?? "anonymous";
  const result: RateLimitResult = await checkRateLimit(id, {
    scope: SCOPE,
    limit: TEST_RUNS_PER_MINUTE,
  });
  if (result.allowed) {
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: result.remaining,
    };
  }
  // Round up so a 0.4-second wait is reported as 1, never as 0.
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return {
    allowed: false,
    retryAfterSeconds: retryAfter,
    remaining: 0,
  };
}

/** Test-only: surface the configured limit so unit tests can assert it. */
export const _TEST_RUNS_PER_MINUTE_FOR_TESTS = TEST_RUNS_PER_MINUTE;
export const _SCOPE_FOR_TESTS = SCOPE;
