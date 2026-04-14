import { createHash } from "node:crypto";
import { getKVStore } from "./kv-store";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // unix ms
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Sliding-window (fixed per-minute bucket) rate limiter.
 *
 * KV key: `ratelimit:{scope}:{identifierHash}:{minuteBucket}`
 * Default limit controlled by MYMCP_RATE_LIMIT_RPM env var (default 60).
 * KV failures are treated as allow (fail open).
 *
 * Use `scope` to partition limits — e.g. "mcp" for the tool endpoint vs
 * "setup" for the first-run credential tester, which should have much
 * tighter budgets.
 *
 * **Concurrency note.** The `get` → `set` sequence is not atomic; two
 * concurrent requests reading `count=N` can both write `N+1` and both
 * be allowed. For the purposes of this limiter (abuse protection, not
 * billing) the imprecision is acceptable — the observed cap under
 * contention is `limit × concurrent_callers` per window, which is
 * still bounded. Upstream `INCR` would fix this atomically; we defer
 * that to a future enhancement that touches the KVStore interface.
 *
 * **Key cleanup.** Each write also runs a best-effort sweep of stale
 * buckets for the same scope+id so the KV store doesn't grow unbounded
 * on long-running instances. Sweep runs at most every N minutes per
 * caller to bound its own cost.
 */
export async function checkRateLimit(
  identifier: string,
  options: { scope?: string; limit?: number } = {}
): Promise<RateLimitResult> {
  const scope = options.scope || "mcp";
  const defaultLimit = Math.max(1, parseInt(process.env.MYMCP_RATE_LIMIT_RPM ?? "60", 10) || 60);
  const limit = options.limit ?? defaultLimit;
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const resetAt = (minuteBucket + 1) * 60_000;
  const idHash = hashToken(identifier);
  const key = `ratelimit:${scope}:${idHash}:${minuteBucket}`;

  const kv = getKVStore();

  try {
    const raw = await kv.get(key);
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= limit) {
      return { allowed: false, remaining: 0, resetAt };
    }

    await kv.set(key, String(count + 1));

    // Fire-and-forget sweep of older buckets for the same scope+id. Only
    // runs on first request of each new bucket window (i.e. once per
    // minute per caller) to keep the cost bounded.
    if (count === 0) {
      void sweepOldBuckets(scope, idHash, minuteBucket);
    }

    return { allowed: true, remaining: limit - count - 1, resetAt };
  } catch (err) {
    // Fail open: KV errors must not block legitimate requests
    console.warn(
      "[MyMCP] Rate limit KV error (failing open):",
      err instanceof Error ? err.message : String(err)
    );
    return { allowed: true, remaining: -1, resetAt };
  }
}

/**
 * Best-effort bucket cleanup. Lists keys under the scope+id prefix and
 * deletes anything older than the current minute. Failures are swallowed.
 */
async function sweepOldBuckets(
  scope: string,
  idHash: string,
  currentBucket: number
): Promise<void> {
  try {
    const kv = getKVStore();
    const prefix = `ratelimit:${scope}:${idHash}:`;
    const keys = await kv.list(prefix);
    for (const key of keys) {
      const bucketStr = key.slice(prefix.length);
      const bucket = parseInt(bucketStr, 10);
      if (Number.isFinite(bucket) && bucket < currentBucket) {
        await kv.delete(key);
      }
    }
  } catch {
    // ignore — cleanup is best-effort
  }
}
