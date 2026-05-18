---
gsd_state_version: 1.0
phase: 69-linkedin-writes
plan: 04
subsystem: connectors/unipile
tags: [unipile, tools, send-inmail, credits, premium-gating, balance-bracketing, escape-hatch]
requirements: [UNI-08]
dependency_graph:
  requires:
    - 69-01-SUMMARY.md
    - 69-02-SUMMARY.md
    - src/connectors/unipile/lib/account.ts
    - src/connectors/unipile/lib/rate-limiter.ts
    - src/connectors/unipile/lib/errors.ts
    - src/connectors/unipile/lib/audit.ts
    - src/connectors/unipile/lib/identifiers.ts
    - src/connectors/unipile/lib/crm-bridge.ts
    - src/connectors/unipile/lib/retry.ts
    - src/connectors/unipile/lib/client.ts
  provides:
    - linkedinSendInmailSchema
    - handleLinkedinSendInmail
  affects:
    - Wave 3 Plan 06 (manifest wiring — defineTool destructive: true; engage out-of-network branch delegates here)
tech_stack:
  added: []
  patterns:
    - "13-step handler order (D-49 + WARNING-6): allow_inmail-gate → dedup → account → balance-before → premium-gate → cap-gate → rate-limit → provider-resolve → CRM → startNewChat-inmail → balance-after → verify=providerOk → audit"
    - "Pre-flight refusals (allow_inmail, dedup, premium-gate, cap-gate) do NOT call rate-limiter (RESEARCH §4.7)"
    - "D-48 escape hatch: client.request.send({path:'/linkedin/inmail_balance', method:'GET', parameters:{account_id}}) — SDK has NO typed inmail_balance method"
    - "Credit bracketing: balance-before BEFORE send + balance-after AFTER send → credits_used = totalBefore - totalAfter, credits_remaining = totalAfter"
    - "D-28 fallback: post-send balance failure → credits_used: null, credits_remaining: null (the SEND succeeded — we just couldn't measure cost; NEVER throws)"
    - "D-29 premium gate: all-null tiers (premium === null && recruiter === null && sales_navigator === null) → error_inmail_requires_premium BEFORE rate-limit"
    - "D-29 variant: totalAvailable === 0 with non-null tier → also error_inmail_requires_premium (credits exhausted)"
    - "D-50 SDK call: messaging.startNewChat({account_id, attendees_ids:[provider_id], subject, text, options:{linkedin:{api:'classic', inmail:true}}}) — NOT users.sendInmail"
    - "D-26 defense-in-depth: schema enforces z.literal(true) AND handler runtime-checks `args.allow_inmail !== true` (raw-handler-invocation safety)"
    - "verified = providerOk (planner-discretion per PATTERNS.md L415 — no 10s message-poll for InMail; credit consumed regardless; documented for revisit in phase 71)"
key_files:
  created:
    - src/connectors/unipile/tools/linkedin-send-inmail.ts
    - src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts
  modified: []
decisions:
  - "D-26/D-27/D-28/D-29/D-48/D-50 all observable via grep + test assertions"
  - "params_hash uses note slot for joined `${subject}\\n${text}` so changing EITHER bypasses dedup (correct semantics — different subject = different InMail intent)"
  - "verified = providerOk (no message-poll) for InMail — documented inline + here for phase 71 revisit if silent-failure operator reports surface"
  - "exactOptionalPropertyTypes carry-forward (phase 68 D-13/D-14): pass {} not {account_id: undefined} when account_id unset"
  - "Inline single-line schema for `allow_inmail: z.literal(true)` to satisfy D-26 grep guard (prettier-ignore directive added)"
metrics:
  duration: "~7 min"
  completed: "2026-05-18"
  files_created: 2
  files_modified: 0
  loc_added: 1185
  tests_added: 14
  commits: 2
---

# Phase 69 Plan 04: linkedin_send_inmail Summary

Paid LinkedIn InMail tool with credit bracketing via the `client.request.send()` escape hatch (D-48), all-null premium gate (D-29), `allow_inmail: z.literal(true)` safety belt (D-26), and `max_inmail_credits` cap (D-27) — UNI-08 closed.

## Tasks Executed

### Task 1: linkedin-send-inmail.ts (13-step handler)
- **Commit:** `f63dd8c` — feat(69-04): linkedin_send_inmail — 13-step handler with balance bracketing
- **File:** `src/connectors/unipile/tools/linkedin-send-inmail.ts` (669 LOC, target was ~320 — heavy JSDoc + per-step separator headers + verbose envelope wiring across 7 terminal paths; logic surface is ~280 LOC)
- **Status:** complete, typechecks clean, all 8 grep guards pass

### Task 2: linkedin-send-inmail.test.ts (14 test cases)
- **Commit:** `ea1a87e` — test(69-04): linkedin_send_inmail — 14 test cases covering D-26..D-50
- **File:** `src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts` (516 LOC, target was ~400 — extra coverage: request.send shape contract, cap-satisfied happy path, balanceBefore 503 with withRetry timer-advance)
- **Status:** 14/14 pass; full unipile suite 187/187 green (was 173 + 14 new)

## Locked Decisions → Test Coverage Map

| Decision | Test(s) | What's Asserted |
|---|---|---|
| **D-13/D-14** — `verified` is STRICTLY boolean, never `'pending'` | Test 1 | `typeof env.verified === 'boolean'` + `env.verified as unknown !== 'pending'` |
| **D-26** — `allow_inmail: z.literal(true)` REQUIRED, defense-in-depth at handler level | Test 6 | `allow_inmail: false` (bypass-zod) → `error_inmail_not_authorized` + NO balance fetch + NO rate-limit + NO account-resolve |
| **D-27** — `max_inmail_credits` cap is PRE-FLIGHT refusal (no rate-limit burn) | Test 4, Test 4b | cap=10 vs available=5 → cap_exceeded (single balance call, no rate-limit, no send); cap=5 vs available=150 → success |
| **D-28** — post-send balance failure → credits collapse to null, send still ok | Test 5 | after-call rejects 503 → `credits_used: null, credits_remaining: null, provider_ok: true, verified: true` |
| **D-29** — premium gate (all-null tiers OR zero credits with tier present) | Test 2, Test 3 | all-null → `error_inmail_requires_premium`, `credits_remaining: 0, credits_used: null`; zero with tier → same error, `credits_used: 0, credits_remaining: 0` |
| **D-43** — `error_rate_limit_kebab` (Kebab-side cap, distinct from Unipile 429) | Test 7 | balance fetched (1 call), block → error_rate_limit_kebab, blocked_by_rate_limit: true, credits_remaining: 150 (reports measured), NO send |
| **D-48** — escape hatch: `client.request.send({path:'/linkedin/inmail_balance', ...})` | Test 1, Test 1b | requestSendMock called EXACTLY twice on happy path; call shape matches `{path, method, parameters}` contract |
| **D-49** — handler order: allow_inmail → dedup → account → balance-before → ... | Test 6, Test 8, Test 2, Test 4 | dedup hit asserts NO balance/SDK/rate-limit; allow_inmail-false asserts NO balance/SDK/rate-limit/account; premium-gate + cap-gate assert NO rate-limit + NO sendChat |
| **D-50** — SDK shape: `startNewChat({options:{linkedin:{api:'classic', inmail:true}}})` | Test 10 | `sendChatMock` called with `expect.objectContaining({options:{linkedin:{api:'classic', inmail:true}}, subject:'Quick question', text:'InMail body', attendees_ids:['urn:li:prospect']})` |
| **WARNING-6** (RESEARCH §4.7) — pre-flight refusals MUST NOT increment rate-limit counter | Test 2, Test 4, Test 6, Test 8 | All 4 pre-flight paths runtime-assert `rateLimitMock.not.toHaveBeenCalled()` |
| **Plan 01 classifier integration** — SDK 403 `inmail_requires_premium` → audit enum | Test 9 | SDK rejection in sendChat → `error_inmail_requires_premium`, `credits_used: 0, credits_remaining: 150` |
| **withRetry on balance call** — exhausted 5xx → classified error, NO send | Test 9b | persistent 503 from request.send → `error_unipile_5xx`, NO sendChat call |
| **D-20** — ≥2 LinkedIn accounts → `error_account_id_required` + `available_accounts` | Test 11 | `accountGetAll` returns 2 LI accounts → error + array; NO balance/SDK |

## Grep Guards (Acceptance Criteria)

| Guard | Expected | Actual |
|---|---|---|
| `verified:\s*['"]pending['"]` in source | 0 matches | 0 |
| `allow_inmail.*z\.literal\(true\)` (D-26 grep guard) | ≥1 line | 1 (line 147, single-line schema with `prettier-ignore`) |
| `inmail_balance` | ≥2 | 5 (path string + JSDoc references — bracket BEFORE + AFTER, both via fetchInmailBalance) |
| `request.send` (D-48 escape hatch) | ≥1 | 3 (1 call site + 2 doc refs) |
| `options.*linkedin.*inmail.*true` (D-50) | ≥1 | 1 (line 583) |
| `writeAuditRow` (terminal paths) | ≥7 | 12 (allow_inmail, dedup, account-err, balance-fetch-err, premium-all-null, premium-zero, cap-exceeded, rate-limit, provider-resolve-err, sdk-err, success — + 1 import) |
| `credits_used|credits_remaining` (every envelope sets them) | ≥10 | 31 |
| `InMail cap exceeded|Rate-limit blocked send_inmail` (WARNING-5) | ≥2 | 2 (log.warn at cap-gate + rate-limit) |

## Handler Order (D-49 + WARNING-6)

```
 1. allow_inmail-gate    — z.literal(true) at schema + runtime check at handler (D-26)
 2. dedup                — kv.get unipile:audit:hash:<paramsHash> → early-return if hit (D-49)
 3. account-resolve      — resolveAccountId({account_id?}) → error or accountId (D-20)
 4. balance-before       — client.request.send({path:'/linkedin/inmail_balance'}) (D-48)
 5. premium-gate         — all-null tiers OR totalAvailable=0 → error_inmail_requires_premium (D-29)
 6. cap-gate             — args.max_inmail_credits && totalBefore < cap → error_inmail_cap_exceeded (D-27)
 7. rate-limit           — checkUnipileRateLimit({account_id, tool:'send_inmail'}) — AFTER all pre-flight refusals
 8. provider-resolve     — resolveProviderId(profile_url, accountId) — no degree-check (InMail = cross-degree)
 9. CRM outbox           — crmBridge.writeOutbox(auditId, {crm_log})
10. SEND                 — messaging.startNewChat({options:{linkedin:{api:'classic', inmail:true}}}) (D-50)
11. balance-after        — same escape hatch, best-effort (D-28 fallback: failure → credits=null, send is OK)
12. verify = providerOk  — no 10s message-poll for InMail (planner-discretion per PATTERNS.md L415)
13. audit + envelope     — writeAuditRow(success) + SendInmailEnvelope JSON
```

Each terminal path writes exactly ONE audit row. 11 writeAuditRow call sites in handler code (+ 1 import = 12 total greps) cover: allow_inmail-not-authorized, dedup-hit, account-error, balance-fetch-error (classifier), premium-all-null, premium-zero, cap-exceeded, rate-limit-blocked, provider-resolve-error (classifier), sdk-error (classifier), and the final success row.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test 9b `mockRejectedValueOnce` exhausts before withRetry's 3 retries**
- **Found during:** Task 2 vitest run (initial test failure)
- **Issue:** `requestSendMock.mockRejectedValueOnce(new FakeUnsuccessful({status: 503}))` only rejects ONE call. `withRetry` (200/400/800ms backoff, max 3 attempts) calls the mock again on retry, gets `undefined`, and `totalCredits(undefined)` throws `Cannot read properties of undefined (reading 'premium')` BEFORE the handler can classify. Vitest reports as unhandled rejection.
- **Fix:** Switched to `requestSendMock.mockRejectedValue(...)` (persistent rejection) so ALL retries surface the same 503 → classifier sees `UnsuccessfulRequestError` → `error_unipile_5xx`.
- **Files modified:** `src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts` (Test 9b only)
- **Commit:** folded into the Task 2 commit (ea1a87e).

**2. [Rule 3 - Blocking] D-26 grep guard required single-line schema declaration**
- **Found during:** Task 1 post-write grep verification
- **Issue:** Plan acceptance criteria: `grep -nE "allow_inmail.*z\\.literal\\(true\\)" returns ≥1 line`. Initial multi-line schema (`allow_inmail: z\n  .literal(true)\n  .describe(...)`) made the regex match only the JSDoc reference, not actual code. The grep guard is enforced as a deep-work-rules constraint — having the literal be greppable as a single line is the contract.
- **Fix:** Inlined `allow_inmail: z.literal(true).describe(...)` to a single line with a `// prettier-ignore` directive above so prettier doesn't re-split it.
- **Files modified:** `src/connectors/unipile/tools/linkedin-send-inmail.ts` (lines 145-147)
- **Commit:** folded into the Task 1 commit (f63dd8c).

### Plan-Authorized Deviations

**3. [PATTERNS.md endorsement] `computeParamsHash` `note` slot re-used for `${subject}\n${text}`**
- **Source:** PATTERNS.md line 200 + 69-03-SUMMARY.md (send-message did the same with `args.text`)
- **Reason:** `computeParamsHash` signature is locked in phase 68 Plan 04 audit.ts as `{tool, profile_url_normalized, note}`. For InMail, the "user-supplied content that distinguishes this call from a re-spam" is BOTH the subject AND the body — changing either is a legitimate re-engagement. Joining them with `\n` means a 1-char change in EITHER bypasses dedup (correct semantics).
- **Documented:** JSDoc on the handler explicitly calls this out.

**4. [PATTERNS.md L415 endorsement] `verified = providerOk` (no 10s message-poll for InMail)**
- **Source:** PATTERNS.md L415 marks the InMail verify step as "planner-discretion".
- **Reason:** InMail delivery to the recipient's tray is async on LinkedIn's side; the `getAllMessagesFromChat` trick adds 10s latency to EVERY InMail (paid + low-volume = expensive). Since the credit is consumed regardless of poll outcome, being optimistic when `provider_ok = true` is the correct trade.
- **Revisit trigger:** if operators report silent InMail failures in production (recipient never sees it but credit was spent), add the 10s poll in phase 71. Documented in handler JSDoc.

### Bonus tests beyond plan minimum (4)

- **Test 1b** — `request.send` call shape contract (path/method/parameters)
- **Test 3** — D-29 variant: zero credits with non-null tier
- **Test 4b** — cap-satisfied happy path (regression guard against accidental D-27 inversion)
- **Test 9b** — balance-before 503 with withRetry timer-advance

Total: 14 tests (plan minimum was 10+).

## Authentication Gates

None — all execution against mocked SDK / KV. Live UNIPILE_DSN + UNIPILE_TOKEN credentials remain available in `.env` for Wave 3 Plan 06 live smoke test (InMail send to out-of-network profile, after manifest wiring).

## For Plan 06 (manifest wiring — Wave 3)

`linkedin_send_inmail` is ready to wire as:

```typescript
defineTool({
  name: "linkedin_send_inmail",
  description: "Send a paid LinkedIn InMail (cross-degree). Requires allow_inmail: true and a Premium/Sales Nav/Recruiter account. Returns credits_used + credits_remaining via balance bracketing.",
  destructive: true,                       // ★ DESTRUCTIVE (consumes a paid InMail credit)
  schema: linkedinSendInmailSchema,
  handler: handleLinkedinSendInmail,
});
```

ADDITIONALLY, the `linkedin_engage` super-tool's "out of network + allow_inmail: true" branch will delegate to `handleLinkedinSendInmail` directly (so the engage envelope can mirror credits_used/credits_remaining). See Plan 05 / engage routing logic for the delegation contract.

No additional setup needed — the handler is self-contained (resolves account / brackets balance / dedups / audits internally). Manifest registration alone surfaces it to the LLM.

## UNI-08 Status

**CLOSED.** Paid InMail tool shipped with:
- D-26 `allow_inmail: z.literal(true)` schema + defense-in-depth handler check
- D-27 `max_inmail_credits` cap (pre-flight refusal, no rate-limit burn)
- D-28 + D-48 balance bracketing via `client.request.send()` escape hatch — credits_used = before - after; credits collapse to null if post-send fetch fails (send is still ok)
- D-29 premium gate (all-null tiers OR zero-credits-with-tier — both refuse pre-flight)
- D-43 `error_rate_limit_kebab` + WARNING-5 observability log
- D-49 + WARNING-6 handler order (allow_inmail → dedup → account → balance → premium → cap → rate-limit → ...)
- D-50 `messaging.startNewChat({options:{linkedin:{api:'classic', inmail:true}}})` SDK shape
- 11 audit-row terminal paths covering every code branch
- 14 vitest cases covering all decision branches + runtime guards

## Self-Check: PASSED

- [x] `src/connectors/unipile/tools/linkedin-send-inmail.ts` exists (669 LOC)
- [x] `src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts` exists (516 LOC)
- [x] Commit `f63dd8c` (Task 1) found in git log
- [x] Commit `ea1a87e` (Task 2) found in git log
- [x] `npx vitest run src/connectors/unipile/tools/__tests__/linkedin-send-inmail.test.ts` → 14 passed
- [x] `npx vitest run src/connectors/unipile/` → 187 passed (was 173 + 14 new, no regressions)
- [x] `npx tsc --noEmit --skipLibCheck` → clean (full project)
- [x] `grep -nE "verified:\\s*['\"]pending['\"]" src/connectors/unipile/tools/linkedin-send-inmail.ts` → 0 matches
- [x] `grep -nE "allow_inmail.*z\\.literal\\(true\\)" src/connectors/unipile/tools/linkedin-send-inmail.ts` → 1 line (real code, not just JSDoc)
- [x] `grep -n "inmail_balance"` → ≥2 (5 actual)
- [x] `grep -n "request.send"` → ≥1 (3 actual)
- [x] `grep -nE "options.*linkedin.*inmail.*true"` → ≥1 (1 actual at line 583)
- [x] `grep -n "writeAuditRow"` → ≥7 (12 actual)
- [x] `grep -n "credits_used|credits_remaining"` → ≥10 (31 actual)
- [x] `grep -n "InMail cap exceeded|Rate-limit blocked send_inmail"` → ≥2 (2 actual)
