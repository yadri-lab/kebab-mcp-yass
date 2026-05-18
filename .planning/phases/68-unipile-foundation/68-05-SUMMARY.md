---
phase: 68-unipile-foundation
plan: 05
subsystem: connector-crm-bridge-skeleton
tags: [unipile, crm-bridge, outbox-pattern, twenty-skeleton, phase-70-handoff, d-01-locked, d-18-tenant-scope]

# Dependency graph
requires:
  - phase: 42-tenant-scoping
    provides: getContextKVStore() per-request tenant prefix (D-18)
  - phase: 68-unipile-foundation
    provides: 68-04 — generateAuditId / writeAuditRow (Plan 06 will pair the audit row with the outbox row via shared audit_id)
provides:
  - CrmAdapter interface — phase 70 can drop in a real TwentyAdapter without touching tool handlers
  - TwentyAdapterSkeleton class — writes unipile:outbox:<audit_id> with status='pending' and stops (D-01)
  - crmBridge singleton — default consumer style for tool handlers
  - writeOutboxRow(auditId, crmLog) — free-function convenience equivalent to crmBridge.writeOutbox
  - CrmOutboxStatus type — extensible status enum (phase 68 only emits 'pending'; phase 70 will add 'sent', 'failed', 'dead')
  - CrmOutboxRow type — locked outbox row schema (phase 70 will extend with attempts / next_retry_at / error?)
affects: [68-06-tools (consumes crmBridge.writeOutbox), 70-webhook (lands real TwentyAdapter), 71-admin-outbox-query]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Interface-first skeleton with documented future contracts — CrmAdapter is the public surface; TwentyAdapterSkeleton is the only phase 68 implementation. JSDoc on the interface spells out the phase 70 contract (D-02 per-tenant webhook URL, D-03 per-tenant HMAC secret env var, D-04 exponential cron retry 1/5/30min, dead after 3) so phase 70 implements against a known, locked-in shape. Phase 70's job is 'implement, don't redesign.'"
    - "Outbox-write-with-NO-TTL — durable rows survive until phase 70's retry cron processes them. The absence of TTL is deliberate (test asserts kv.set's third arg is undefined). A phase 71 cleanup may add TTL once status reaches 'sent' or 'dead'."
    - "Static source-code constraint test (D-01 tripwire) — vitest spec reads crm-bridge.ts from disk, strips /* */ and // comments, then asserts the runtime code contains NO fetch(, createHmac, UNIPILE_CRM_WEBHOOK_URL, UNIPILE_CRM_WEBHOOK_SECRET, timingSafeEqual, getConfig(, or node:crypto import. Comment-stripping is critical: it lets the file STILL DOCUMENT the phase 70 contract without tripping the guard. This pattern would catch any future contributor accidentally smuggling phase 70 work into phase 68."
    - "Two ergonomic call styles for the same write — `crmBridge.writeOutbox(id, {crm_log})` (singleton-method) and `writeOutboxRow(id, crmLog)` (free-function). Tool handlers may prefer either; both route through the same TwentyAdapterSkeleton.writeOutbox path."
    - "All KV access via getContextKVStore() — no kv-allowlist entry needed since this module never uses the root-scope getKVStore() escape hatch. On-disk keys become tenant:<id>:unipile:outbox:* automatically (D-18)."

key-files:
  created:
    - src/connectors/unipile/lib/crm-bridge.ts
    - src/connectors/unipile/lib/__tests__/crm-bridge.test.ts
  modified: []

key-decisions:
  - "CrmAdapter interface owns the public contract; TwentyAdapterSkeleton is the only phase 68 implementation. Tool handlers depend on the interface, not the concrete class. Phase 70 swaps in a real TwentyAdapter (with HTTP POST + HMAC + retry tracking) by REPLACING the singleton — no tool-handler changes needed."
  - "Outbox rows have NO TTL — durability is intentional. Phase 70's retry cron is the only entity that should ever clear rows (by transitioning status to 'sent' or 'dead'). A phase 71 cleanup may apply a TTL post-mortem, but that's out of scope for phase 68."
  - "D-02/D-03/D-04 phase 70 contracts are documented in the source file's JSDoc rather than in external docs only. Rationale: phase 70 implementors will read the interface comments before opening 68-CONTEXT.md. Locking the contract in code prevents 'implement, then redesign' churn."
  - "Static source-code check (forbidden-symbols test) operates on COMMENT-STRIPPED source so the file can DOCUMENT the phase 70 HMAC/webhook/env-var contracts while still failing the build if any of those symbols appear in runtime code. The regex strips /* */ block comments AND // line comments before grepping."
  - "writeOutboxRow free-function is a pure-ergonomics convenience — equivalent to crmBridge.writeOutbox(id, {crm_log}). Both styles ship to give tool handlers flexibility; the implementation is single-sourced through the singleton."
  - "RED-then-GREEN folded into a single commit (7eeac00) per Plan 04's husky-pre-commit pattern. The repo's pre-commit hook runs tsc --noEmit on each staged TS file via lint-staged, which (correctly) refuses to commit a test file importing a non-existent module. TDD intent (test-first authoring) is preserved at the file-system level — crm-bridge.test.ts was written first and run against the missing module to confirm RED, THEN crm-bridge.ts was authored, both committed together."

patterns-established:
  - "Phase-70-handoff-in-code pattern: when a phase 68 skeleton needs phase 70 to implement a real contract, document the phase 70 plan in JSDoc on the interface (not just in external 68-CONTEXT.md). Future implementors read the interface comments first; locking the contract in code prevents redesign churn during phase 70."
  - "Comment-stripping static guard: when a source file must DOCUMENT forbidden symbols (e.g. phase 70 contracts mentioning HMAC) while NOT using them at runtime, write the static check as `raw.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/(^|[^:])\\/\\/[^\\n]*/g, '$1')` BEFORE the forbidden-symbols grep. The `[^:]` in the line-comment regex avoids accidentally stripping `https://` URLs."
  - "Future-extensible status enums: ship the enum with all foreseen states (pending/sent/failed/dead) even when phase 68 only emits one. Phase 70 then adds behavior without a breaking type change."

requirements-completed: [UNI-05]

# Metrics
duration: 3.5min
completed: 2026-05-18
---

# Phase 68 Plan 05: CRM Bridge Skeleton Summary

**CrmAdapter interface + TwentyAdapterSkeleton outbox writer — writes `unipile:outbox:<audit_id>` with status='pending' (D-01) and stops. NO HTTP, NO HMAC, NO env-var reads. Phase 70 contracts (D-02/D-03/D-04) documented in JSDoc so phase 70 implements against a locked shape.**

## Performance

- **Duration:** 3.5 min
- **Started:** 2026-05-18T15:59:12Z
- **Completed:** 2026-05-18T16:02:50Z
- **Tasks:** 1 (single-task plan, TDD)
- **Files created:** 2 (crm-bridge.ts + crm-bridge.test.ts)
- **Files modified:** 0
- **Tests added:** 10 (all green; full unipile suite now 88 tests)

## Accomplishments

- 4 runtime exports (`CrmAdapter` interface, `TwentyAdapterSkeleton` class, `crmBridge` singleton, `writeOutboxRow` free function) + 2 types (`CrmOutboxStatus`, `CrmOutboxRow`) — exactly the surface specified in the plan, no scope creep.
- 10 vitest specs covering: skeleton writes `status='pending'` to the right key, NO TTL passed, null + object `crm_log` roundtrip through JSON, free-function equivalence with the singleton, ISO-8601 `queued_at` format, CrmAdapter interface assignability for both the class and the singleton, AND a 3-spec static source-code constraint suite (forbidden symbols absent in runtime code, `getContextKVStore()` present, D-02/D-03/D-04 comments present).
- D-18 tenant-scope guarantee: ALL KV writes go through `getContextKVStore()` — verified by a runtime test grep against the source file. No `kv-allowlist` entry needed (module never reaches for `getKVStore()`).
- D-01 hard constraint enforced AT THE BOUNDARY: the static source-code test reads `crm-bridge.ts` from disk, strips comments, and greps for `fetch(`, `createHmac`, `UNIPILE_CRM_WEBHOOK_URL`, `UNIPILE_CRM_WEBHOOK_SECRET`, `timingSafeEqual`, `getConfig(`, and any `node:crypto` import. The build fails if any phase 70 work smuggles in. This is the executor's safety net against scope creep.
- All pre-commit hooks green: lint-staged (eslint + prettier), contract test (91 tools across 17 connectors — unchanged, Unipile still 0 tools until Plan 06 wires the manifest), doc-counts (no drift), typecheck (zero TS errors).

## Task Commits

- `7eeac00` feat(68-05): CRM bridge skeleton — CrmAdapter interface + TwentyAdapterSkeleton outbox writer (D-01)
  - 2 files / 288 insertions
  - 10 vitest specs (all green)

## Final Interface Shape

```ts
// src/connectors/unipile/lib/crm-bridge.ts (excerpt)

export type CrmOutboxStatus = "pending" | "sent" | "failed" | "dead";

export interface CrmOutboxRow {
  audit_id: string;
  status: CrmOutboxStatus;
  crm_log: unknown;
  queued_at: string; // ISO-8601 UTC
}

export interface CrmAdapter {
  writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void>;
}

export class TwentyAdapterSkeleton implements CrmAdapter { /* ... */ }
export const crmBridge: CrmAdapter = new TwentyAdapterSkeleton();
export async function writeOutboxRow(auditId: string, crmLog: unknown): Promise<void>;
```

## Outbox KV Key Format

- **Key (raw):** `unipile:outbox:<audit_id>`
- **Key (on disk, tenant-scoped):** `tenant:<tenant_id>:unipile:outbox:<audit_id>` (D-18 auto-prefix via getContextKVStore)
- **Value:** `JSON.stringify(CrmOutboxRow)` with `status: 'pending'`, ISO-8601 `queued_at`
- **TTL:** NONE — outbox rows are durable until phase 70's retry cron transitions them to `sent` or `dead`.

## D-01 Skeleton Constraint — Explicit Confirmation

The implementation file contains:
- ZERO calls to `fetch(...)` (no HTTP)
- ZERO references to `createHmac` / `timingSafeEqual` (no HMAC signing)
- ZERO references to `UNIPILE_CRM_WEBHOOK_URL` / `UNIPILE_CRM_WEBHOOK_SECRET_*` env vars
- ZERO calls to `getConfig(...)` (no env-var reads beyond what getContextKVStore needs)
- ZERO imports of `node:crypto`
- ZERO root-scope `getKVStore()` calls (kv-allowlist clean)

All of the above are verified by the vitest static source-code suite (`describe("D-01 hard constraint: skeleton MUST NOT call fetch or hmac")`), which reads the source file from disk, strips comments, and asserts each forbidden symbol is absent.

## Phase 70 Handoff Contract

When phase 70 lands the real TwentyAdapter (replacing TwentyAdapterSkeleton in the `crmBridge` export), here is the locked contract documented in the source JSDoc:

| Step | Action | Locked decision |
|------|--------|-----------------|
| 1 | Read per-tenant webhook URL | D-02 — env var `UNIPILE_CRM_WEBHOOK_URL`, resolved via `getConfig()` (NOT direct `process.env`) |
| 2 | Read per-tenant HMAC secret | D-03 — env var pattern `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (e.g. `UNIPILE_CRM_WEBHOOK_SECRET_CADENS_001`), resolved via `getCredential()` |
| 3 | Compute HMAC-SHA256 over canonical request body | `node:crypto.createHmac('sha256', secret)`; verify inbound signatures via `timingSafeEqual` |
| 4 | POST to webhook URL | `Authorization: HMAC <sig>` header |
| 5 | On 2xx | Update outbox row: `status='sent'` |
| 6 | On non-2xx / network failure | Update outbox row: `status='failed'`, `attempts++`. Phase 70 retry cron picks it up per D-04: 1min / 5min / 30min. After 3 failures → `status='dead'`, surfaced in `/config` per D-17 ("Erreur d'envoi - retry", red icon). |

Phase 70 will also add a separate retry handler (cron route or background worker) scanning `unipile:outbox:*` keys with status in `{pending, failed}`. Phase 68 ONLY writes the rows — the retry cron is phase 70's domain.

The `CrmOutboxRow` shape will extend in phase 70 with: `last_attempt_at`, `attempts`, `next_retry_at`, `error?`. Tool handlers will not need to change — the interface contract on `writeOutbox` is stable.

## Consumer Pattern for Plan 06

Plan 06's `linkedin_send_connection` canonical call sequence (per 68-04-SUMMARY handoff + this plan's outbox add):

```
normalizeProfileUrl(rawUrl)
  → computeParamsHash({tool, profile_url_normalized, note: note ?? ''})
  → checkDedup(hash)              // if hit → early return with dedup_hit:true (no outbox write)
  → resolveProviderId(normalized) // KV-cached URN
  → unipile.users.invite(...)
  → writeAuditRow({...result, params_hash: hash, dedup_hit: false})
  → crmBridge.writeOutbox(audit_id, { crm_log })   // ← THIS PLAN's surface
```

Note: outbox write happens AFTER the audit row write. The audit row is the source of truth for the connection-request itself; the outbox row is the CRM-side todo. They share `audit_id` so phase 70's retry cron can join them.

## TDD Gate Compliance

Plan declared `tdd="true"`. Per Plan 04's documented husky-pre-commit pattern:
- `crm-bridge.test.ts` was authored FIRST.
- It was run against the missing `../crm-bridge` module to confirm RED (Cannot find module).
- THEN `crm-bridge.ts` was authored.
- Both files committed together in `7eeac00` as a single `feat(68-05)` commit.

The husky pre-commit hook runs `tsc --noEmit` per staged TS file via lint-staged, which (correctly) blocks a RED-only commit where the test imports a not-yet-existent module. The TDD discipline (test-first authoring, observe RED, then write code) is upheld at the file-system level; the single-commit topology is a working-tree concession to the hook, not a TDD violation. This is the same pattern documented in 68-04-SUMMARY.md.

The git log shows a single `feat(...)` commit rather than a `test(...)` → `feat(...)` pair. The plan-level TDD gate check should note this is intentional and matches the Plan 04 precedent.

## One in-line auto-fix during execution

Rule 3 — Blocking issue (folded into commit 7eeac00):
- The test file's JSDoc header originally contained `/** ... */` LITERALLY as documentation text. The `*/` substring closed the surrounding JSDoc early and the oxc parser flagged a missing semicolon at line 17:60. Fix: reworded the comment to use prose ("JSDoc block-comment references") instead of literal `/** ... */`. No runtime impact; pure documentation phrasing fix.

## Deviations from Plan

### None functionally — auto-fix was a 1-line comment phrasing

The plan's sketch code was followed verbatim with three intentional enhancements:

1. **Hoisted mock pattern** — used `vi.hoisted()` for the kvMock (Plan 04's canonical pattern) rather than the plan's plain `vi.fn()` factory. Same behavior, but consistent with the rest of the connector's test suite.
2. **Extra defensive assertions** — added a `kv-allowlist` cleanliness check (`no bare getKVStore() call`), a `node:crypto` import absence check, and a `timingSafeEqual` absence check. All three reinforce D-01 at the boundary.
3. **Comment-stripping in the static source-code test** — the plan's sketch greps the raw source. To allow the file to DOCUMENT the phase 70 contract (which mentions HMAC, env-var names, etc.) without tripping the guard, comments are stripped first. Without this, the guard would force the documentation OUT of the source file into 68-CONTEXT.md only, which weakens phase 70's handoff. Documented in the test file's own JSDoc.

None of the above changes the public surface or the behavior — they harden the test suite and improve the documentation locality.

## Future Phase Implications

- **Phase 70:** Drop in a real `TwentyAdapter implements CrmAdapter` (with HTTP + HMAC + retry tracking) and replace `crmBridge`'s export. Tool handlers do not need to change. Add the retry cron in a new file (e.g. `app/api/cron/unipile-outbox-retry/route.ts`) that scans `tenant:*:unipile:outbox:*` keys (cross-tenant cron, requires the root-scope `getKVStore()` escape hatch and a corresponding `kv-allowlist` entry — same pattern as `app/api/admin/unipile/cache/urn/route.ts` from Plan 03).
- **Phase 71:** Add a TTL or compaction job for outbox rows whose `status` has reached `sent` or `dead`. Phase 68's "no TTL" guarantee is intentionally absolute for the foreseeable lifetime of a row.
- **Phase 71 admin UI:** `/config` may want to surface outbox queue depth + dead rows. The `crm_log: unknown` payload is opaque to phase 68; phase 71 can layer a documented schema on top.

## Self-Check: PASSED

- File `src/connectors/unipile/lib/crm-bridge.ts` exists (verified)
- File `src/connectors/unipile/lib/__tests__/crm-bridge.test.ts` exists (verified)
- Commit `7eeac00` exists in git log (verified)
- 10/10 vitest specs green
- Full unipile suite: 88/88 green (was 78; +10 from this plan)
- tsc --noEmit: 0 errors
- npm run lint: 0 errors (3 pre-existing warnings, out of scope)
- npm run test:contract: PASS (Unipile toolCount unchanged at 0 — Plan 06 wires the manifest)
- grep `getKVStore(` in crm-bridge.ts → NO matches (kv-allowlist clean)
- grep `getContextKVStore()` in crm-bridge.ts → 2 matches (1 JSDoc + 1 runtime at L110)
