---
phase: 68-unipile-foundation
plan: 02
subsystem: connector-sdk-foundation
tags: [unipile, sdk-singleton, retry, error-taxonomy, exponential-backoff]

# Dependency graph
requires:
  - phase: 48-config-facade
    provides: getConfig() facade pattern enforcing no direct process.env reads
  - phase: 68-unipile-foundation
    provides: 68-01 — unipile-node-sdk@1.9.3 installed + stub manifest landed
provides:
  - getUnipileClient() lazy singleton (memoized per warm lambda)
  - __resetUnipileClientForTests() test-isolation seam
  - sanitizeUnipileText() — T-68-02-01 token-redaction helper
  - withRetry<T>() exponential-backoff helper (429/5xx, max 3 attempts, ±20% jitter)
  - 4 typed Unipile errors (Rate-Limit, Account-Restricted, Not-Connected, 5xx) + classifyUnipileError mapper
  - UnipileErrorResult discriminated union type for audit log writer (Plan 04)
affects: [68-03-identifiers, 68-04-audit, 68-05-crm-bridge, 68-06-tools]

# Tech tracking
tech-stack:
  added: []  # all primitives layered on already-installed unipile-node-sdk@1.9.3
  patterns:
    - "Hand-rolled exponential backoff (200ms · 2^n · ±20% jitter) — SDK ships no native retry middleware per RESEARCH §Don't Hand-Roll, p-retry/async-retry rejected as bundle bloat for ~30 lines"
    - "Fail-safe error classifier defaulting to error_unipile_5xx on any unparseable input — RESEARCH §Pitfall 4 + Assumption A2; loud 'unknown upstream' over silent success or misleading 'not_connected'"
    - "vi.hoisted() pattern re-applied to retry + errors tests (mock-factory hoisting trap is now canonical knowledge — see Plan 01 SUMMARY)"

key-files:
  created:
    - src/connectors/unipile/lib/client.ts
    - src/connectors/unipile/lib/retry.ts
    - src/connectors/unipile/lib/errors.ts
    - src/connectors/unipile/lib/__tests__/client.test.ts
    - src/connectors/unipile/lib/__tests__/retry.test.ts
    - src/connectors/unipile/lib/__tests__/errors.test.ts
  modified: []

key-decisions:
  - "ErrorCode adaptation — plan sketch referenced ErrorCode.AUTH / ErrorCode.UPSTREAM but src/core/errors.ts exposes AUTH_FAILED / EXTERNAL_API_ERROR. Used actual enum members per plan's explicit authorization (action block guidance: 'do NOT invent new enum members')"
  - "All 3 lib files placed under src/connectors/unipile/lib/ — matches apify convention (apify/lib/client.ts). PATTERNS.md proposed a top-level deviation for client.ts; plan overrode that on 2026-05-18 to keep consistency. Honored."
  - "Logger tag: only client.ts uses getLogger('CONNECTOR:unipile'). retry.ts and errors.ts are pure — no logging, so no tag (callers that log MUST use sanitizeUnipileText() before stringifying SDK errors)"
  - "Test-only mock state via vi.hoisted() for retry.ts and errors.ts (FakeUnsuccessful class shared between mock factory and assertions for instanceof checks)"

patterns-established:
  - "Connector-scoped error classes — typed McpToolError subclasses live colocated with the connector (src/connectors/unipile/lib/errors.ts) rather than extending src/core/connector-errors.ts. Keeps core untouched + lets future connectors follow the same layout without core churn."
  - "exactOptionalPropertyTypes-safe mock body construction: build `{}` vs `{ status }` conditionally so `status?: number` typed bodies don't gain an explicit `undefined` (vitest 4.x + tsc strict mode quirk)"
  - "Detached rejection assertion before vi.runAllTimersAsync() — when a withRetry-style helper awaits inside a setTimeout, attach the rejection assertion via `const assertion = expect(p).rejects...` BEFORE running timers, then `await assertion` afterward. Prevents stray unhandled-rejection logs in vitest output."

requirements-completed: [UNI-02]

# Metrics
duration: ~10 min
completed: 2026-05-18
---

# Phase 68 Plan 02: Unipile SDK Foundation Primitives Summary

**Wave 2 unblocked — getUnipileClient() lazy singleton + withRetry() exp-backoff + classifyUnipileError() error taxonomy shipped in 3 atomic commits. 31 tests pass (7 client + 6 retry + 18 errors), typecheck clean, lint clean, no process.env leaks, contract+doc-counts gates green.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-18T17:14:00Z (file reads after Plan 01 SUMMARY commit a92dfb0 at 17:13:59)
- **Completed:** 2026-05-18T17:23:18Z (post-Task 3 commit ebcf2f9)
- **Tasks:** 3 / 3
- **Files created:** 6 (3 source + 3 tests)
- **Files modified:** 0
- **Lines added:** ~440 (client.ts 75, retry.ts 50, errors.ts 130, client.test 90, retry.test 75, errors.test 110)

## Accomplishments

- **Lazy SDK singleton shipped.** `getUnipileClient()` memoizes the `UnipileClient` instance per warm lambda — second call returns cached instance, SDK constructor called once. Missing env throws clearly *before* invoking the SDK constructor (no half-initialized client). `__resetUnipileClientForTests()` mirrors `resetHydrationFlag()` from credential-store.ts:171 for test isolation. `sanitizeUnipileText()` redacts the live `UNIPILE_TOKEN` from arbitrary error strings (T-68-02-01 mitigation).
- **withRetry helper.** ~30 lines per RESEARCH §Pattern 2 verbatim. Retries on 429/502/503/504 up to 3 attempts with exponential backoff + ±20% jitter (~200ms, ~400ms, ~800ms). Non-SDK errors and 400/403/404/422 throw immediately on attempt 1. Tests use `vi.useFakeTimers()` so the natural ~1.4s wall-clock collapses to ~0ms.
- **Error taxonomy.** 4 typed `McpToolError` subclasses + `classifyUnipileError()` mapper covering 9 status/type combinations: 429 → rate_limit, 422 with `cannot_resend*` → rate_limit (LinkedIn-side cap), 401/403 → account_restricted, 404 → not_connected, ≥500 → 5xx. Fail-safe default for non-SDK errors and malformed bodies returns `error_unipile_5xx` ("loud unknown" beats "silent success" per RESEARCH §Pitfall 4).
- **Plan 04's `UnipileErrorResult` type exported.** Audit log writer can `import { UnipileErrorResult } from "../lib/errors"` and slot it into the audit row's `result` discriminated union without redefining the enum.
- **All gates green.** lint (0 errors), typecheck (0 errors), contract test PASS (17 connectors / 90 tools unchanged), doc-counts PASS (no drift), pre-commit hooks ran on every commit.

## Error Taxonomy Table

| HTTP Status | Body `type` field | classifyUnipileError() returns | Typed error class to throw |
| ----------- | ----------------- | ------------------------------ | -------------------------- |
| 429 (Too Many Requests) | any | `error_rate_limit` | `UnipileRateLimitError` (retryable) |
| 422 (Unprocessable) | contains `cannot_resend` | `error_rate_limit` | `UnipileRateLimitError` (retryable) — LinkedIn-side daily cap |
| 422 (Unprocessable) | other | `error_unipile_5xx` | `Unipile5xxError` (retryable) — fallback for validation errors |
| 401 (Unauthorized) | any | `error_account_restricted` | `UnipileAccountRestrictedError` (terminal) |
| 403 (Forbidden) | any | `error_account_restricted` | `UnipileAccountRestrictedError` (terminal) |
| 404 (Not Found) | any | `error_not_connected` | `UnipileNotConnectedError` (terminal) |
| ≥500 (5xx) | any | `error_unipile_5xx` | `Unipile5xxError` (retryable) |
| non-`UnsuccessfulRequestError` (plain Error, null, string, undefined) | n/a | `error_unipile_5xx` | `Unipile5xxError` (fail-safe default) |
| malformed body (status not a number, body missing) | n/a | `error_unipile_5xx` | `Unipile5xxError` (fail-safe default) |

Note: the `success` and `unverified_timeout` enum values from the full audit-log result enum (D-15) are written by the *caller* (Plan 06's tool handler), not by this classifier — `classifyUnipileError` is strictly the "something went wrong" mapper.

## Retry Contract

| Property | Value |
| -------- | ----- |
| Retryable HTTP statuses | `429, 502, 503, 504` |
| Non-retryable HTTP statuses | `400, 403, 404, 422` (any type), all others |
| Non-SDK errors (plain `Error`, network failures) | Never retried (throw on attempt 1) |
| Max attempts (default) | `3` |
| Max attempts (override) | `opts.max` |
| Base delay (default) | `200ms` |
| Base delay (override) | `opts.baseMs` |
| Backoff formula | `baseMs * 2^(attempt-1) * (0.8 + Math.random() * 0.4)` |
| Worst-case wall-clock (max=3, default base) | ~1.4s before final throw (well inside Vercel 60s lambda budget) |
| Final attempt's error | Propagated as-is (no wrapping) |

## Task Commits

Each task atomic with green pre-commit hooks (lint-staged + test:contract + test:doc-counts + typecheck):

1. **Task 1 — Lazy UnipileClient singleton + sanitize + reset** — `ce030ad` (feat)
   - Changed: `src/connectors/unipile/lib/client.ts` (created), `src/connectors/unipile/lib/__tests__/client.test.ts` (created)
   - Gates: 7/7 client tests PASS; typecheck clean; contract PASS; doc-counts PASS; lint clean.
2. **Task 2 — withRetry helper** — `3c9cab6` (feat)
   - Changed: `src/connectors/unipile/lib/retry.ts` (created), `src/connectors/unipile/lib/__tests__/retry.test.ts` (created)
   - Gates: 6/6 retry tests PASS in ~600ms (fake timers); typecheck clean (after exactOptionalPropertyTypes fix); contract PASS; doc-counts PASS; lint clean.
3. **Task 3 — Typed errors + classifyUnipileError** — `ebcf2f9` (feat)
   - Changed: `src/connectors/unipile/lib/errors.ts` (created), `src/connectors/unipile/lib/__tests__/errors.test.ts` (created)
   - Gates: 18/18 errors tests PASS (12 classify + 6 typed-class); typecheck clean; contract PASS; doc-counts PASS; lint clean.

**Plan metadata commit (this SUMMARY + STATE.md + ROADMAP.md):** pending after self-check.

_Note: Each task carried `tdd="true"` at the task level. Followed RED → GREEN cycle in spirit (test file written first, implementation file written after the RED run confirmed failures), but committed the RED+GREEN pair atomically per task rather than as separate commits. Reason: the test files are scaffolding-only for these small primitives — splitting into separate RED and GREEN commits would have been pure ceremony. Same trade-off Plan 01 documented for transparency._

## Decisions Made

- **ErrorCode adaptation (AUTH → AUTH_FAILED, UPSTREAM → EXTERNAL_API_ERROR).** The plan sketch and RESEARCH.md both referenced enum members that don't exist in `src/core/errors.ts`. The actual exports are `AUTH_FAILED`, `RATE_LIMITED`, `TIMEOUT`, `INVALID_INPUT`, `EXTERNAL_API_ERROR`, `NOT_FOUND`, `PERMISSION_DENIED`, `CONFIGURATION_ERROR`. Mapped: `AUTH` → `AUTH_FAILED` (account-restricted), `UPSTREAM` → `EXTERNAL_API_ERROR` (5xx). The plan's `<action>` block explicitly authorized this adaptation ("do NOT invent new enum members in this plan — that would touch `src/core/errors.ts` and break the plan's `files_modified` scope"). No core changes made.
- **All 3 lib files under `src/connectors/unipile/lib/`.** PATTERNS.md originally suggested `client.ts` should live at the top level (deviation from apify convention), but the plan overrode that on 2026-05-18 to keep consistency with the apify analog. Honored — `client.ts` lives under `lib/` alongside `retry.ts` and `errors.ts`.
- **No logger tag in retry.ts / errors.ts.** Only `client.ts` uses `getLogger("CONNECTOR:unipile")`. The retry helper is intentionally silent (caller decides whether to log); the error classifier is a pure function (no side effects). Caller logging that surfaces SDK error strings MUST use `sanitizeUnipileText()` first (T-68-02-02 documented in plan threat model — "logging is the caller's responsibility").
- **Detached rejection assertion before `vi.runAllTimersAsync()`.** Discovered while running the retry suite — when a Promise-returning function awaits inside a `setTimeout` that gets fast-forwarded, the rejection lands BEFORE the test body attaches its `.rejects` matcher, causing vitest to log a stray unhandled-rejection. Fix: `const assertion = expect(p).rejects.toBeInstanceOf(...)` BEFORE `await vi.runAllTimersAsync()`, then `await assertion` afterward. Documented in patterns-established.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] vi.mock hoisting trap in retry.test.ts**
- **Found during:** Task 2 (first test run)
- **Issue:** `class FakeUnsuccessful extends Error` declared at top level, referenced in `vi.mock("unipile-node-sdk", () => ({UnsuccessfulRequestError: FakeUnsuccessful}))`. Vitest hoists `vi.mock` factories above top-level decls → `ReferenceError: Cannot access 'FakeUnsuccessful' before initialization`.
- **Fix:** Wrap class in `vi.hoisted(() => ({ FakeUnsuccessful }))` and reference `hoist.FakeUnsuccessful` in the mock factory. Re-export the class from the hoist for test-body `instanceof` checks. Same exact pattern Plan 01 documented in its SUMMARY.
- **Files modified:** `src/connectors/unipile/lib/__tests__/retry.test.ts` (test infrastructure only)
- **Verification:** `npx vitest run src/connectors/unipile/lib/__tests__/retry.test.ts` → 6/6 PASS.
- **Committed in:** `3c9cab6` (Task 2 commit — folded with RED+GREEN).

**2. [Rule 3 — Blocking] Stray unhandled-rejection in "max attempts" retry test**
- **Found during:** Task 2 (second test run after fix #1)
- **Issue:** Test pattern was `const p = withRetry(...); await vi.runAllTimersAsync(); await expect(p).rejects.toBeInstanceOf(...)`. Vitest reported 6/6 PASS but ALSO surfaced a serialized error from "throws after max attempts exhausted on persistent 429" — the rejection lands during `runAllTimersAsync()` execution before the `.rejects` matcher is attached.
- **Fix:** Restructured to `const assertion = expect(p).rejects.toBeInstanceOf(...); await vi.runAllTimersAsync(); await assertion;` — attaches the rejection handler BEFORE timers run.
- **Files modified:** `src/connectors/unipile/lib/__tests__/retry.test.ts` (test-only)
- **Verification:** Clean output, no stray errors.
- **Committed in:** `3c9cab6` (Task 2 commit — folded).

**3. [Rule 1 — Bug] `exactOptionalPropertyTypes` incompatibility in FakeUnsuccessful**
- **Found during:** Task 2 pre-commit typecheck (`tsc --noEmit --skipLibCheck`)
- **Issue:** `class FakeUnsuccessful { body: { status?: number }; constructor(status?: number) { this.body = { status }; } }` fails with TS2375: `Type '{ status: number | undefined; }' is not assignable to type '{ status?: number; }' with 'exactOptionalPropertyTypes: true'`. The literal `{ status }` shorthand can be `undefined`, which `status?: number` rejects.
- **Fix:** `this.body = status === undefined ? {} : { status };` — conditional construction so `status?: number` only ever sees a `number` or absence.
- **Files modified:** `src/connectors/unipile/lib/__tests__/retry.test.ts` (test infrastructure)
- **Verification:** Typecheck clean.
- **Committed in:** `3c9cab6` (Task 2 commit — folded with the two preceding test fixes).

---

**Total deviations:** 3 auto-fixed (2 × Rule 3 blocking, 1 × Rule 1 bug). All test-infrastructure or strict-mode compliance — zero scope creep, zero source-of-truth changes, zero ErrorCode core edits. Plan executed exactly as written.

## Issues Encountered

- **Three pre-existing lint warnings.** `npm run lint` surfaces 3 warnings (unused `useRef` in some custom-tools file, unused `getConfig` in `src/core/registry.ts`, unused `kvStore` in `tests/integration/multi-host.test.ts`). All pre-date this plan, none caused by my changes. Plan verification requires `lint exits 0` — warnings ≠ errors, exit code is 0, gate satisfied. Logged for future cleanup but explicitly out of scope (deviation rule: only fix issues directly caused by the current task's changes).
- **The `src/core/registry.ts` unused `getConfig`** warning specifically traces to Plan 01's registry edit (commit `99d8c39`) — flagged here for the next plan/PR to either remove or use; not fixed in this plan per scope boundary.

## User Setup Required

None — pure-library plan. No env var changes, no new dependencies, no DB/KV writes. The downstream Wave 2 plans (03, 04, 05) and Wave 3 plan (06) consume these primitives via `import { getUnipileClient, withRetry, classifyUnipileError } from "@/connectors/unipile/lib/*"`.

## Next Phase Readiness

- **Plan 03 (identifiers + URN cache + admin DELETE) — UNBLOCKED.** Can import `getUnipileClient` (for SDK calls inside `resolveProviderId`), `withRetry` (wrap `client.users.getProfile`), and `UnipileRateLimitError` / `UnipileNotConnectedError` (throw on 429 stale-read attempt and 404 missing-profile per D-10).
- **Plan 04 (audit + dedup) — UNBLOCKED.** Can import `UnipileErrorResult` type and `classifyUnipileError` to map SDK errors to the audit log's `result` field.
- **Plan 05 (crm-bridge skeleton) — UNBLOCKED.** Crm-bridge doesn't directly need these primitives but the audit-log dep chain via Plan 04 is now clear.
- **Plan 06 (linkedin tools) — UNBLOCKED via 03/04/05.** Will compose all primitives: resolve URN → withRetry(sendInvitation) → poll verify → classifyError on failure → writeAuditRow → writeOutbox.
- **No blockers. No deferred items. No threat flags.**

## Threat Flags

None — no new security-relevant surface beyond the plan's `<threat_model>` entries (`T-68-02-01..05`):

- T-68-02-01 (Info Disclosure on token-in-error-strings): MITIGATED by `sanitizeUnipileText()` — verified by `sanitizeUnipileText redacts the token value` test.
- T-68-02-02 (Info Disclosure on retry.ts logging): ACCEPTED by design — retry.ts has no logging surface, callers MUST sanitize.
- T-68-02-03 (Tampering on classifier fail-safe): MITIGATED — fail-safe default tested with null/string/undefined/corrupt body inputs.
- T-68-02-04 (DoS on persistent 429): MITIGATED — `max=3` hard cap, ~1.4s worst-case wall-clock.
- T-68-02-05 (Multi-tenant leak via singleton): ACCEPTED — UnipileClient is operator-scoped (one DSN/TOKEN per deploy), per-tenant Unipile accounts handled at `account_id` param layer (Plan 06).

## Self-Check: PASSED

Files verified present:
- `src/connectors/unipile/lib/client.ts` → FOUND (commit ce030ad)
- `src/connectors/unipile/lib/__tests__/client.test.ts` → FOUND (commit ce030ad)
- `src/connectors/unipile/lib/retry.ts` → FOUND (commit 3c9cab6)
- `src/connectors/unipile/lib/__tests__/retry.test.ts` → FOUND (commit 3c9cab6)
- `src/connectors/unipile/lib/errors.ts` → FOUND (commit ebcf2f9)
- `src/connectors/unipile/lib/__tests__/errors.test.ts` → FOUND (commit ebcf2f9)
- `.planning/phases/68-unipile-foundation/68-02-SUMMARY.md` → this file

Commits verified in git log:
- `ce030ad` feat(68-02): lazy UnipileClient singleton + sanitize + reset (Task 1) → FOUND
- `3c9cab6` feat(68-02): withRetry exponential-backoff helper (Task 2) → FOUND
- `ebcf2f9` feat(68-02): typed Unipile errors + classifyUnipileError (Task 3) → FOUND

Acceptance criteria from PLAN.md success_criteria all met:
- [x] `getUnipileClient()` returns memoized singleton; throws clearly on missing env without invoking SDK constructor (verified by `... does NOT invoke SDK constructor` tests).
- [x] `withRetry` retries 429/502/503/504 up to 3x with exponential+jitter backoff; passes through 400/403/404/422 and non-SDK errors immediately (verified by 4 dedicated tests).
- [x] `classifyUnipileError` covers 9 status/type combinations + fail-safe default; all 4 typed error classes export with correct retryable flags (verified by it.each block + 4 class-shape tests).
- [x] All 3 test files pass; combined test count = 31 (7 + 6 + 18) ≥ 26 required.
- [x] All Wave 2+ sibling plans can now import `{ getUnipileClient, withRetry, classifyUnipileError, Unipile*Error }` without changes to this plan.

Verification gauntlet (from `<verification>` block):
- [x] All 3 tasks pass automated verify commands (31/31 tests).
- [x] `npx tsc --noEmit` exits 0 across the new files.
- [x] `npm run lint` exits 0 (3 pre-existing warnings unrelated to this plan).
- [x] `npm run test:contract` exits 0 (no new kv-allowlist entries needed — none of these files call `getKVStore()`; no stray MYMCP literals).

---

*Phase: 68-unipile-foundation*
*Completed: 2026-05-18*
