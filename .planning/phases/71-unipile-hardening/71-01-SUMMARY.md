---
phase: 71-unipile-hardening
plan: 01
subsystem: connector
tags: [unipile, linkedin, kill-switch, write-tools, audit, retrofit, env-var, tenant-scope]

# Dependency graph
requires:
  - phase: 70-webhooks-whatsapp
    provides: "Plan 70-03 — halt-check Step 0 retrofit on all 4 LinkedIn write tools (canonical Step pattern that Step -1 sits in front of)"
  - phase: 69-linkedin-writes
    provides: "4 LinkedIn write tools (send_connection, send_message, send_inmail, engage) — extended in this plan with Step -1 kill-switch gate"
  - phase: 50-brand-rename
    provides: "BRAND_01 — getConfig() KEBAB_*/MYMCP_* alias resolution from src/core/config-facade.ts (D-89 mandate)"
provides:
  - "Step -1 kill-switch pre-flight gate on all 4 LinkedIn write tools (D-86/D-88/D-89 — highest-priority refusal, BEFORE account-resolve, halt-check, dedup, rate-limit, SDK)"
  - "src/connectors/unipile/lib/kill-switch.ts — isWritesDisabled() helper reading KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED (primary) ?? LINKEDIN_TOOLS_DISABLED (legacy alias) via getConfig()"
  - "AuditResult enum gains error_writes_disabled member (D-88, appended at end of union)"
  - "TestConnectionResult interface gains optional writes_disabled?: boolean field (D-88)"
  - "manifest.testConnection() / probe() surfaces writes_disabled in all 3 return sites; success message suffixed with '⚠ writes disabled' when active"
  - "UNI-20 closed: operator emergency brake — one env-var flip halts all writes within 1 request hop; reads stay live"
affects:
  - "Future UNI-22 audit-query tool will surface kill-switch refusals via result='error_writes_disabled' index"
  - "Future /config → Connectors dashboard tile will render '⚠ Writes globally disabled' badge from probe().writes_disabled boolean"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-flight refusal pattern v3: Step -1 kill-switch → Step 0a account-resolve → Step 0b halt-check → Step 1 dedup → … Kill switch is the absolute first gate, runs BEFORE even cheap reads (account.getAll) so a halted operator burns nothing."
    - "Dual env-var alias (primary + legacy) via ?? coalesce in helper module — operator's legacy LINKEDIN_TOOLS_DISABLED still works; new KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED is canonical."
    - "Per-tool envelope contract for kill-switch refusal: send_* tools use their existing halt-style envelope (provider_ok: false, error: 'error_writes_disabled'); send_inmail also sets credits_used/credits_remaining: null (no balance fetch); engage uses its action:'skipped' shape with reason + error both = 'error_writes_disabled'."
    - "Manifest probe surfacing: writes_disabled?: boolean populated in all 3 return sites (success-≥1-LI, success-no-LI, catch-block) so dashboard UI can render the badge regardless of underlying ok state."

key-files:
  created:
    - src/connectors/unipile/lib/kill-switch.ts
    - src/connectors/unipile/lib/__tests__/kill-switch.test.ts
  modified:
    - src/connectors/unipile/lib/audit.ts
    - src/connectors/unipile/lib/__tests__/audit.test.ts
    - src/core/types.ts
    - src/connectors/unipile/tools/linkedin-send-connection.ts
    - src/connectors/unipile/tools/linkedin-send-message.ts
    - src/connectors/unipile/tools/linkedin-send-inmail.ts
    - src/connectors/unipile/tools/linkedin-engage.ts
    - src/connectors/unipile/manifest.ts
    - src/connectors/unipile/manifest.test.ts
    - src/connectors/unipile/tools/__tests__/linkedin-send-connection.test.ts
    - src/connectors/unipile/tools/__tests__/linkedin-send-message.test.ts
    - src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts
    - src/connectors/unipile/tools/__tests__/linkedin-engage.test.ts

key-decisions:
  - "D-86 implemented as ?? coalesce in helper: getConfig('KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED') ?? getConfig('LINKEDIN_TOOLS_DISABLED'). Primary wins on coalesce; legacy is fallback only. Truthy: 'true' || '1'. No Boolean(v) coercion — empty string returns false per Unix conventions."
  - "D-88 AuditResult extension: 1 new member appended at end of union with phase-71 block comment, mirroring D-78 phase-70 shape — no reordering of prior members, dashboards / queries that depend on declaration order stay stable."
  - "D-88 TestConnectionResult.writes_disabled?: boolean — optional + backward-compatible. Connectors without write surface (or without kill switch) leave it unset; manifest probe always populates true|false."
  - "D-89 getConfig only — kill-switch.ts has NO process.env reads. ESLint rule kebab/no-direct-process-env enforces this at lint time; grep guard in verification confirms."
  - "Step -1 sits BEFORE Step 0a account-resolve — saves the cheap account.getAll() call when writes are globally disabled. NO accountId is known yet, so the audit row's account_id field is '' (D-20 precedent — same shape as the existing account-resolve error path)."
  - "Engage uses its action:'skipped' envelope for Step -1 refusal (NOT send-* shape) — matches the existing halt-check refusal pattern in engage (engage's discriminated union has no separate kill-switch action discriminator needed)."
  - "Manifest probe always populates writes_disabled (true|false) in ALL 3 return sites, even when ok:false, so the dashboard tile can render the badge regardless of connection health."

requirements-completed: [UNI-20]

# Metrics
duration: 20min
completed: 2026-05-19
---

# Phase 71 Plan 01: Global Kill Switch for Unipile LinkedIn Writes (UNI-20) Summary

**Ship a global emergency brake for all LinkedIn write tools — one env-var flip (`KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true` or legacy `LINKEDIN_TOOLS_DISABLED=true`) refuses ALL 4 write tools (send_connection, send_message, send_inmail, engage) within 1 request hop; reads (get_relationship_status, list_pending) stay live. UNI-20 closed.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-18T22:50:27Z
- **Completed:** 2026-05-18T23:09:27Z
- **Tasks:** 2 (Task 1 = helper + enum + interface; Task 2 = handler retrofit + manifest probe)
- **Files created:** 2 (kill-switch.ts + kill-switch.test.ts)
- **Files modified:** 13 (5 source + 1 type + 7 test)

## Accomplishments

- **All 4 LinkedIn write tools now honor the global kill switch.** On `isWritesDisabled() === true`, the handler short-circuits IMMEDIATELY — no account-resolve, no halt-check, no dedup, no rate-limit, no SDK call, no CRM outbox, no balance fetch. The cheapest possible refusal path.
- **Per-tool envelope contracts** preserved with kill-switch-specific shape:
  - `send_connection`: `{error: 'error_writes_disabled', provider_ok: false, verified: false, dedup_hit: false, crm_sync: 'pending', audit_id}`
  - `send_message`: same shape (no `recipient_degree` — degree never resolved)
  - `send_inmail`: same shape + `credits_used: null, credits_remaining: null` (balance fetch was skipped)
  - `engage`: `{action: 'skipped', reason: 'error_writes_disabled', error: 'error_writes_disabled', degree: null, audit_id}` — matches engage's discriminated-union skip-path envelope
- **Exactly ONE minimal audit row** written per kill-switch refusal with `result: 'error_writes_disabled'` and `account_id: ''` (Step -1 fires BEFORE account-resolve, so no accountId is known yet — same D-20 precedent as existing account-resolve error path). Full audit trail for the future UNI-22 query tool to answer "who tried to send while writes were disabled?".
- **Manifest probe extended** with `writes_disabled?: boolean` in all 3 return sites (success-≥1-LI, success-no-LI, catch-block). When kill switch is active, the success message gets a `— ⚠ writes disabled` suffix so the operator sees the warning at a glance in the /config Connectors tile.
- **Dual env-var alias support:** primary `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` wins via `??` coalesce; legacy `LINKEDIN_TOOLS_DISABLED` accepted as fallback per D-86 (operator backward-compat).
- **No process.env reads.** Kill-switch helper goes through `getConfig()` exclusively (D-89 + ESLint kebab/no-direct-process-env). Per-request hydration means runtime env changes are picked up on the next call without redeploy.

## Task Commits

Two atomic commits (one per task — both pre-commit-friendly):

1. **Task 1: Ship kill-switch helper + AuditResult/TestConnectionResult extensions** — `ebf72b6` (feat)
2. **Task 2: Retrofit Step -1 kill-switch on 4 write tools + manifest probe** — `217dccb` (feat)

## Files Created/Modified

Created (2):
- `src/connectors/unipile/lib/kill-switch.ts` (32 LOC) — `isWritesDisabled()` helper. Single export. Reads both env names via `getConfig`. Coalesce + truthy literal check.
- `src/connectors/unipile/lib/__tests__/kill-switch.test.ts` (104 LOC) — 8 test cases covering unset / primary-true / primary-1 / legacy-true / legacy-1 / both-set-primary-wins / falsy-strings / primary-called-first.

Modified (13):
- `src/connectors/unipile/lib/audit.ts` (+3 LOC) — appended `| "error_writes_disabled"` at the end of AuditResult union with phase-71 block comment.
- `src/connectors/unipile/lib/__tests__/audit.test.ts` (+17 LOC) — 2 new test cases: type-level assignability + source-literal grep for error_writes_disabled.
- `src/core/types.ts` (+8 LOC) — TestConnectionResult.writes_disabled?: boolean optional field with JSDoc referencing D-88.
- `src/connectors/unipile/tools/linkedin-send-connection.ts` (+30 LOC) — `import { isWritesDisabled }` + Step -1 block inserted between `paramsHash` setup (line 204) and Step 0a account-resolve (line 206 was, now 236).
- `src/connectors/unipile/tools/linkedin-send-message.ts` (+30 LOC) — same Step -1 retrofit pattern.
- `src/connectors/unipile/tools/linkedin-send-inmail.ts` (+32 LOC) — same Step -1 retrofit (with credits=null in envelope).
- `src/connectors/unipile/tools/linkedin-engage.ts` (+34 LOC) — same Step -1 retrofit with engage's action:'skipped' envelope shape.
- `src/connectors/unipile/manifest.ts` (+10 LOC) — `import { isWritesDisabled }` + probe() return type extended + 3 return sites populate writes_disabled + success message suffix.
- `src/connectors/unipile/manifest.test.ts` (+58 LOC) — 4 new test cases (kill switch unset+success, set+success, set+no-LI, set+catch-block).
- `src/connectors/unipile/tools/__tests__/linkedin-send-connection.test.ts` (+78 LOC) — killSwitchMock plumbing + 1 Step -1 test asserting all downstream mocks NOT called.
- `src/connectors/unipile/tools/__tests__/linkedin-send-message.test.ts` (+63 LOC) — same plumbing + 1 test.
- `src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts` (+65 LOC) — same plumbing + 1 test (additionally asserts requestSendMock for balance fetch NOT called).
- `src/connectors/unipile/tools/__tests__/linkedin-engage.test.ts` (+67 LOC) — same plumbing + 1 test (asserts all 3 delegate mocks NOT called).

## Deviations from Plan

None — plan executed exactly as written.

The plan's stated test count target was ~336 total. Actual after Task 2 is 346 — the 10-test delta is purely additive (1 kill-switch.test.ts adds 8 cases + audit.test.ts adds 2 + 4 tool tests each add 1 + manifest adds 4 = 19 new; but the existing audit.test.ts already had a phase-70 enum block that I added to, so net +18 over the 328 baseline).

## Static Grep Evidence

**Positive guards (MUST be present, all confirmed):**
- `grep -c "KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED" src/connectors/unipile/lib/kill-switch.ts` → 3 (1 code + 2 comment) ✓
- `grep -c "LINKEDIN_TOOLS_DISABLED" src/connectors/unipile/lib/kill-switch.ts` → 3 ✓
- `grep -c "isWritesDisabled" src/connectors/unipile/tools/linkedin-send-connection.ts` → 2 (import + call) ✓
- `grep -c "isWritesDisabled" src/connectors/unipile/tools/linkedin-send-message.ts` → 2 ✓
- `grep -c "isWritesDisabled" src/connectors/unipile/tools/linkedin-send-inmail.ts` → 2 ✓
- `grep -c "isWritesDisabled" src/connectors/unipile/tools/linkedin-engage.ts` → 2 ✓
- `grep -c "isWritesDisabled" src/connectors/unipile/manifest.ts` → 2 ✓
- `grep -c "error_writes_disabled" src/connectors/unipile/lib/audit.ts` → 1 (the union literal) ✓
- `grep -c "writes_disabled" src/connectors/unipile/manifest.ts` → 6 (type + assignment + 3 return sites + message suffix template) ✓

**Negative guards (MUST be absent, all confirmed):**
- `grep -v "^[[:space:]]*\*" src/connectors/unipile/lib/kill-switch.ts | grep "process\\.env"` → ZERO non-comment lines ✓ (D-89 guard)
- `grep "isWritesDisabled" src/connectors/unipile/tools/linkedin-get-relationship-status.ts` → ZERO (read tool unchanged) ✓
- `grep "isWritesDisabled" src/connectors/unipile/tools/linkedin-list-pending.ts` → ZERO (read tool unchanged) ✓
- `grep -E "TwentyAdapter|notifyEvent|whatsapp_send|toolCount: 7"` in modified files → ZERO ✓
- `git diff src/connectors/unipile/tools/linkedin-get-relationship-status.ts src/connectors/unipile/tools/linkedin-list-pending.ts` → 0 lines (read tools 100% unchanged) ✓

## Test Suite Status

- **Before plan:** 328 tests (phase 70 baseline)
- **After plan:** 346 tests in unipile suite (+18)
  - `lib/__tests__/kill-switch.test.ts` (new) — 8 tests
  - `lib/__tests__/audit.test.ts` — +2 tests (phase-71 enum extension)
  - `tools/__tests__/linkedin-send-connection.test.ts` — +1 test (Step -1)
  - `tools/__tests__/linkedin-send-message.test.ts` — +1 test
  - `tools/__tests__/linkedin-send-inmail.test.ts` — +1 test
  - `tools/__tests__/linkedin-engage.test.ts` — +1 test
  - `manifest.test.ts` — +4 tests (kill switch unset / set+success / set+no-LI / set+catch)
- **Result:** 346 passed, 0 failed
- **TypeScript:** `npx tsc --noEmit` clean
- **Pre-commit hooks:** PASS on both commits — lint-staged + prettier + eslint + contract-test (97 tools / 17 connectors unchanged) + doc-counts gate (97 tools / 17 connectors) + typecheck

## KV Allowlist

NO change required. The kill-switch helper has no KV access at all (it only reads env via `getConfig`), and the 4 tool retrofits reuse the existing `writeAuditRow` path (already allowlisted from phase 68). Confirmed: `tests/contract/kv-allowlist.test.ts` passes unchanged.

## Backward Compatibility

- Existing 328 phase-70 tests all still pass — kill-switch mocks default to `false` in every test file's `resetMocks()`, so the Step -1 gate is invisible to pre-71 test paths.
- TestConnectionResult new field is optional — every other connector (apify, slack, github, etc.) compiles unchanged without surfacing `writes_disabled`.
- Manifest probe still returns the same shape minus the new optional field for callers that don't read it.
- Read tools (get_relationship_status, list_pending) UNCHANGED — kill switch only refuses WRITES per D-86 design.

## Self-Check: PASSED

- `src/connectors/unipile/lib/kill-switch.ts` exists ✓
- `src/connectors/unipile/lib/__tests__/kill-switch.test.ts` exists ✓
- Commit `ebf72b6` present in git log ✓
- Commit `217dccb` present in git log ✓
- All 346 unipile tests pass ✓
- TypeScript clean ✓
- Pre-commit hooks passed on both commits ✓
