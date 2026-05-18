---
phase: 68-unipile-foundation
plan: 04
subsystem: connector-audit-log-dedup
tags: [unipile, audit-log, dedup, kv-ttl, sha256, gdpr, tenant-scope, no-pii]

# Dependency graph
requires:
  - phase: 42-tenant-scoping
    provides: getContextKVStore() per-request tenant prefix
  - phase: 48-config-facade
    provides: env-read facade (audit.ts has no env reads, but pattern adhered)
  - phase: 68-unipile-foundation
    provides: 68-03 — normalizeProfileUrl (callers MUST pass already-normalized URLs to computeParamsHash so the hash is consistent with what the resolver sees)
provides:
  - generateAuditId() — UUIDv4 thin wrapper around node:crypto.randomUUID
  - computeParamsHash({tool, profile_url_normalized, note}) — SHA-256 truncated to 16 hex chars, deterministic, key-order-independent (D-05 strict)
  - writeAuditRow(row) — dual KV write (primary row + hash-pointer index), both with 90-day TTL (D-08)
  - checkDedup(params_hash) — shape-defensive prior-row lookup; returns the full AuditRow on hit, null on miss/corrupt/shape-mismatch
  - AUDIT_TTL_SECONDS constant (7,776,000 = 90 * 24 * 60 * 60) exported so tests can assert the literal value (Pitfall 7 — FilesystemKV ignores TTL)
  - AuditRow + AuditResult types (locked schemas — note_text NEVER persisted per D-07)
affects: [68-05-crm-bridge, 68-06-tools, 70-webhook, 71-admin-audit-query]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual KV write with TTL value asserted in test (D-07 + D-08 + Pitfall 7) — primary row + hash-pointer index, both written via Promise.all, both with the same AUDIT_TTL_SECONDS literal. Tests verify the third arg of kv.set rather than actual expiry (FilesystemKV ignores TTL in dev)."
    - "Hash-pointer-stores-full-row design — the dedup index value is the FULL AuditRow JSON (not just an audit_id). One KV read in checkDedup covers both dedup-check AND prior-result display in one shot. 2x storage overhead negligible at Cadens scale (~800 KB ceiling across 90-day window)."
    - "Canonical-keys-before-stringify hashing (D-05) — JSON.stringify with alphabetically-sorted keys defeats caller object-literal insertion-order influence on the hash. Independent of TC39's specified key-iteration order — future-proofs against engine quirks and refactor-induced re-orderings."
    - "Shape-defensive fail-OPEN parsing in checkDedup — corrupt JSON OR parseable-but-missing-audit_id rows both yield null. Garbage state cannot block legitimate calls forever; the caller can re-write a clean row over the missing pointer."
    - "Export-shape guard test (D-06) — Object.keys(mod) assertion that bypassDedup / forceWrite do NOT appear in module exports, plus computeParamsHash.length ≤ 1 to confirm the signature has no positional dedup_key. Double layer (TypeScript compile-time + Vitest runtime)."

key-files:
  created:
    - src/connectors/unipile/lib/audit.ts
    - src/connectors/unipile/lib/__tests__/audit.test.ts
  modified: []

key-decisions:
  - "Hash pointer stores the FULL row JSON (not just the audit_id). One KV read in checkDedup serves dedup + prior-result display. Storage trade-off: ~800 KB ceiling at Cadens scale (max 30/day × 90 days × 2 copies × ~150 bytes) — negligible."
  - "computeParamsHash sorts keys alphabetically before JSON.stringify (canonical form). Defensive against caller object-literal insertion-order influence — TC39 specifies own-string-key iteration order, but explicit sort future-proofs against refactor-induced reorderings."
  - "checkDedup is shape-defensive AND fail-OPEN: corrupt JSON, parse error, OR parseable-but-missing-audit_id all return null. Rationale — garbage state (manual KV edits, partial writes from a Vercel timeout, schema drift in a future plan) should not block legitimate calls forever. The next write overwrites the bad pointer."
  - "RED-then-GREEN folded into a single commit (331d152) because the repo's husky pre-commit hook runs typecheck on every staged TS file, which (correctly) refuses to commit a test file that imports a non-existent module. The TDD intent (test-first authoring) is preserved by file-creation order — audit.test.ts was written and failed (Cannot find module audit) BEFORE audit.ts was authored."
  - "All KV access via getContextKVStore() (D-18) — no need to add a kv-allowlist entry since this module does not use the root-scope getKVStore() escape hatch. On-disk keys become tenant:<id>:unipile:audit:* automatically."

patterns-established:
  - "TDD-via-husky-tension resolution: when a husky pre-commit typecheck blocks the RED-only commit (the test imports a not-yet-existent module), author both files, run the test FIRST against the missing module to confirm RED (Cannot find module), then write the implementation and commit both in a single GREEN commit. The TDD discipline (write the test first, watch it fail) is upheld at the file-system level; the commit topology is a working-tree concession to the hook, not a TDD violation."
  - "TTL value tests over actual-expiry tests: assert the third arg passed to kv.set rather than waiting for the key to disappear. Faster, deterministic, and works under FilesystemKV which ignores TTL in dev (Pitfall 7)."
  - "Future audit.ts consumers (Plan 06 linkedin_send_connection): the call sequence is normalizeProfileUrl(rawUrl) → computeParamsHash({tool, profile_url_normalized: normalized, note: note ?? ''}) → checkDedup(hash) → if hit return early with dedup_hit:true → else resolveProviderId() → unipile.users.invite() → writeAuditRow({...result, params_hash: hash, dedup_hit: false}). Note the empty-string default for `note` — undefined would break the canonical hash."

requirements-completed: [UNI-04]

# Metrics
duration: 5min
completed: 2026-05-18
---

# Phase 68 Plan 04: Audit Log + Dedup Summary

**KV-backed audit log writer + dedup checker — SHA-256→16-hex `params_hash` over `{tool, profile_url_normalized, note}` (D-05), dual KV write with 90-day TTL (D-07/D-08), tenant-scoped via `getContextKVStore()` (D-18). NO `note_text` ever leaves the function; NO `dedup_key` bypass exists (D-06).**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-18T15:50:17Z
- **Completed:** 2026-05-18T15:55:19Z
- **Tasks:** 1 (single-task plan, TDD)
- **Files created:** 2 (audit.ts + audit.test.ts)
- **Files modified:** 0
- **Tests added:** 19 (all green)

## Accomplishments

- 4 exported functions (`generateAuditId`, `computeParamsHash`, `writeAuditRow`, `checkDedup`) + 2 types (`AuditRow`, `AuditResult`) + 1 constant (`AUDIT_TTL_SECONDS`) — exactly the surface specified in the plan, no scope creep.
- 19 specs covering: UUIDv4 shape + distinctness, hash determinism + key-order independence + content-sensitivity (1-char note change ≠ same hash), TTL literal value (7,776,000s), dual KV write + JSON roundtrip + PII-exclusion (D-07 GDPR), checkDedup hit/miss/corrupt/shape, and the API-surface guard (D-06 — no bypass symbol).
- All pre-commit hooks green: lint-staged (eslint + prettier), contract test (91 tools / 17 connectors), doc-counts (no drift), typecheck (zero TS errors).
- Pushed to origin/main: `6d98e00..331d152`.

## Task Commits

This plan declared `tdd="true"`. Per the executor TDD flow, RED and GREEN normally land as separate commits, but the repository's husky pre-commit hook runs `tsc --noEmit` on every staged TypeScript file. A RED-only commit (test file importing a non-existent `../audit` module) fails typecheck and is blocked.

Resolution: file-creation order preserves the TDD discipline — `audit.test.ts` was authored FIRST, then run against the missing module to confirm RED (`Cannot find module audit`), THEN `audit.ts` was authored. Both files landed in a single GREEN commit because the hook will not let RED ship standalone.

1. **Task 1: Build audit.ts + audit.test.ts (RED→GREEN folded)** — `331d152` (feat)

**No metadata commit yet** — created after STATE.md + ROADMAP.md updates (next step in the executor flow).

## Files Created/Modified

- `src/connectors/unipile/lib/audit.ts` — Audit log writer + dedup checker. 4 functions, 2 types, 1 constant. ~145 LoC including JSDoc. No env reads. No root-scope KV. No PII persistence.
- `src/connectors/unipile/lib/__tests__/audit.test.ts` — 19 specs in 6 `describe` blocks. Mocks `@/core/request-context` via `vi.hoisted()` (same canonical pattern as Plan 03's `identifiers.test.ts`). ~290 LoC.

## Decisions Made

### Hash pointer stores the FULL row, not just an audit_id
The plan's `<action>` proposed two options for the hash-pointer value: (a) `JSON.stringify(audit_id)` (cheap, pointer-only) or (b) `JSON.stringify(row)` (full row). I chose (b). Rationale: `checkDedup` is the hot path called by every Plan 06 `linkedin_send_connection` invocation — having it return the full prior row in one KV read enables Plan 06 to surface "your last call on 2026-05-01 returned `success`" without a second KV `get` against `unipile:audit:<audit_id>`. Storage trade-off: ~800 KB ceiling at Cadens scale (max 30 sends/day × 90 days × 2 KV rows × ~150 bytes each). Negligible.

### Canonical-form hashing (sorted keys) over relying on TC39 iteration order
TC39 specifies that own-string-key iteration order is insertion order for non-numeric keys, so `JSON.stringify({a, b, c})` and `JSON.stringify({b, a, c})` already differ in their string output (which is why the plan's "key-order independence" test is meaningful). The implementation sorts keys explicitly before stringify. Defensive against future refactors that might reorder the object literal — the hash is the durable contract, not the source code's prop order.

### checkDedup fails OPEN (returns null) on shape mismatch
A parseable-but-not-matching-AuditRow row (e.g. `{foo: 'bar'}`) returns `null`, not the parsed object. This is intentional: a future schema drift (Plan 06 adds a field, Plan 70 adds another) would otherwise either crash or return a malformed row to the caller. Returning `null` lets the caller proceed and overwrite the bad pointer on the next `writeAuditRow`. Garbage state is self-healing.

### RED-then-GREEN folded into a single commit (husky-pragmatic)
The plan declared `tdd="true"`. The repo's `.husky/pre-commit` runs `tsc --noEmit` on every staged TS file via lint-staged. A RED-only commit (test importing the non-existent `../audit` module) fails typecheck and is blocked by the hook. Resolution: file-system-level TDD — `audit.test.ts` was written first, ran (Cannot find module) confirming RED, THEN `audit.ts` was written. Both files landed in commit `331d152`. The TDD discipline is upheld; the commit topology bends to the hook. The git log loses the RED breadcrumb, but `## TDD Gate Compliance` (below) flags this explicitly.

## Deviations from Plan

None — every spec in the plan was implemented as written. The hash-pointer "stores the FULL row" choice was explicitly enumerated as a design option in the plan's `<action>` notes, so it is not a deviation.

The RED→GREEN commit folding is a TDD-gate-compliance concern (documented below), not a deviation from the plan's intent.

## TDD Gate Compliance

The plan declared `tdd="true"`. Expected gate sequence:
1. RED gate: `test(...)` commit with failing test
2. GREEN gate: `feat(...)` commit with implementation
3. REFACTOR gate (optional): `refactor(...)` if cleanup needed

Actual gate sequence:
1. **MERGED RED+GREEN**: `331d152` (feat) — both audit.test.ts and audit.ts landed together because the husky pre-commit `tsc --noEmit` hook refuses to commit a test file that imports a not-yet-existent module.

**Warning:** The git log does not contain a separate RED commit. The TDD discipline (test-first authoring, watch-it-fail-before-implementing) was upheld at the file-system level: I wrote audit.test.ts FIRST, ran `npx vitest run ...` and confirmed `Cannot find module audit`, THEN authored audit.ts. The commit topology is a working-tree concession to the hook, not a TDD-process violation. Operators reviewing this plan in git history should be aware.

**Resolution options for future TDD plans:** (a) accept the merged commit as the project's effective TDD topology under husky, OR (b) loosen the husky pre-commit to typecheck only the project root rather than per-staged-file. Option (b) is a v0.17 or v0.18 follow-up — out of scope for this plan.

No REFACTOR commit — the test+impl shipped clean.

## Issues Encountered

None during execution. The husky-vs-RED tension (above) is a known property of the repo's pre-commit setup, not an issue with this plan.

## User Setup Required

None — pure-library plan. No env vars, no external services, no dashboard configuration.

## Next Phase Readiness

**Plan 05 (CRM bridge skeleton, Wave 2)** — Unblocked. Can run in parallel with this plan complete (they don't share files).

**Plan 06 (linkedin_send_connection + linkedin_get_relationship_status, Wave 3)** — Unblocked once Plan 05 also lands. Plan 06's tool handler will consume:
- `resolveProviderId` from Plan 03 (URL → URN)
- `computeParamsHash` + `checkDedup` + `writeAuditRow` from this plan
- (TBD whether Plan 05 ships anything Plan 06 imports — CRM-bridge skeleton may or may not be wired directly into the tool handler in phase 68 per D-01)

**Call sequence for Plan 06 (canonical):**
```typescript
const normalized = normalizeProfileUrl(rawUrl);                       // Plan 03
const hash = computeParamsHash({                                       // Plan 04
  tool: "linkedin_send_connection",
  profile_url_normalized: normalized,
  note: note ?? "",                                                    // empty-string default — undefined would break the canonical hash
});
const prior = await checkDedup(hash);                                  // Plan 04
if (prior) return { dedup_hit: true, audit_id: prior.audit_id, ... }; // D-06 enforced HERE
const { provider_id } = await resolveProviderId(normalized, accountId);// Plan 03
const result = await unipile.users.invite({ provider_id, message: note });
const row: AuditRow = { audit_id: generateAuditId(), params_hash: hash, ... };
await writeAuditRow(row);                                              // Plan 04
return { ..., dedup_hit: false, audit_id: row.audit_id };
```

**No blockers, no follow-ups, no carry-over for Plan 06 beyond the above.**

## Self-Check: PASSED

- `src/connectors/unipile/lib/audit.ts` — exists, contains all 6 exports.
- `src/connectors/unipile/lib/__tests__/audit.test.ts` — exists, 19 tests passing.
- Commit `331d152` — present in `git log --all`.
- All acceptance-criteria greps pass (AUDIT_TTL_SECONDS literal, getContextKVStore() present, getKVStore() absent, process.env absent, no dedup-bypass symbols in code).
- `npx vitest run src/connectors/unipile/lib/__tests__/audit.test.ts` exits 0 with 19/19 passing.
- Pre-commit hook gate (eslint + contract + doc-counts + typecheck) all green.
- Pushed to origin/main.

---
*Phase: 68-unipile-foundation*
*Completed: 2026-05-18*
