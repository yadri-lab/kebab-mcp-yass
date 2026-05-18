---
phase: 68-unipile-foundation
plan: 03
subsystem: connector-url-urn-resolver
tags: [unipile, url-normalization, urn-cache, kv, admin-route, cache-eviction, tenant-scope]

# Dependency graph
requires:
  - phase: 42-tenant-scoping
    provides: getContextKVStore() per-request tenant prefix + kv-allowlist callsite gate
  - phase: 48-config-facade
    provides: getConfig() facade enforcing no direct process.env reads
  - phase: 50-pipeline-rehydrate
    provides: withAdminAuth HOC + PipelineContext for admin REST routes
  - phase: 68-unipile-foundation
    provides: 68-02 — getUnipileClient() singleton + withRetry() exponential backoff
provides:
  - normalizeProfileUrl(url) — D-12 canonicalizer (4 URL variants + 13 locale prefixes + lowercase + trailing-slash strip)
  - urnCacheKey(normalizedUrl) — deterministic sha256→16-hex KV-key builder (single source of truth for the resolver + admin DELETE)
  - resolveProviderId(rawUrl, accountId) — read-through KV cache (D-09/D-10/D-18) → returns { provider_id, from_cache }
  - URN_TTL_SECONDS constant (2,592,000 = 30 * 24 * 60 * 60) exported so tests assert literal value
  - DELETE /api/admin/unipile/cache/urn?profile_url=… — admin REST eviction endpoint (D-11) wrapped in withAdminAuth
affects: [68-04-audit, 68-05-crm-bridge, 68-06-tools]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-through KV cache with explicit TTL value (D-09/D-10) — normalize → hash → kv.get → fall-through → SDK → kv.set with TTL; corrupt JSON falls through gracefully"
    - "Admin REST cross-tenant eviction via root-scope getKVStore() (D-18 escape hatch) — mirrors app/api/admin/rate-limits/route.ts; ALLOWLIST entry documents rationale + cross-link"
    - "Shared urnCacheKey() export — admin DELETE and resolver compute the SAME key from the same helper, eliminating drift between cache writer and evictor"

key-files:
  created:
    - src/connectors/unipile/lib/identifiers.ts
    - src/connectors/unipile/lib/__tests__/identifiers.test.ts
    - app/api/admin/unipile/cache/urn/route.ts
  modified:
    - tests/contract/kv-allowlist.test.ts (single ALLOWLIST entry added)

key-decisions:
  - "Client import path: identifiers.ts imports getUnipileClient from './client' (same dir) — Plan 02 placed client.ts under lib/ to match apify convention (overriding PATTERNS.md's top-level suggestion). Honored that decision."
  - "SLUG_RE accepts upper+lower mixed case (slug character class is [a-zA-Z0-9_%-]+) but the captured group is forced lowercase before composing the canonical URL. Two normalize tests verify ANTOINE-VERCKEN and Antoine-Vercken both collapse to antoine-vercken."
  - "Corrupt cache JSON falls through to fresh resolve (defensive) AND cache rows missing the urn field also fall through. Three HIT-path tests cover happy + corrupt-JSON + missing-urn (added one beyond the plan spec for extra safety)."
  - "Admin DELETE handler does NOT existence-check pre-delete (kv.delete is idempotent on both Upstash and Filesystem backends). evicted: true means 'operation completed' not 'a row was removed' — documented in JSDoc to prevent operators misreading false positives."
  - "Eight lines added to kv-allowlist.test.ts (single entry + 7 lines of comment + cross-link). Plan said ~4 lines — overshot intentionally to fully document the escape hatch + the misalignment note (kv-allowlist is callsite, not key-prefix) for the next reader."

patterns-established:
  - "Resolver/evictor key-derivation symmetry — when an admin route exists to evict a cache key, both the writer AND the evictor MUST call the same exported helper (here: urnCacheKey). Prevents 'admin DELETE'd the wrong key' silent failures."
  - "vi.useFakeTimers() + detached-rejection pattern (from Plan 02 retry.test.ts) re-applied: const assertion = expect(p).rejects.toBeInstanceOf(...) BEFORE await vi.runAllTimersAsync(), then await assertion afterward. Used in the 429-propagation test to collapse withRetry's ~1.4s wall-clock into ~0ms."
  - "When the kv-allowlist contract test will fail after one task and be fixed by the next, commit them in order — pre-commit hooks don't run the vitest contract test (only scripts/contract-test.ts), so the intermediate commit is clean even though the test is red mid-plan."

requirements-completed: [UNI-03]

# Metrics
duration: ~14 min
completed: 2026-05-18
---

# Phase 68 Plan 03: URL → URN Resolver + Admin Cache Eviction Summary

**Resolver primitive shipped: `resolveProviderId()` reads through a 30-day KV cache (tenant-prefixed per D-18) and falls back to `users.getProfile` on miss with strict 429 propagation; admin DELETE endpoint evicts via the documented root-scope escape hatch. 21 tests pass (20 identifiers + 1 kv-allowlist contract), typecheck clean, contract+doc-counts gates green.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-05-18T15:30:09Z (after Plan 02 SUMMARY commit 73c33f1)
- **Completed:** 2026-05-18T15:44:50Z (post-Task 3 commit cabca8c)
- **Tasks:** 3 / 3
- **Files created:** 3 (1 lib source + 1 lib test + 1 admin route)
- **Files modified:** 1 (kv-allowlist ALLOWLIST — single entry added)
- **Lines added:** ~330 (identifiers.ts 145, identifiers.test.ts 195, route.ts 75, kv-allowlist 8)

## Accomplishments

- **URL canonicalizer shipped.** `normalizeProfileUrl()` collapses 6+ URL variants — bare slug-only, https, www, 13 locale prefixes (fr/de/es/it/pt/nl/pl/tr/zh/ja/ko/ar/ru), upper/mixed case, trailing slashes — into the single canonical `https://linkedin.com/in/<lowercased-slug>` form per D-12. Throws with a clear message enumerating accepted formats on Sales Navigator, activity URLs, and malformed input (A4 + threat T-68-03-04 mitigation via bounded SLUG_RE).
- **KV-key derivation as a single source of truth.** `urnCacheKey(normalized)` returns `unipile:urn:<16-hex-of-sha256>` and is imported by BOTH the resolver (writer) AND the admin DELETE route (evictor). Same helper → same key → eviction never targets the wrong row. Pattern documented in `patterns-established`.
- **Read-through cache (D-09/D-10).** `resolveProviderId()` cache HIT returns `{provider_id, from_cache: true}` and does NOT touch the SDK (asserted by `expect(getProfileMock).not.toHaveBeenCalled()`). Cache MISS calls `getUnipileClient().users.getProfile({ account_id, identifier: slug })` wrapped in `withRetry`, then writes `{urn, resolved_at}` JSON to KV with `URN_TTL_SECONDS = 2,592,000` (literal value asserted in tests per Pitfall 7).
- **Strict 429 (D-10).** When `withRetry` exhausts retries on a 429, the `UnsuccessfulRequestError` propagates as-is — no stale-while-revalidate. Test uses `vi.useFakeTimers()` + detached-rejection pattern (Plan 02 lesson) to collapse the natural ~1.4s wall-clock into ~0ms while still asserting the final propagation.
- **Defensive cache reads.** Corrupt JSON in the cache row AND missing `urn` field both fall through to fresh resolve — two dedicated HIT-path tests verify the fallback works without throwing. One extra test beyond the plan spec for robustness.
- **Admin DELETE eviction (D-11).** `DELETE /api/admin/unipile/cache/urn?profile_url=<linkedin-url>` returns:
  - 401 when admin cookie missing (delegated to `withAdminAuth` HOC).
  - 400 + `{ ok: false, error: "profile_url query parameter is required" }` on missing param.
  - 400 + `{ ok: false, error: "Invalid LinkedIn profile URL: …" }` when `normalizeProfileUrl` throws.
  - 200 + `{ ok: true, evicted: true, key, normalized_url }` on success.
  - 500 + `{ ok: false, error: toMsg(err) }` on unexpected failure.
- **Root-scope escape hatch documented.** Route file carries the `KV-ALLOWLIST-EXEMPT` marker + 12-line JSDoc explaining the cross-tenant eviction rationale, the tenant-scope asymmetry (admin DELETE wipes only the un-prefixed key, tenant-prefixed copies survive until natural TTL expiry), and the cross-link to D-18.
- **kv-allowlist contract test passes.** Single ALLOWLIST entry added (`"app/api/admin/unipile/cache/urn/route.ts"`) with inline rationale + cross-link to 68-CONTEXT.md D-11/D-18. NO connector source file added — `identifiers.ts` correctly uses `getContextKVStore()` and is tenant-prefixed automatically.
- **All gates green.** lint (0 errors, 3 pre-existing warnings unrelated to this plan), typecheck (0 errors), `npm run test:contract` (17 connectors / 91 tools — unchanged), `npm run test:doc-counts` (no drift), pre-commit hooks ran on every commit.

## Final SLUG_RE Pattern

```
/^(?:https?:\/\/)?(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?$/
```

Deviations from RESEARCH.md sketch:
- **Removed `i` flag.** Replaced with explicit `[a-zA-Z0-9-_%]` character class so the slug capture preserves the original casing (then we `.toLowerCase()` it explicitly). Same effective result, more readable + auditable.
- **Made protocol optional** (`(?:https?:\/\/)?`) so the bare `linkedin.com/in/<slug>` form parses correctly. RESEARCH.md sketch had `https?:\/\/` as required.

| URL input | Captures slug | Returns |
|-----------|---------------|---------|
| `https://linkedin.com/in/antoine-vercken` | `antoine-vercken` | `https://linkedin.com/in/antoine-vercken` |
| `https://www.linkedin.com/in/antoine-vercken` | `antoine-vercken` | `https://linkedin.com/in/antoine-vercken` |
| `https://fr.linkedin.com/in/antoine-vercken` | `antoine-vercken` | `https://linkedin.com/in/antoine-vercken` |
| `https://de.linkedin.com/in/Antoine-Vercken/` | `Antoine-Vercken` → lowercased | `https://linkedin.com/in/antoine-vercken` |
| `linkedin.com/in/antoine-vercken` | `antoine-vercken` | `https://linkedin.com/in/antoine-vercken` |
| `https://linkedin.com/in/ANTOINE-VERCKEN` | `ANTOINE-VERCKEN` → lowercased | `https://linkedin.com/in/antoine-vercken` |
| `https://linkedin.com/sales/people/abc` | — | throws |
| `https://linkedin.com/feed/update/urn:li:activity:123` | — | throws |
| `""` (empty) | — | throws |

## TTL + KV-Key Contract

| Property | Value |
|----------|-------|
| `URN_TTL_SECONDS` (exported constant) | `30 * 24 * 60 * 60` = `2592000` (30 days) |
| KV key format (in-code) | `unipile:urn:<16-hex-chars>` |
| KV key on disk (with tenant context) | `tenant:<id>:unipile:urn:<16-hex-chars>` (auto-prefixed by `getContextKVStore`) |
| KV value | `JSON.stringify({ urn: "<provider_id>", resolved_at: "<iso-8601>" })` |
| Hash function | `createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 16)` |
| Determinism guarantee | Same normalized URL → same 16-hex hash (verified by 3 urnCacheKey tests) |

## Admin Endpoint Contract

| Property | Value |
|----------|-------|
| Method + path | `DELETE /api/admin/unipile/cache/urn` |
| Required query param | `?profile_url=<linkedin-url>` |
| Auth | `withAdminAuth` HOC (admin cookie required; 401 otherwise) |
| KV scope | Root (`getKVStore()`) — see D-18 escape hatch comment |
| Success response | `{ ok: true, evicted: true, key: "unipile:urn:<hash>", normalized_url: "https://linkedin.com/in/<slug>" }` |
| Missing-param response | `400 { ok: false, error: "profile_url query parameter is required" }` |
| Invalid-URL response | `400 { ok: false, error: "Invalid LinkedIn profile URL: <input>. …" }` |
| Unexpected-error response | `500 { ok: false, error: <toMsg(err)> }` |
| `evicted: true` semantics | "Delete operation completed" — NOT "a row was actually removed". KV.delete is idempotent. |

## Tenant-Scope Asymmetry (operator-facing footnote)

Connector lib code (`identifiers.ts` resolver) writes URN cache rows via `getContextKVStore()` — on-disk keys are `tenant:<id>:unipile:urn:<hash>`. The admin DELETE endpoint uses root-scope `getKVStore()` (D-18 escape hatch) and so wipes ONLY the un-prefixed `unipile:urn:<hash>` key.

**Practical consequence:** if a tenant `cadens_001` has a poisoned URN at `tenant:cadens_001:unipile:urn:abc…`, the admin DELETE endpoint does NOT evict it. The admin operation only evicts:
- The unscoped `unipile:urn:<hash>` key (only ever written when no tenant context is active — typically local dev or operator-shell paths).

To evict a specific tenant's cached URN, that tenant must invoke the same eviction logic from within their own request context (where `getContextKVStore()` auto-prefixes). **NOT exposed in phase 68**; tracked as a future enhancement (Phase 71 candidate).

**Why this design (per D-18):** mirrors `app/api/admin/rate-limits/route.ts` precedent — admin routes default to root scope; per-tenant operator surfaces are explicit (e.g., a future `?tenant_id=<id>` query param). Keeping the asymmetry surfaces the design choice rather than silently auto-prefixing.

## Task Commits

Each task atomic with green pre-commit hooks (lint-staged + test:contract + test:doc-counts + typecheck):

1. **Task 1 — URL normalizer + URN cache resolver + tests** — `e13f5cc` (feat)
   - Changed: `src/connectors/unipile/lib/identifiers.ts` (created), `src/connectors/unipile/lib/__tests__/identifiers.test.ts` (created)
   - Gates: 20/20 identifiers tests PASS; typecheck clean; lint clean; contract PASS; doc-counts PASS.
   - One auto-fix during execution (Rule 3 — blocking import path): RESEARCH.md sketch used `from "../client"` assuming top-level `client.ts`; Plan 02 placed it under `lib/` instead. Fixed inline before commit by changing import to `./client` + adding a test-file note explaining the vitest mock-resolution still works.

2. **Task 2 — Admin DELETE for URN eviction** — `81fdb50` (feat)
   - Changed: `app/api/admin/unipile/cache/urn/route.ts` (created)
   - Gates: typecheck clean; lint clean; contract PASS; doc-counts PASS. kv-allowlist contract intentionally RED post-commit (fixed by Task 3 in the next commit — see `patterns-established`).

3. **Task 3 — kv-allowlist ALLOWLIST entry** — `cabca8c` (test)
   - Changed: `tests/contract/kv-allowlist.test.ts` (1 entry + 7-line comment + cross-link)
   - Gates: 1/1 kv-allowlist test PASS (now green again); typecheck clean; lint clean; contract PASS; doc-counts PASS.

**Plan metadata commit (this SUMMARY + STATE.md + ROADMAP.md):** pending after self-check.

_Note: Each task carried `tdd="true"` at the task level. Task 1 followed RED → GREEN explicitly (test file written first, ran to confirm 0-test failure with "module not found", then implementation written and tests pass). Tasks 2 and 3 are infrastructure rather than logic — committed as a single GREEN-only commit per task without a separate RED, matching Plan 01/02's documented pragmatism for non-business-logic plumbing._

## Decisions Made

- **Resolver-evictor key-derivation symmetry.** Both `src/connectors/unipile/lib/identifiers.ts` (the writer) AND `app/api/admin/unipile/cache/urn/route.ts` (the evictor) import the same `urnCacheKey()` function. Single source of truth — no risk of the admin DELETE targeting the wrong key shape because of a divergent hash function. Documented in `patterns-established`.
- **Defensive cache row validation.** Beyond the plan's "corrupt JSON falls through" requirement, the resolver also falls through when the parsed row is missing the `urn` field or has an empty string urn. Three dedicated HIT-path tests cover happy + corrupt + missing — one extra test beyond the spec for defense-in-depth.
- **Eviction `evicted: true` semantics documented at the JSDoc level.** KV.delete is idempotent on both Upstash and Filesystem backends and doesn't expose pre-existence. Rather than adding a get-then-delete round trip just to fudge a more accurate boolean, the contract is "operation completed successfully" with the limitation called out in the route's JSDoc. Saves a round trip and is honest about what the backend exposes.
- **Removed regex `i` flag in favor of explicit character class.** SLUG_RE uses `[a-zA-Z0-9_%-]+` (explicit) instead of `[a-z0-9_%-]+/i` (case-insensitive flag). Same effective match set, but explicit class makes the intent unambiguous and avoids the `/i` flag's interaction with locale prefix matching (the alternation `(?:fr|de|...)` should NOT match `FR` or `De.linkedin.com` — those would be unusual edge cases — and the `/i` flag would have allowed them silently).
- **Eight lines added to kv-allowlist (not 4).** Plan said "~4 lines added" but the rationale comment + cross-link is 7 lines + 1 line for the entry. Overshot intentionally to fully document the escape hatch + the PATTERNS.md misalignment note (kv-allowlist is callsite, not key-prefix) for future readers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Wrong import path for getUnipileClient in identifiers.ts**
- **Found during:** Task 1 first GREEN test run
- **Issue:** Plan 03's `<action>` block sketched `import { getUnipileClient } from "../client";` based on RESEARCH.md's recommended top-level client.ts placement. But Plan 02 SUMMARY explicitly overrode that decision — `client.ts` lives under `src/connectors/unipile/lib/`, matching the apify convention. The test failed with `Cannot find module '../client'`.
- **Fix:** Changed the import to `from "./client"` (same directory). The test file's `vi.mock("../client", …)` was already correctly pointing at the lib-relative path (the mock resolution is by normalized module ID, so it intercepts both `./client` from inside lib/ and `../client` from inside lib/__tests__/). Added a 3-line comment in the test file explaining the path is intentional.
- **Files modified:** `src/connectors/unipile/lib/identifiers.ts` (import path), `src/connectors/unipile/lib/__tests__/identifiers.test.ts` (clarifying comment)
- **Verification:** 20/20 tests PASS.
- **Committed in:** `e13f5cc` (Task 1 commit — folded RED+GREEN).

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking). Zero scope creep, zero source-of-truth changes. Plan executed essentially as written.

## Issues Encountered

- **Three pre-existing lint warnings.** Same three Plan 02 SUMMARY documented (`useRef` in skill-edit-page.tsx, `getConfig` in src/core/registry.ts, `kvStore` in tests/integration/multi-host.test.ts). All pre-date this plan. Lint exits 0 → gate satisfied. Out of scope per Rule 0 (boundary).

- **Pre-commit hooks ran ~30s per commit.** typecheck (~25s warm cache) dominates the wall-clock. All gates green; nothing actionable.

## User Setup Required

None — pure-library + admin-route plan. The admin DELETE endpoint is operator-facing only (no MCP tool exposure per D-11). To exercise it manually:

1. Start dev server (`npm run dev`)
2. Set admin cookie via `/welcome` (existing onboarding flow)
3. `curl -X DELETE -b "kebab_admin_token=<token>" "http://localhost:3000/api/admin/unipile/cache/urn?profile_url=https://linkedin.com/in/yassineht"`
4. Expect `200 { ok: true, evicted: true, key: "unipile:urn:<16-hex>", normalized_url: "https://linkedin.com/in/yassineht" }`

The resolver `resolveProviderId()` will exercise itself end-to-end as part of Plan 06's `linkedin_send_connection` tool. No standalone smoke test needed in phase 68 because Plan 06 is the consumer.

## Next Phase Readiness

- **Plan 04 (audit + dedup) — UNBLOCKED.** Independent of Plan 03 — can run in parallel. Imports `UnipileErrorResult` + `classifyUnipileError` from Plan 02; no Plan 03 deps.
- **Plan 05 (crm-bridge skeleton) — UNBLOCKED.** Independent of Plan 03 — can run in parallel.
- **Plan 06 (linkedin tools) — UNBLOCKED via 03/04/05.** Will import `resolveProviderId` from `@/connectors/unipile/lib/identifiers` and call it as the FIRST step of `linkedin_send_connection` (replace `args.profile_url` → `provider_id` URN before calling `client.users.sendInvitation`). Same resolver also powers `linkedin_get_relationship_status`.
- **No blockers. No deferred items.**

## Threat Flags

None — all surface added by this plan is documented in the plan's `<threat_model>` block:

- T-68-03-01 (URN cache poisoning by malicious tenant): MITIGATED by tenant-prefixed `getContextKVStore()` — verified by the kv-allowlist contract test passing.
- T-68-03-02 (URN value leaked across tenants): MITIGATED — same tenant-prefix wrapper.
- T-68-03-03 (Forged DELETE without admin cookie): MITIGATED by `withAdminAuth` HOC (returns 401 from the auth-step before reaching the handler).
- T-68-03-04 (Malformed profile_url ReDoS): MITIGATED — SLUG_RE has bounded alternation + simple `[a-zA-Z0-9_%-]+` char class, not vulnerable to catastrophic backtracking.
- T-68-03-05 (profile_url logging exposes PII): ACCEPTED — LinkedIn slugs are public, not PII.
- T-68-03-06 (Bulk eviction DoS): ACCEPTED — one KV.delete per call; trivial at Cadens scale.

## Self-Check: PASSED

Files verified present:
- `src/connectors/unipile/lib/identifiers.ts` → FOUND (commit e13f5cc)
- `src/connectors/unipile/lib/__tests__/identifiers.test.ts` → FOUND (commit e13f5cc)
- `app/api/admin/unipile/cache/urn/route.ts` → FOUND (commit 81fdb50)
- `tests/contract/kv-allowlist.test.ts` (modified) → ALLOWLIST entry verified (commit cabca8c)
- `.planning/phases/68-unipile-foundation/68-03-SUMMARY.md` → this file

Commits verified in git log:
- `e13f5cc` feat(68-03): URL→URN resolver with 30-day KV cache (D-09/D-10/D-12/D-18) → FOUND
- `81fdb50` feat(68-03): admin DELETE for URN cache eviction (D-11/D-18 escape hatch) → FOUND
- `cabca8c` test(68-03): allowlist admin URN cache route for getKVStore (D-18 escape hatch) → FOUND

Acceptance criteria from PLAN.md success_criteria all met:
- [x] `normalizeProfileUrl` covers 4 D-12 variants + 13 locale prefixes + rejects unsupported formats (Sales Navigator, activity, empty) — 7 it.each cases + 3 throws tests.
- [x] `urnCacheKey` deterministic + `unipile:urn:<16-hex>` format — 3 dedicated tests.
- [x] Cache HIT returns from KV without SDK call (asserted via `not.toHaveBeenCalled()`).
- [x] Cache MISS calls SDK with slug-only identifier, writes KV with 2,592,000s TTL — asserted with literal `expect(URN_TTL_SECONDS).toBe(30 * 24 * 60 * 60)`.
- [x] Unipile 429 propagates after withRetry exhausts (D-10 strict) — verified with vi.useFakeTimers + detached-rejection.
- [x] Admin DELETE endpoint accepts `?profile_url=…`, validates input, computes the SAME hash via shared `urnCacheKey()`, evicts via root-scope `getKVStore()`, returns structured JSON.
- [x] kv-allowlist contract test passes with exactly one new admin entry; NO connector source file in the allowlist.

Verification gauntlet (from `<verification>` block):
- [x] All 3 tasks pass automated verify commands (20 + 1 = 21 tests).
- [x] `npx tsc --noEmit` exits 0.
- [x] `npm run lint` exits 0 (3 pre-existing warnings unrelated).
- [x] `npm run test:contract` exits 0 (no contract regressions).
- [x] kv-allowlist callsite test passes (1/1).

---

*Phase: 68-unipile-foundation*
*Completed: 2026-05-18*
