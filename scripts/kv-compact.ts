/**
 * KV compaction script — removes stale entries from the KV store.
 *
 * Targets:
 * - `ratelimit:*` keys with expired minute-window buckets
 * - `health:sample:*` keys older than the retention window
 * - Any keys with empty string values
 *
 * Run: npx tsx scripts/kv-compact.ts
 *     or: npm run kv:compact
 */

import { getKVStore, kvScanAll } from "../src/core/kv-store";

const HEALTH_RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.MYMCP_HEALTH_SAMPLE_RETENTION_DAYS ?? "7", 10) || 7
);

async function main() {
  const kv = getKVStore();
  const allKeys = await kvScanAll(kv, "*");
  const now = Date.now();
  const currentMinuteBucket = Math.floor(now / 60_000);
  const healthCutoff = now - HEALTH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let deleted = 0;
  const reasons: Record<string, number> = {
    "expired-ratelimit": 0,
    "expired-health-sample": 0,
    "empty-value": 0,
  };

  for (const key of allKeys) {
    let shouldDelete = false;
    let reason = "";

    // Check for empty values
    const value = await kv.get(key);
    if (value === "" || value === null) {
      shouldDelete = true;
      reason = "empty-value";
    }

    // Check expired rate limit buckets
    // Key format: ratelimit:<tenantId>:<scope>:<idHash>:<minuteBucket>
    // or legacy: ratelimit:<scope>:<idHash>:<minuteBucket>
    if (!shouldDelete && key.startsWith("ratelimit:")) {
      const parts = key.split(":");
      const bucketStr = parts[parts.length - 1] ?? "";
      const bucket = parseInt(bucketStr, 10);
      if (Number.isFinite(bucket) && bucket < currentMinuteBucket) {
        shouldDelete = true;
        reason = "expired-ratelimit";
      }
    }

    // Check expired health samples
    // Key format: health:sample:<timestamp> or health:sample:<connector>:<timestamp>
    if (!shouldDelete && key.startsWith("health:sample:")) {
      // Try to parse the stored value for a timestamp
      if (value) {
        try {
          const parsed = JSON.parse(value);
          const sampleTime = parsed.timestamp
            ? new Date(parsed.timestamp).getTime()
            : parsed.checkedAt
              ? new Date(parsed.checkedAt).getTime()
              : 0;
          if (sampleTime > 0 && sampleTime < healthCutoff) {
            shouldDelete = true;
            reason = "expired-health-sample";
          }
        } catch {
          // If we can't parse, try extracting timestamp from key
          const parts = key.split(":");
          const lastPart = parts[parts.length - 1] ?? "";
          const ts = parseInt(lastPart, 10);
          if (Number.isFinite(ts) && ts > 0 && ts < healthCutoff) {
            shouldDelete = true;
            reason = "expired-health-sample";
          }
        }
      }
    }

    if (shouldDelete) {
      await kv.delete(key);
      deleted++;
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }

  const remaining = allKeys.length - deleted;
  console.log(`[KV Compact] Deleted ${deleted} stale entries, ${remaining} remaining`);
  for (const [reason, count] of Object.entries(reasons)) {
    if (count > 0) {
      console.log(`  - ${reason}: ${count}`);
    }
  }
}

main().catch((err) => {
  console.error("[KV Compact] Fatal error:", err);
  process.exit(1);
});
