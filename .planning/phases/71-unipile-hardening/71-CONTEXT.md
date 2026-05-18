# Phase 71: Unipile Hardening - Context

**Gathered:** 2026-05-19
**Status:** Ready for planning
**Source:** Auto-mode

<domain>
## Phase Boundary

Final phase of v0.17 milestone. Polish + hardening of the Unipile connector now that 6 tools + webhook ingress are shipped. 5 deliverables:
- **UNI-20** Kill switches (env vars to halt LinkedIn writes globally, distinct from per-account halt flag from phase 70)
- **UNI-21** Metrics — daily quota usage per account, surfaced via existing `/api/admin/metrics` infra
- **UNI-22** Audit query API — `GET /api/admin/audit/unipile` for operator inspection
- **UNI-23** Documentation — `docs/connectors/unipile.md` setup + tools + troubleshooting guide
- **UNI-24** Multi-tenant verification — manual smoke test with 2 distinct account_ids confirming isolation

**In scope:**
- `LINKEDIN_TOOLS_DISABLED=true` env kill switch (halts all 4 LinkedIn write tools globally — READS still allowed)
- Metrics increment in rate-limiter call sites → exposed via existing admin metrics endpoint
- `GET /api/admin/audit/unipile?account_id=&since=&tool=&limit=&cursor=` read-only with admin auth + cursor pagination
- `docs/connectors/unipile.md` written from scratch (env vars, tools catalog with examples, webhook setup, rate-limit defaults, kill switches, troubleshooting)
- `docs/CONNECTORS.md` index updated to include Unipile (NOTE: per phase 68 PATTERNS misalignment, the actual doc-counts gate scans content/docs/connectors.md — already updated at phase 69-06. docs/CONNECTORS.md is a separate file that's NOT scanned by doc-counts but IS part of the formal docs)
- Manual multi-tenant smoke test (2 tenants × same operator setup): verify rate counters separate, audit logs separate, kill switch state per-account possible (note: kill switch is GLOBAL not per-account — that's covered by phase 70 halt flag)

**Out of scope:**
- WhatsApp tools (dropped from phase 70 — stays out)
- New connector features (this is hardening only)
- Real Twenty/CRM integration (confirmed not connector responsibility per memory feedback_connector_scope)
- Audit query MCP tool (just REST endpoint — caller orchestrates via that)

</domain>

<decisions>
## Implementation Decisions

### Kill Switches (UNI-20)
- **D-86:** ONE env var: `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true` (legacy alias accepted: `LINKEDIN_TOOLS_DISABLED`). When set, ALL 4 LinkedIn write tools (send_connection, send_message, send_inmail, engage) refuse with `error: 'error_writes_disabled'` BEFORE halt-check (new Step -1, even earlier than Step 0 halt-check). Reads (get_relationship_status, list_pending) still allowed.
- **D-87:** No `WHATSAPP_TOOLS_DISABLED` env var since WhatsApp tools were dropped from this milestone.
- **D-88:** New AuditResult member: `error_writes_disabled`. Connector `testConnection()` aggregate health reports the kill switch state (visible in `/config → Connectors`).
- **D-89:** Kill switch is checked via `getConfig()` (NOT `process.env` direct) — picked up by per-request hydration so a runtime env change takes effect on next request.

### Metrics (UNI-21)
- **D-90:** Daily quota counters already exist in `lib/rate-limiter.ts` from phase 69 (KV keys `tenant:<id>:unipile:ratelimit:<account>:<tool>:daily:<YYYY-MM-DD>`). Phase 71 ADDS a metrics route `GET /api/admin/metrics/unipile-quotas?account_id=&tool=` returning `{daily_used, daily_limit, weekly_used, weekly_limit, reset_at, percent_used}`.
- **D-91:** Aggregated view (all accounts × tools matrix): `GET /api/admin/metrics/unipile-quotas/summary` returns `[{account_id, tool, daily_used, daily_limit, percent_used}]`. Used by future dashboard widget (NOT this phase — phase 71 ships data, not UI).
- **D-92:** No new MCP tool — these are admin-only REST endpoints (consistent with phase 53 pattern). Authenticated via `readAdminCookie()`.

### Audit Query API (UNI-22)
- **D-93:** `GET /api/admin/audit/unipile?account_id=&since=&tool=&result=&limit=&cursor=` returns `{items: AuditRow[], cursor: string | null, total_estimate?: number}`.
- **D-94:** Filters: `account_id` (exact), `since` (ISO timestamp, audit rows with timestamp >= since), `tool` (exact, e.g. `linkedin_send_connection`), `result` (exact, e.g. `error_rate_limit_kebab`). All optional, ANDed.
- **D-95:** Default limit 50, max 200. Cursor format: base64 of last `audit_id` from previous page (simple cursor, no offset).
- **D-96:** Tenant scoping: admin endpoint operates in tenant context via `getContextKVStore()` — does NOT cross-tenant unless explicit operator escape hatch (deferred to phase 72+ if needed).
- **D-97:** Performance: KV scan of `unipile:audit:` prefix with client-side filter. O(n) acceptable at Cadens scale (~12k rows/year/tenant). If perf hurts, phase 72 adds secondary indexes.

### Documentation (UNI-23)
- **D-98:** Create `docs/connectors/unipile.md` following the structure of `docs/connectors/apify.md` (or similar existing connector doc — find best analog). Sections:
  - Overview + decision rationale (link ADR 0001)
  - Setup: env vars (`UNIPILE_DSN`, `UNIPILE_TOKEN`, `UNIPILE_WEBHOOK_SECRET`), Unipile dashboard account connection, webhook subscription (link to `scripts/setup-unipile-webhooks.ts`)
  - Tools catalog: 6 tools × (description + example invocation + expected response)
  - Rate limits: defaults (25 connects/day, 50 DMs/day, 15 InMails/day), env override pattern (`KEBAB_UNIPILE_LINKEDIN_<TOOL>_<WINDOW>_CAP`)
  - Kill switches: `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` semantics
  - Halt flag: webhook-driven `account.status` automatically halts per-account on `restricted`/`credentials_expired`
  - Troubleshooting: 5 common errors + fixes (e.g., `error_unipile_5xx` → check Unipile status page; `error_not_connected` → verify recipient is 1st-degree; `error_rate_limit_kebab` → wait until next UTC midnight; etc.)
- **D-99:** Update `docs/CONNECTORS.md` index to add Unipile row (NOT the doc-counts-scanned `content/docs/connectors.md` — that was already updated in phase 69-06).
- **D-100:** Add 1 new entry to `README.md` "External integrations" section if it has one (NO bump to tool count — still 97 tools / 17 connectors).

### Multi-tenant Verification (UNI-24)
- **D-101:** Manual smoke test (not automated unit test — operator runs this). Document the procedure in `docs/connectors/unipile.md` Appendix:
  1. Set up 2 distinct admin tenant contexts (e.g., via 2 separate browser cookies or `KEBAB_ADMIN_TOKEN_<TENANT>`)
  2. From tenant A, run `linkedin_send_connection` on Adrien Gaignebet's profile (test consumed 1 connect quota for tenant A)
  3. From tenant B, run same → verify dedup_hit: false (separate audit log)
  4. Check `GET /api/admin/metrics/unipile-quotas?account_id=<accA>` from tenant A → daily_used: 1
  5. Check same endpoint from tenant B → daily_used: 0 (independent counter)
  6. Set kill switch `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true` → BOTH tenants refused (global switch)
- **D-102:** This is a doc deliverable, not a code one. No automated test (it would require setting up multi-tenant orchestration which is overkill for this milestone).

### Backlog from phase 70 (none)
- Phase 70 closed cleanly with 328 tests + scope correction. No carryover.

### Claude's Discretion
- Choice of cursor encoding (recommend: base64 of `audit_id`)
- Exact tool description wording in docs (recommend: copy from `defineTool({description})` in manifest)
- Naming of dashboard health-state field for kill switch (recommend: `writes_disabled: boolean` in testConnection envelope)

</decisions>

<canonical_refs>
## Canonical References

### Anchor Documents
- `docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md`
- `.planning/milestones/v0.17-unipile-connector-ROADMAP.md` (UNI-20..24)
- `.planning/phases/68-unipile-foundation/68-CONTEXT.md` (D-01..D-21 carry)
- `.planning/phases/69-linkedin-writes/69-CONTEXT.md` (D-22..D-50 — rate-limiter from D-38..D-43, the metrics source)
- `.planning/phases/70-webhooks-whatsapp/70-CONTEXT.md` (D-51..D-78, esp. D-65/D-66 halt-check insertion point — kill switch sits BEFORE halt-check)

### Existing Patterns (reuse)
- `app/api/admin/metrics/requests/route.ts` (phase 53 admin metrics pattern — analog for the 2 new metrics endpoints)
- `app/api/admin/metrics/ratelimit/route.ts` (phase 53 — analog for cursor-paginated KV scan)
- `app/api/admin/unipile/cache/urn/route.ts` (phase 68 admin DELETE — analog for admin auth + getKVStore escape hatch)
- `src/connectors/unipile/lib/rate-limiter.ts` (counters live here — metrics endpoint reads them)
- `src/connectors/unipile/lib/audit.ts` (audit query endpoint scans this)
- `src/connectors/unipile/webhook/halt-flag.ts` (halt flag from phase 70 — distinct from kill switch)
- `docs/connectors/apify.md` OR similar existing connector doc (template for unipile.md)
- `docs/CONNECTORS.md` (index to update)
- `content/docs/connectors.md` (UNCHANGED in phase 71 — already updated in phase 69-06)

### External Docs
- https://developer.unipile.com/docs/provider-limits-and-restrictions — for the rate-limit defaults documentation

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Rate-limiter counters: `tenant:<id>:unipile:ratelimit:<account>:<tool>:daily:<YYYY-MM-DD>` (key format from phase 69 D-38) — metrics endpoint just reads these
- Audit rows: `tenant:<id>:unipile:audit:<audit_id>` (phase 68 D-08) — query endpoint scans `unipile:audit:` prefix client-side
- Kill switch convention: env vars like `MYMCP_DISABLE_GOOGLE`, `MYMCP_DISABLE_VAULT` already exist (.env.example) — Unipile follows `KEBAB_UNIPILE_*_DISABLED` per modern naming
- Admin auth: `readAdminCookie()` from `src/core/admin-auth.ts` (phase 50)
- Doc-counts gate: NO change to tool count (still 97). docs/CONNECTORS.md not scanned, safe to add Unipile entry there

### Integration Points
- `src/connectors/unipile/tools/*.ts` (4 write tools) — add Step -1 kill-switch check at the very top (before Step 0 halt-check)
- `src/connectors/unipile/manifest.ts` `testConnection()` — extend to report kill switch state
- 2 NEW admin REST routes: `/api/admin/metrics/unipile-quotas` + `/api/admin/audit/unipile`
- `docs/connectors/unipile.md` NEW
- `docs/CONNECTORS.md` index entry added
- `tests/contract/kv-allowlist.test.ts` — 2 NEW entries for the new admin routes (root-scope getKVStore allowed for admin tools)
- `.env.example` — document `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` + the rate-limit env overrides

### Established Patterns
- Write tool handler shape after phase 71: kill-switch (Step -1) → halt-check (Step 0) → dedup (Step 1) → ... — kill switch is the first thing.
- Admin metrics endpoint: cache-first KV read + 30s `Cache-Control` per phase 53 pattern
- Cursor pagination: base64 of last audit_id, decode + scan-from-next on server

</code_context>

<specifics>
## Specific Ideas

- **Kill switch UX:** when set, admin dashboard `/config → Connectors → Unipile` tile shows `⚠ Writes globally disabled (KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true)` so operator knows why nothing's working. Coordinated with `testConnection()` health response.
- **Audit query response shape:** mirrors the AuditRow type. Body is sanitized (no PII) per phase 68 D-07.
- **Doc structure:** `docs/connectors/unipile.md` should include a "Quick Start" 60-second flow at the top: set env vars → run `scripts/setup-unipile-webhooks.ts` → send a test connect via `linkedin_send_connection`.

</specifics>

<deferred>
## Deferred Ideas

- Audit query as MCP tool (currently REST only) — defer until caller pattern emerges
- Cross-tenant admin escape hatch — phase 72+ if needed
- Dashboard widget for quota usage charts (data is ready via D-91, UI is separate phase)
- Secondary KV indexes for audit by-provider / by-tool — phase 72+ if perf hurts
- Slack/email notification on kill switch trip — operator's job via separate workflow watching the health endpoint

</deferred>

---

*Phase: 71-unipile-hardening*
*Context gathered: 2026-05-19 via --auto mode*
