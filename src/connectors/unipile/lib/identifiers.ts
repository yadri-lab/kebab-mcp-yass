/**
 * Phase 68 / Plan 03 / Task 1 — LinkedIn URL -> Unipile URN resolver + KV cache.
 *
 * Three exports:
 *  - `normalizeProfileUrl(url)` — D-12 canonicalization. Accepts 4 URL variants
 *    (bare, https, www, locale-prefix) and lower-cases the slug. Throws on
 *    unsupported formats (Sales Navigator, activity URLs, malformed input).
 *  - `urnCacheKey(normalizedUrl)` — deterministic SHA-256 (truncated 16 hex
 *    chars) for the KV cache key. Exported so the admin DELETE eviction route
 *    can compute the SAME key.
 *  - `resolveProviderId(rawUrl, accountId)` — read-through cache. On HIT,
 *    returns cached URN. On MISS, calls Unipile `users.getProfile` via
 *    `withRetry` and writes the result to KV with a 30-day TTL (D-10).
 *
 * KV layer: `getContextKVStore()` (D-18) — keys are auto-prefixed with the
 *   current tenant id, e.g. `tenant:<id>:unipile:urn:<hash>`. NEVER use raw
 *   `getKVStore()` here — that bypasses tenant isolation and would fail the
 *   `kv-allowlist` contract test.
 *
 * Strict mode on 429 (D-10): when withRetry exhausts retries on a 429, the
 *   error propagates. We do NOT serve stale data. Honest failures over false
 *   confidence — RESEARCH.md Pitfall 7 + the 2026-05-18 Antoine Vercken
 *   incident inform this stance.
 *
 * TTL constant exported so tests can assert the literal value (Pitfall 7:
 *   FilesystemKV ignores TTL — tests must verify the TTL VALUE PASSED to
 *   `kv.set()`, not actual expiry).
 */

import { createHash } from "node:crypto";
import { getContextKVStore } from "@/core/request-context";
import { getUnipileClient } from "./client";
import { withRetry } from "./retry";

/** D-10: cache TTL is 30 days (2,592,000 seconds). Upstash honors EX, Filesystem ignores (dev). */
export const URN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * D-12 supported URL formats:
 *   - https://linkedin.com/in/<slug>
 *   - https://www.linkedin.com/in/<slug>
 *   - https://<locale>.linkedin.com/in/<slug>   (fr, de, es, it, pt, nl, pl, tr, zh, ja, ko, ar, ru)
 *   - linkedin.com/in/<slug>                    (protocol stripped — we add https://)
 *
 * Slug character class: [a-zA-Z0-9_%-]+ (LinkedIn slugs are URL-safe).
 *
 * Phase 69 / D-44 (UNI-25): two trailing non-capturing groups accept an
 *   optional query string (`?…`) and an optional fragment (`#…`) — both
 *   forbidden from containing `/` to keep the slug capture unambiguous. This
 *   fixes the phase-68 backlog item where pasted URLs like
 *   `?originalSubdomain=fr`, `?miniProfileUrn=…`, and `?utm_source=…` were
 *   rejected as malformed. The slug capture group is unchanged so
 *   `normalizeProfileUrl` still strips query + fragment by design.
 *
 * Note on ReDoS (T-68-03-04 + D-44 follow-up): bounded alternation + simple
 *   char classes (`[a-zA-Z0-9\-_%]+`, `[^#/]*`) — no nested quantifiers, no
 *   catastrophic backtracking surface. The two new groups are at the tail
 *   anchored by `$`, so they collapse to a single linear scan.
 */
const SLUG_RE =
  /^(?:https?:\/\/)?(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?(?:\?[^#/]*)?(?:#[^/]*)?$/;

/**
 * D-12 normalization: lowercase slug, strip trailing slash, strip locale
 * prefix, force `https://linkedin.com/in/<slug>` canonical form. Throws on
 * unsupported URL shapes (Sales Navigator, activity URL, etc.) with a
 * message enumerating the accepted formats.
 */
export function normalizeProfileUrl(input: string): string {
  const trimmed = input.trim();
  const m = SLUG_RE.exec(trimmed);
  if (!m || !m[1]) {
    throw new Error(
      `Invalid LinkedIn profile URL: ${input}. Supported formats: https://linkedin.com/in/<slug>, https://www.linkedin.com/in/<slug>, https://<locale>.linkedin.com/in/<slug>.`
    );
  }
  const slug = m[1].toLowerCase();
  return `https://linkedin.com/in/${slug}`;
}

/**
 * SHA-256 of the normalized URL, truncated to 16 hex chars for KV-key
 * brevity. Matches the existing webhook crypto pattern (createHash +
 * slice(0,16)).
 */
function urlHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Compose the KV cache key for a normalized URL. Exported so the admin
 * DELETE eviction route (`app/api/admin/unipile/cache/urn/route.ts`) can
 * compute the SAME key — single source of truth for the hash.
 *
 * Note on tenant prefix: when read/written via `getContextKVStore()`, the
 * wrapper auto-prefixes `tenant:<id>:` — so on-disk the full key is
 * `tenant:<id>:unipile:urn:<hash>` (D-18). The admin DELETE route uses
 * root-scope `getKVStore()` and so wipes only the un-prefixed key (which
 * is the documented escape-hatch behavior — see route file's JSDoc).
 */
export function urnCacheKey(normalizedUrl: string): string {
  return `unipile:urn:${urlHash(normalizedUrl)}`;
}

interface UrnCacheRow {
  urn: string;
  resolved_at: string;
}

/**
 * Resolve a LinkedIn profile URL to a Unipile `provider_id` URN, using a
 * KV-backed cache (30-day TTL, D-10).
 *
 * Returns `{ provider_id, from_cache }`. On cache HIT, no SDK call is made.
 * On cache MISS, calls `getUnipileClient().users.getProfile({ account_id,
 * identifier: slug })` wrapped in `withRetry`, then writes the row to KV
 * with a 30-day TTL.
 *
 * Errors propagate as-is. On Unipile 429 (after withRetry exhausts), the
 * `UnsuccessfulRequestError` reaches the caller — D-10 strict mode forbids
 * stale-while-revalidate.
 */
export async function resolveProviderId(
  rawUrl: string,
  accountId: string
): Promise<{ provider_id: string; from_cache: boolean }> {
  const normalized = normalizeProfileUrl(rawUrl);
  const kv = getContextKVStore();
  const key = urnCacheKey(normalized);

  const cached = await kv.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as UrnCacheRow;
      if (parsed && typeof parsed.urn === "string" && parsed.urn.length > 0) {
        return { provider_id: parsed.urn, from_cache: true };
      }
      // Otherwise: corrupt or empty cache row -> fall through to fresh resolve.
    } catch {
      // Corrupt cache JSON -> fall through to fresh resolve.
    }
  }

  // SLUG_RE guarantees this strip yields a non-empty identifier (matched group).
  const slug = normalized.slice("https://linkedin.com/in/".length);
  const client = getUnipileClient();
  const profile = await withRetry(() =>
    client.users.getProfile({ account_id: accountId, identifier: slug })
  );
  const providerId = (profile as { provider_id?: unknown }).provider_id;
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error(
      `Unipile getProfile did not return a provider_id for ${normalized}; got ${JSON.stringify(
        profile
      )}`
    );
  }

  const row: UrnCacheRow = {
    urn: providerId,
    resolved_at: new Date().toISOString(),
  };
  await kv.set(key, JSON.stringify(row), URN_TTL_SECONDS);
  return { provider_id: providerId, from_cache: false };
}
