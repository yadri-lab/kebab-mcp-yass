# Roadmap: MyMCP

## Current Milestone: v0.17 — Unipile Connector (LinkedIn + WhatsApp write)

**Started:** 2026-05-18
**Goal:** Ship a dedicated `src/connectors/unipile/` connector exposing 9 high-level write tools for LinkedIn (5) and WhatsApp (4). Replaces failed Browserbase-based LinkedIn write attempt per [ADR 0001](../docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md). See [v0.17 ROADMAP](milestones/v0.17-unipile-connector-ROADMAP.md) for full detail.

### Phase Overview (v0.17)

| # | Phase | Goal | Requirements | Effort |
|---|-------|------|--------------|--------|
| 68 | Unipile foundation | Client + manifest + first write E2E (send_connection + get_relationship_status) + CRM outbox + audit log | UNI-01..06 | 2.5d |
| 69 | LinkedIn writes | send_message (1st-degree), send_inmail (explicit), engage (super-tool + dry_run), list_pending, rate-limiter | UNI-07..11 | 2d |
| 70 | Webhooks + WhatsApp V1 | Dedicated `/api/unipile/webhook` + 3 event handlers + 4 WhatsApp tools | UNI-12..19 | 3d |
| 71 | Hardening | Kill switches, metrics, audit query API, docs, multi-tenant verification | UNI-20..24 | 1.5d |

## Active Phase

### Phase 68: Unipile Foundation

**Goal:** Wire Unipile SDK into Kebab as a new connector. Ship the first write tool (`linkedin_send_connection`) end-to-end with verify-after-write, dedup, audit log, and Twenty CRM outbox. Re-validate the Antoine Vercken connect flow that failed 2026-05-18 with Browserbase.

**Requirements:** UNI-01, UNI-02, UNI-03, UNI-04, UNI-05, UNI-06

**Depends on:** ADR 0001 (decided 2026-05-18)

**Plans:** 6 plans

Plans:
- [x] 68-01-PLAN.md — Wave 1: Install unipile-node-sdk@^1.9.3, scaffold stub manifest (0 tools) + manifest tests + lazy registry entry (toolCount: 0); unblocks parallel Wave 2 (UNI-01) — completed 2026-05-18 (3 commits: f67bcf4, ab0e3e2, 99d8c39; SUMMARY: 68-01-SUMMARY.md)
- [x] 68-02-PLAN.md — Wave 2: client.ts lazy UnipileClient singleton + sanitize/reset helpers + lib/retry.ts (exp backoff on 429/5xx, max 3) + lib/errors.ts (4 typed classes + classifyUnipileError taxonomy) (UNI-02) — completed 2026-05-18 (3 commits: ce030ad, 3c9cab6, ebcf2f9; SUMMARY: 68-02-SUMMARY.md)
- [ ] 68-03-PLAN.md — Wave 2: lib/identifiers.ts URL normalize (D-12 4 variants + locale prefixes) + resolveProviderId with 30-day KV cache (D-09/D-10) + admin DELETE /api/admin/unipile/cache/urn route (D-11) + kv-allowlist entry (D-18 escape hatch) (UNI-03)
- [ ] 68-04-PLAN.md — Wave 2: lib/audit.ts generateAuditId/computeParamsHash (SHA-256 D-05) + writeAuditRow (dual KV write row + hash pointer, 90-day TTL D-08) + checkDedup (no bypass D-06, no note in KV D-07) (UNI-04)
- [ ] 68-05-PLAN.md — Wave 2: lib/crm-bridge.ts CrmAdapter interface + TwentyAdapterSkeleton + outbox row (status=pending, no TTL, no HTTP per D-01) + phase 70 contracts documented in comments (D-02/D-03/D-04) (UNI-05)
- [ ] 68-06-PLAN.md — Wave 3: linkedin_send_connection (8-step handler + D-13 3-poll verify @ 2s/5s/10s + D-14 envelope + D-20 account_id rules) + linkedin_get_relationship_status (D-21 {degree, connection_status}) + manifest wired (toolCount: 0→2) + doc-counts updates (UNI-06)

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

## Completed Phases (current milestone)

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
