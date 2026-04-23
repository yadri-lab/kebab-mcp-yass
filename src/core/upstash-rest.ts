/**
 * Phase 53 — thin Upstash REST client for `/info` reads.
 *
 * Used by `/api/admin/metrics/kv-quota` to surface Upstash memory usage
 * (bytes used / limit) on the /config Health dashboard. Upstash REST
 * wraps the Redis INFO command as `GET /info` returning
 * `{ result: "<INFO text>" }`.
 *
 * Contract:
 *   - `getUpstashInfo()` returns `null` when creds are absent (distinct
 *     from the `{ source: "unknown" }` shape which means a request was
 *     made but parsing failed or the network errored).
 *   - 3 second AbortSignal timeout so a stuck Upstash endpoint cannot
 *     hang the admin dashboard poll.
 *   - Error messages are sanitized — the REST token NEVER leaks into
 *     `error` strings, even when the underlying fetch rejection includes it.
 *
 * FACADE-03: reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
 * through `getConfig()`. Route-layer caching (`Cache-Control: private,
 * max-age=30`) lives at the kv-quota route; this module is stateless.
 */

import { getConfig } from "./config-facade";
import { toMsg } from "./error-utils";

const TIMEOUT_MS = 3000;

export interface UpstashInfoResult {
  usedBytes: number | null;
  usedHuman: string | null;
  source: "upstash" | "unknown";
  error?: string;
}

/**
 * Read `used_memory` (exact bytes) and `used_memory_human` (display
 * string) from a Redis INFO text blob. Both are optional — callers
 * that only get one (e.g. old Upstash builds) still see the present
 * field populated.
 */
export function parseUpstashUsedBytes(infoText: string): {
  usedBytes: number | null;
  usedHuman: string | null;
} {
  let usedBytes: number | null = null;
  let usedHuman: string | null = null;

  // INFO uses \r\n by default on Redis; the Upstash REST wrapper echoes
  // the raw text. Also handle \n-only in case an intermediary normalized.
  const lines = infoText.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key === "used_memory") {
      const n = parseInt(val, 10);
      if (Number.isFinite(n)) usedBytes = n;
    } else if (key === "used_memory_human") {
      usedHuman = val || null;
    }
  }
  return { usedBytes, usedHuman };
}

/**
 * Fetch Upstash INFO and return parsed memory usage. Returns `null`
 * when creds are missing (no fetch call). Otherwise always returns a
 * shape — `source: "unknown"` indicates the request happened but
 * parsing / network failed.
 */
export async function getUpstashInfo(): Promise<UpstashInfoResult | null> {
  const url = (getConfig("UPSTASH_REDIS_REST_URL") ?? "").trim();
  const token = (getConfig("UPSTASH_REDIS_REST_TOKEN") ?? "").trim();
  if (!url || !token) return null;

  // Defense-in-depth: if the error message gets serialized (e.g. via
  // toString-a-rejected-promise), strip any accidental token occurrence
  // before returning to the caller.
  const sanitize = (msg: string): string => {
    if (!token) return msg;
    return msg.split(token).join("[redacted]");
  };

  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        usedBytes: null,
        usedHuman: null,
        source: "unknown",
        error: sanitize(`HTTP ${response.status}`),
      };
    }
    const body = (await response.json()) as { result?: string };
    const infoText = typeof body.result === "string" ? body.result : "";
    const { usedBytes, usedHuman } = parseUpstashUsedBytes(infoText);
    return { usedBytes, usedHuman, source: "upstash" };
  } catch (err) {
    return {
      usedBytes: null,
      usedHuman: null,
      source: "unknown",
      error: sanitize(toMsg(err)),
    };
  }
}
