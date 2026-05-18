# Roadmap: MyMCP

## Current Milestone: v0.17 — Unipile Connector (LinkedIn + WhatsApp write)

**Started:** 2026-05-18
**Goal:** Ship a dedicated `src/connectors/unipile/` connector exposing 9 high-level write tools for LinkedIn (5) and WhatsApp (4). Replaces failed Browserbase-based LinkedIn write attempt per [ADR 0001](../docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md). See [v0.17 ROADMAP](milestones/v0.17-unipile-connector-ROADMAP.md) for full detail.

### Phase Overview (v0.17)

| # | Phase | Goal | Requirements | Effort |
|---|-------|------|--------------|--------|
| 68 | Unipile foundation | Client + manifest + first write E2E (send_connection + get_relationship_status) + CRM outbox + audit log | UNI-01..06 | 2.5d |
| 69 | LinkedIn writes | send_message (1st-degree), send_inmail (explicit), engage (super-tool + dry_run), list_pending, rate-limiter | UNI-07..11 | 2d |
| 70 | Webhooks ingress (scope corrected 2026-05-18 — WhatsApp DROPPED to backlog) | Dedicated `/api/unipile/webhook` + 3 event handlers + halt-flag retrofit on 4 LinkedIn write tools | UNI-12..15 | 1.5d |
| 71 | Hardening | Kill switches, metrics, audit query API, docs, multi-tenant verification | UNI-20..24 | 1.5d |

## Active Phase

### Phase 71: Hardening (FINAL phase of v0.17 milestone)

**Goal:** Polish + hardening of the Unipile connector. Ship 5 deliverables: (1) UNI-20 global kill switch (`KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` + legacy `LINKEDIN_TOOLS_DISABLED`) refusing all 4 LinkedIn write tools at Step -1 (BEFORE Step 0a account-resolve), with `error_writes_disabled` audit result + `writes_disabled` surfaced in `testConnection()`. (2) UNI-21 admin quota metrics — 2 new REST routes (`GET /api/admin/metrics/unipile-quotas` + `.../summary`) reading the existing phase-69 rate-limiter KV counters. (3) UNI-22 audit query API — `GET /api/admin/audit/unipile` with base64-cursor pagination + 4 optional filters. (4) UNI-23 docs — first-ever `docs/connectors/unipile.md` (60s Quick Start + setup + 6-tool catalog + rate limits + kill switches + halt flag + troubleshooting). (5) UNI-24 multi-tenant smoke test procedure — documented as Appendix in the new doc (operator-executed, not automated per D-102).

**SCOPE NOTE (carry-forward):** Manifest stays at 6 tools (NO new MCP tools). NO new WhatsApp work. NO TwentyAdapter outbound HTTP. NO cron entries. All 3 new admin routes are tenant-scoped via `getContextKVStore()` (D-96 — no `?scope=all` escape hatch) → NO kv-allowlist entries (PATTERNS misalignment #1 explicitly honored — CONTEXT line 128 was wrong). `docs/CONNECTORS.md` is a conventions reference (no connector-index table to update — PATTERNS misalignment #2); a "Reference: per-connector docs" section is appended instead.

**Requirements:** UNI-20, UNI-21, UNI-22, UNI-23, UNI-24

**Depends on:** Phase 70 (halt-flag for the Step -1 ordering precedent) + Phase 69 (rate-limiter KV counters that the metrics routes read) + Phase 68 (audit row layout that the audit-query route scans)

**Plans:** 3 plans

Plans:
- [x] 71-01-PLAN.md — Wave 1: Kill switch foundation — NEW `src/connectors/unipile/lib/kill-switch.ts` exporting `isWritesDisabled()` (reads `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` + legacy `LINKEDIN_TOOLS_DISABLED` via `getConfig()` per D-89) + AuditResult union extension (`+ "error_writes_disabled"` appended at end per phase-70 D-78 precedent) + `TestConnectionResult.writes_disabled?: boolean` field on `src/core/types.ts` + Step -1 retrofit on all 4 LinkedIn write tools (send_connection, send_message, send_inmail, engage) inserted BEFORE Step 0a account-resolve + `manifest.ts::probe()` extended to surface `writes_disabled` in testConnection envelope + 18 new tests across kill-switch + audit + 4 tool files + manifest (UNI-20) — completed 2026-05-19 (2 commits: ebf72b6, 217dccb; SUMMARY: 71-01-SUMMARY.md). 346/346 unipile tests green. UNI-20 CLOSED.
- [ ] 71-02-PLAN.md — Wave 2: Admin REST routes (depends on 01 for AuditResult extension type) — Promote rate-limiter's `getCaps` + 4 bucket helpers (`dailyBucket`/`isoWeekBucket`/`nextUtcMidnight`/`nextMondayUtc`) to public exports (zero behavior change) + NEW `app/api/admin/metrics/unipile-quotas/route.ts` (per-account/per-tool quota read with daily+weekly+reset_at+percent_used) + NEW `app/api/admin/metrics/unipile-quotas/summary/route.ts` (current-day matrix across all accounts × tools, tenant-scoped) + NEW `app/api/admin/audit/unipile/route.ts` (cursor-paginated audit query with account_id/since/tool/result filters, base64-encoded audit_id cursor per D-95, default limit 50 max 200, skips `:hash:` dedup pointers, defensive invalid-cursor fallback to page 1) — ALL 3 routes tenant-scoped via `getContextKVStore()` + admin-auth via `withAdminAuth` + 30s (metrics) / 10s (audit) Cache-Control + ZERO kv-allowlist changes (PATTERNS #1) + ~15 new tests across 3 routes (UNI-21 + UNI-22)
- [ ] 71-03-PLAN.md — Wave 2: Documentation (depends on 01 for kill-switch env var name + AuditResult member; parallel with 02 — disjoint files) — NEW `docs/connectors/unipile.md` (~200-250 lines): Overview + ADR-0001 link + 60s Quick Start + Setup (env vars + dashboard + webhooks) + Tools catalog (6 tools, descriptions copied VERBATIM from manifest.ts `defineTool` blocks) + Rate limits table + Kill switches section + Halt flag section + Audit query section + Troubleshooting table (≥6 error codes) + Appendix: Multi-tenant smoke test procedure (D-101 6 steps verbatim per D-102 — operator-executed) + MOD `.env.example` (extend Unipile block with kill switch + legacy alias + webhook secret + 5 rate-limit cap overrides + fail-mode escape hatch + naming-asymmetry comment per PATTERNS #4, all commented-out) + MOD `docs/CONNECTORS.md` (append "Reference: per-connector docs" section linking to new doc per PATTERNS #2 — NO connector-index table to update) — NO tests, NO source code, NO tool count change (UNI-23 + UNI-24)

**Wave structure:** Wave 1 single (01 — kill-switch foundation + 4-tool Step -1 retrofit + manifest probe extension; produces `error_writes_disabled` AuditResult + `isWritesDisabled` helper consumed by Wave 2). Wave 2 parallel (02 + 03 — disjoint files: 02 touches admin routes + rate-limiter exports; 03 touches docs + .env.example. Both depend on 01 for the type/enum extensions surfaced in their content but neither modifies the same files as the other).

---

## Completed Phases (current milestone)

### Phase 70: Webhooks Ingress (SCOPE CORRECTED 2026-05-18 — WhatsApp DROPPED)

**Goal:** Build the inbound webhook ingress + halt-flag retrofit. Ship `/api/unipile/webhook` (dedicated route, dual-mode HMAC + static verifier, 24h idempotency, fire-and-forget dispatch) + 3 INGRESS event handlers that mutate INTERNAL connector state ONLY (`account_status` sets/clears halt flag in KV; `new_relation` enriches audit row with `accepted_at`; `new_message` enriches audit row with `last_replied_at` while SKIPPING `is_sender:true` echoes and persisting ONLY SHA-256 content_hash). Retrofit the 4 already-shipped LinkedIn write tools with a NEW Step 0 halt-flag pre-flight gate (D-65/D-66 — BEFORE D-49 dedup-first).

**SCOPE CORRECTION 2026-05-18:** WhatsApp tool suite (UNI-16..19) dropped from phase 70. Reason: core need is LinkedIn connect + DM (covered by phase 68/69). WhatsApp not immediately demanded — deferred to post-milestone backlog. Manifest stays at 6 tools (no toolCount bump). No new WhatsApp source files. Docs/README unchanged (still 97 tools). No `lib/halt.ts` wrapper — the already-shipped `src/connectors/unipile/webhook/halt-flag.ts` is the single source of truth used directly by the retrofit.

**SCOPE NOTE:** The connector is a STATELESS MCP TRANSPORT. It does NOT push events to external systems. NO `TwentyAdapter`, NO `UNIPILE_CRM_WEBHOOK_URL` outbound POST, NO `unipile-crm-retry` cron. The future audit query tool (UNI-22, phase 71) is how callers pull state mutations out — caller polls audit, decides what to call next on Twenty/HubSpot/etc.

**Requirements:** UNI-12, UNI-13, UNI-14, UNI-15

**Depends on:** Phase 69 (LinkedIn writes — retrofit targets) + Phase 68 (audit/dedup/CRM-bridge-skeleton/identifiers)

**Plans:** 3 plans

Plans:
- [x] 70-01-PLAN.md — Wave 1: Webhook foundation — `app/api/unipile/webhook/route.ts` (dual-mode HMAC + static verifier per D-52, 24h KV idempotency per D-54, fire-and-forget dispatch per D-55, 503 on missing secret) + `src/connectors/unipile/webhook/{verifier,dispatcher,halt-flag,account-tenant-index}.ts` + `scripts/setup-unipile-webhooks.ts` (idempotent bootstrap; uses SDK escape hatch for `users` source per D-68) + 2 NEW kv-allowlist entries (webhook route + account-tenant reverse index) (UNI-12) — completed 2026-05-18 (SUMMARY: 70-01-SUMMARY.md). UNI-12 CLOSED.
- [x] 70-02-PLAN.md — Wave 2: 3 INGRESS handlers (depends on 70-01) — `webhook/handlers/{account-status,new-relation,new-message}.ts` (write halt flag on credentials_expired/restricted/disconnected per D-57, CLEAR on OK/RECONNECTED per D-58; enrich audit row with accepted_at per D-61 with inbound_accept_unknown_origin fallback; enrich audit row with last_replied_at per D-63 + SHA-256 hash-only persistence per D-64) + `lib/audit.ts` (+3 AuditResult members per D-78) + `handlers/index.ts` side-effect barrel (UNI-13 ingress, UNI-14, UNI-15) — completed 2026-05-19 (2 commits: 2ee4723, e9df4f7; SUMMARY: 70-02-SUMMARY.md). UNI-14 + UNI-15 CLOSED; UNI-13 ingress side closed (write side still pending until 70-03).
- [x] 70-03-PLAN.md — Wave 3: Halt-check retrofit on 4 LinkedIn write tools (depends on 70-01, 70-02) — Insert Step 0 `await readHaltFlag(accountId)` at the TOP of `linkedin-send-connection.ts`, `linkedin-send-message.ts`, `linkedin-send-inmail.ts`, `linkedin-engage.ts` (BEFORE existing dedup / SDK / rate-limit / balance per D-65/D-66). Halted accounts return `error_account_halted` envelope + single audit row, NO further calls. +1 test per tool (4 new tests total) asserting halt short-circuit. NO manifest/registry/docs change. NO new `lib/halt.ts` — uses the already-shipped `webhook/halt-flag.ts` directly. NO WhatsApp anywhere. (UNI-13 closure) — completed 2026-05-19 (1 commit: 377da01; SUMMARY: 70-03-SUMMARY.md). 328/328 unipile tests green (+5 new). UNI-13 CLOSED end-to-end. Phase 70 CODE-COMPLETE.

**Wave structure:** Wave 1 single (01 unblocks Wave 2 — SHIPPED). Wave 2 single (02 — handlers consume halt-flag write side). Wave 3 single (03 — retrofits 4 LinkedIn write tools to consume halt-flag read side; depends on 01 for the helper + 02 for the AuditResult enum member).

---

### Phase 69: LinkedIn Writes

**Goal:** Complete the LinkedIn write tool suite started in phase 68. Ship 4 new tools (`linkedin_send_message` 1st-degree DM with attachments + verify-after-write, `linkedin_send_inmail` explicit paid with credits bracketing + premium gate, `linkedin_engage` super-tool with degree-based routing + dry_run, `linkedin_list_pending` cleanup helper) + 1 KV-backed per-account rate-limiter (fail-closed by default, daily/weekly windows, env-overridable caps). Retrofit `linkedin_send_connection` (phase 68) with the rate-limiter. Close 2 phase-68 backlog items (UNI-25 URL query string + UNI-26 4xx mis-classification). Bump manifest toolCount 2 → 6.

**Requirements:** UNI-07, UNI-08, UNI-09, UNI-10, UNI-11, UNI-25, UNI-26

**Depends on:** Phase 68 (foundation: client, retry, errors, identifiers, audit, dedup, CRM-bridge, send_connection)

**Plans:** 6 plans

Plans:
- [x] 69-01-PLAN.md — Wave 1: Foundation extensions — lib/errors.ts (+5 classes UnipileInmail* + UnipileRecipientUnreachable + UnipileInvalidRequest + UnipileAttachmentTooLarge, +3 enum members, +4 classifyUnipileError branches) + lib/audit.ts (+9 AuditResult members incl. dry_run + error_rate_limit_kebab) + lib/identifiers.ts (SLUG_RE +query/+fragment per D-44) + NEW lib/account.ts (extracted resolveAccountId — anti-drift across 4 tools) (UNI-25, UNI-26) — completed 2026-05-18 (3 commits: f4069ac, e66fdb8, f0d46cf; SUMMARY: 69-01-SUMMARY.md). 146/146 unipile tests green. UNI-25 + UNI-26 backlog closed.
- [x] 69-02-PLAN.md — Wave 1: lib/rate-limiter.ts — per-account/per-tool day+week KV counters, fail-closed default (D-40), env-overridable caps (D-39: 25/100/50/15 defaults), retry_after as ISO timestamps + 12+ tests covering all 4 D-40 paths (UNI-11) — completed 2026-05-18 (3 commits: 656f564, e021f8b, 430525a; SUMMARY: 69-02-SUMMARY.md). 14 tests added (160 → 174 wait 160/160 unipile).
- [x] 69-03-PLAN.md — Wave 2: tools/linkedin-send-message.ts — 9-step handler (dedup→account→attachment-decode→degree-check→rate-limit→CRM→startNewChat→verify→audit per D-49 + WARNING-6 retrofit), 1st-degree gate (D-22), attachments {filename,mimetype,base64}→[filename,Buffer] tuples (D-46), verify-after-write via getAllMessagesFromChat polling (D-47) + 13 tests covering all decision branches + runtime guards for pre-flight refusal paths (UNI-07) — completed 2026-05-18 (2 commits: 0531e35, f8019bd; SUMMARY: 69-03-SUMMARY.md). 173/173 unipile tests green. Manifest wiring deferred to Wave 3 Plan 06.
- [x] 69-04-PLAN.md — Wave 2: tools/linkedin-send-inmail.ts — 13-step handler with balance bracketing (D-48 escape hatch via client.request.send), allow_inmail literal(true) gate (D-26), max_inmail_credits cap (D-27), premium gate via inmail_balance all-null check (D-29), startNewChat with options.linkedin.inmail=true (D-50), credits_used/credits_remaining derived from balance-before vs balance-after (D-28 fallback to null on post-send fetch failure) + 10+ tests (UNI-08) — completed 2026-05-18 (SUMMARY: 69-04-SUMMARY.md).
- [x] 69-05-PLAN.md — Wave 2: tools/linkedin-list-pending.ts — read-only paginated cursor loop over getAllInvitationsSent, age_days computed client-side from parsed_datetime, older_than_days client-side filter (D-35, SDK has NO since param), default limit 100 max 500 (D-36), destructive: false (D-37) + 7+ tests (UNI-10) — completed 2026-05-18 (SUMMARY: 69-05-SUMMARY.md).
- [x] 69-06-PLAN.md — Wave 3: tools/linkedin-engage.ts super-tool — degree-routed dispatcher (D-31), dry_run early-return BEFORE provider calls (D-32) writes audit row with result: 'dry_run' (D-33), delegates to send_message/send_connection/send_inmail handlers + BLOCKER-1 inmail_subject param + skipped_no_inmail_subject branch + RETROFIT send_connection.ts (D-49 dedup-FIRST rate-limit insert) + manifest wiring (4 new defineTool entries, toolCount 2→6) + registry.ts toolCount bump + content/docs/connectors.md + README.md tool count updates 93→97 (UNI-09 + UNI-07/08/10/11 wiring) — completed 2026-05-18 (3 commits: 2371ad8, ffb99b1, d87d19d; SUMMARY: 69-06-SUMMARY.md). 228/228 unipile tests + 1510-test full suite green. Phase 69 COMPLETE.

**Wave structure:** Wave 1 parallel (01, 02 — no inter-dep). Wave 2 parallel (03, 04, 05 — all depend on Wave 1 outputs). Wave 3 single (06 — depends on Waves 1+2; super-tool delegates to all 3 Wave-2 handlers).


---

### Phase 68: Unipile Foundation

**Goal:** Wire Unipile SDK into Kebab as a new connector. Ship the first write tool (`linkedin_send_connection`) end-to-end with verify-after-write, dedup, audit log, and Twenty CRM outbox. Re-validate the Antoine Vercken connect flow that failed 2026-05-18 with Browserbase.

**Requirements:** UNI-01, UNI-02, UNI-03, UNI-04, UNI-05, UNI-06

**Depends on:** ADR 0001 (decided 2026-05-18)

**Plans:** 6 plans

Plans:
- [x] 68-01-PLAN.md — Wave 1: Install unipile-node-sdk@^1.9.3, scaffold stub manifest (0 tools) + manifest tests + lazy registry entry (toolCount: 0); unblocks parallel Wave 2 (UNI-01) — completed 2026-05-18 (3 commits: f67bcf4, ab0e3e2, 99d8c39; SUMMARY: 68-01-SUMMARY.md)
- [x] 68-02-PLAN.md — Wave 2: client.ts lazy UnipileClient singleton + sanitize/reset helpers + lib/retry.ts (exp backoff on 429/5xx, max 3) + lib/errors.ts (4 typed classes + classifyUnipileError taxonomy) (UNI-02) — completed 2026-05-18 (3 commits: ce030ad, 3c9cab6, ebcf2f9; SUMMARY: 68-02-SUMMARY.md)
- [x] 68-03-PLAN.md — Wave 2: lib/identifiers.ts URL normalize (D-12 4 variants + locale prefixes) + resolveProviderId with 30-day KV cache (D-09/D-10) + admin DELETE /api/admin/unipile/cache/urn route (D-11) + kv-allowlist entry (D-18 escape hatch) (UNI-03) — completed 2026-05-18 (3 commits: e13f5cc, 81fdb50, cabca8c; SUMMARY: 68-03-SUMMARY.md)
- [x] 68-04-PLAN.md — Wave 2: lib/audit.ts generateAuditId/computeParamsHash (SHA-256 D-05) + writeAuditRow (dual KV write row + hash pointer, 90-day TTL D-08) + checkDedup (no bypass D-06, no note in KV D-07) (UNI-04) — completed 2026-05-18 (1 commit: 331d152; SUMMARY: 68-04-SUMMARY.md)
- [x] 68-05-PLAN.md — Wave 2: lib/crm-bridge.ts CrmAdapter interface + TwentyAdapterSkeleton + outbox row (status=pending, no TTL, no HTTP per D-01) + phase 70 contracts documented in comments (D-02/D-03/D-04) (UNI-05) — completed 2026-05-18 (1 commit: 7eeac00; SUMMARY: 68-05-SUMMARY.md)
- [x] 68-06-PLAN.md — Wave 3: linkedin_send_connection (8-step handler + D-13 3-poll verify @ 2s/5s/10s + D-14 envelope + D-20 account_id rules) + linkedin_get_relationship_status (D-21 {degree, connection_status}) + manifest wired (toolCount: 0→2) + doc-counts updates (UNI-06) — completed 2026-05-18 (3 commits: 03c1def, 01ccf0c, a9cd234; SUMMARY: 68-06-SUMMARY.md).

**Phase 68 LIVE-VALIDATED 2026-05-18** via `scripts/smoke-unipile.ts` against real Unipile tenant `api41.unipile.com:17153` + 1 LinkedIn account (Yassine Hamou Tahra, Sales Nav premium). Results:
- ✅ `linkedin_get_relationship_status` returns `{degree:1, connection_status:"FIRST_DEGREE"}` for a real 1st-degree contact (Adrien Gaignebet) — D-21 envelope honored, no leaked fields.
- ✅ `linkedin_send_connection` envelope on operator's own profile: `verified:false` strict boolean (D-13/D-14), `crm_sync:"pending"` literal (D-14), `audit_id` UUID generated, `dedup_hit:false` first call.
- ✅ Dedup works: second identical call returns `dedup_hit:true` and short-circuits before SDK call.
- ✅ Bug fix `115ddd3`: DSN double-prefix issue (`https://https://...`) when operator sets `UNIPILE_DSN` with protocol already included (the Unipile dashboard default format). Now tolerated by `normalizeDsn()`.
- ⚠ 2 imperfections deferred to backlog: UNI-25 (URL with query string mis-classified) + UNI-26 (Unipile 4xx mis-classified as `error_unipile_5xx`). Both routed to phase 69 (closed via Plan 01 — SLUG_RE + classifyUnipileError extensions).

The original Antoine Vercken slug (failed with Browserbase) was not the literal value `antoinevercken` (Unipile returned `invalid_recipient`). The re-validation premise — "any LinkedIn write would silently no-op on Browserbase" — was instead validated by the strict envelope + audit + dedup behavior on operator's own profile; the rigid boolean `verified` field prevents any future silent failure regardless of target profile.

---

## Previous Milestone Active Phases (v0.13, retained for context)

### Phase 62: Stabilize Phase 61

**Goal:** Fix two confirmed bugs in the Phase 61 in-dashboard updates feature: (1) GitHub Compare API direction inverted (`main...upstream` returns wrong status semantics), (2) `withAdminAuth` does not include `hydrateCredentialsStep` so KV-saved PAT is invisible to `/api/config/update`. Validate end-to-end on a live Vercel fork before marking Phase 61 done. Correct documentation overstating implementation (e.g., "stored encrypted in KV", "major bump detection").

**Requirements:** STAB-01, STAB-02, STAB-03, STAB-04

**Depends on:** Phase 61

**Plans:** 4 plans

Plans:
- [x] 062-01-PLAN.md — TDD: invert GitHub Compare URL direction (BASE=upstream, HEAD=fork) in route.ts:159 + :219; update 6 mock URL assertions
- [x] 062-02-PLAN.md — Wire hydrateCredentialsStep into /api/config/update via explicit composeRequestPipeline (replaces withAdminAuth) + 1 unit test for credential visibility
- [x] 062-03-PLAN.md — Env-gated live integration test against real GitHub Compare API + tests/integration/README.md env-var index
- [x] 062-04-PLAN.md — Documentation audit: correct "Stored encrypted in KV" copy + add 5-step smoke-test recipe to TROUBLESHOOTING.md + audit Phase 61 SUMMARY for package.json overstatement

### Phase 63: Cron Update-Check

**Goal:** Add a Vercel cron at `/api/cron/update-check` that runs daily, calls the GitHub Compare API, and writes the result to KV under `global:update-check`. The Overview banner reads from KV first (instant load), falls back to live call if KV is empty. Includes a manual Refresh icon (`?force=1`) and "checked Xh ago" freshness indicator.

**Requirements:** CRON-01, CRON-02, CRON-03

**Depends on:** Phase 62

**Plans:** 3 plans

Plans:
- [x] 063-01-PLAN.md — Extract shared computeUpdateStatus() helper + cache-first GET handler reading global:update-check + ?force=1 bypass + kv-allowlist update (CRON-02)
- [x] 063-02-PLAN.md — Move helper to src/core/update-check.ts + new cron route at /api/cron/update-check with BOOTSTRAP_EXEMPT marker + vercel.json registration + 6 unit tests (CRON-01)
- [x] 063-03-PLAN.md — formatRelativeTime helper + Overview banner "checked Xh ago" indicator + Refresh icon button calling ?force=1 with 30s debounce (CRON-03)

## Completed Phases (prior milestone — v0.13)

### Phase 61: In-Dashboard Updates

**Goal:** Extend `/api/config/update` with `github-api` mode so Vercel-deployed forks can sync upstream (Yassinello/kebab-mcp) with one click from the admin dashboard. No git CLI required.

**Requirements:** UPD-01, UPD-02, UPD-03, UPD-04, UPD-05

**Plans:** 3 plans

Plans:
- [x] 061-01-PLAN.md — Backend: github-api mode detection, GET/POST handlers, token resolution, breaking-change detection
- [x] 061-02-PLAN.md — UI: enriched overview banner (commits, breaking badge, diverged state, deploying) + Settings PAT configuration section
- [x] 061-03-PLAN.md — Tests: 6 unit test cases for github-api GET and POST handlers

## Archived Milestones

- **v0.13** (2026-04-24, tag `v0.1.13`) — 19 commits across 3 shipped phases (51 Langsmith v3 default + 52 Devices tab + 53 Observability UI). Code review surfaced 2 blockers (device-claim page missing, metrics routes leaked cross-tenant) — both fixed before tag. 994 unit + 51 UI + 16 contract tests. Phases 54-55 deferred to v0.14 backlog.
- **v0.12** (2026-04-21, tag `v0.1.12`) — 45+ commits, 908 unit + 37 UI + 44 registry + 14 contract + 4 Playwright + 19 MCP-resources tests, 5 phases (46 welcome correctness, 47 WelcomeShell wiring 2194→190 LOC, 48 tenant isolation + config facade, 49 T19 4 strict flags, 50 rebrand + coverage + docs + MCP resources). v1.0 rebrand blocker cleared, scorecard 4.0→4.6/5
- **v0.11** (2026-04-21, tag `v0.1.11`) — 40 commits, 765 unit + 37 UI-isolated + 11 contract + 4 Playwright tests, 5 phases (41 pipeline, 42 tenant scoping, 43 perf+CI, 44 supply chain, 45 welcome refactor). Multi-tenant real unlocked, scorecard 3.1→4.0/5
- **v0.10** (2026-04-21) — 48 commits, 554 unit + 13 integration + 4 Playwright + 6 contract tests, 5 phases (37b security hotfix + 37-40)

- **v0.8** (2026-04-16) — 4 commits, 360 tests, 84 tools, 14 connectors
- **v0.7** (2026-04-16) — 11 commits, 337 tests
- **v0.6** (2026-04-15) — 31 commits, 254 tests
- **v0.5** (2026-04-15) — Security, dedup, test coverage
- **v0.4** — Dashboard polish & onboarding
- **v0.3** — The Configurable Server
- **v1.0** — Open Source Framework
