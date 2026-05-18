# Phase 69: LinkedIn Writes Completion - Context

**Gathered:** 2026-05-18
**Status:** Ready for planning
**Source:** Auto-mode (Claude tranche les recommandés, aligned with phase 68 D-01..D-21)

<domain>
## Phase Boundary

Complete the LinkedIn write tool suite started in phase 68. Ship 4 new tools + 1 rate-limiter:
- `linkedin_send_message` (1st-degree DM only, attachments support)
- `linkedin_send_inmail` (explicit Premium/Sales Nav, credits tracking)
- `linkedin_engage` (super-tool: routes to connect/message/inmail/skip based on degree)
- `linkedin_list_pending` (cleanup helper for stale invitations)
- `lib/rate-limiter.ts` (per-account daily/weekly caps, fail-closed by default)

**In scope:**
- 4 tools shipped, registered in manifest, toolCount: 2 → 6
- Rate-limiter integrated into all 4 write tools (send_connection from phase 68 ALSO retrofitted)
- engage super-tool with `dry_run: true` returning proposed action without executing
- linkedin_send_message verify-after-write via `getProfile.last_message_at` polling (10s budget)
- send_inmail credits tracking (Unipile returns credits_used + credits_remaining)

**Out of scope:**
- Webhook ingress for `message.sent`/`new_message` events — phase 70
- WhatsApp tools — phase 70
- Kill switches (LINKEDIN_TOOLS_DISABLED) — phase 71
- Metrics dashboard widgets — phase 71

</domain>

<decisions>
## Implementation Decisions

### linkedin_send_message (UNI-07)
- **D-22:** Tool refuses with `error: 'error_not_connected'` if recipient is NOT 1st-degree. Resolves via `getProfile.network_distance` BEFORE attempting send. Saves an API call + clearer error.
- **D-23:** Attachments support: PDF/image ≤15MB. Validated client-side via `File.size` check; rejected with `error_attachment_too_large` if oversize. SDK call: `client.messaging.sendNewMessage({account_id, recipient_id, text, attachments: File[]})`.
- **D-24:** Verify-after-write: poll `getProfile.last_message_at` once at 5s mark, then once at 10s mark. If `last_message_at >= request_start_at` → `verified: true`. Else → `verified: false` (strict per D-13 pattern). NOT 'pending'.
- **D-25:** Audit row includes `recipient_degree`, `attachment_count`, `text_hash` (not raw text per D-07 GDPR pattern).

### linkedin_send_inmail (UNI-08)
- **D-26:** Tool requires explicit `allow_inmail: true` param. Defaults to `false`. Refuses with `error_inmail_not_authorized` if missing — prevents accidental credit burn.
- **D-27:** `max_inmail_credits` optional param caps the send (compares against `credits_remaining` from prior call, refuses if would exceed). Defaults to "no cap".
- **D-28:** Response envelope INCLUDES `credits_used` and `credits_remaining` (Unipile-returned). Both numeric, NOT optional — if Unipile doesn't return them (parsing fallback), default to `null` and log warning.
- **D-29:** If account lacks Sales Nav / Premium → `error_inmail_requires_premium` (mapped from Unipile 403/422 with type `inmail_requires_premium`). NEW error enum member.

### linkedin_engage SUPER-TOOL (UNI-09)
- **D-30:** Discriminated union return type: `{action: 'sent_message'|'sent_connection'|'sent_inmail'|'skipped', ...envelope}`. The `action` field tells the caller what actually happened.
- **D-31:** Routing logic:
  - degree=1 → `send_message` (or skip if no message provided)
  - degree=2|3 and reachable → `send_connection` (with optional note)
  - out_of_network AND `fallback_if_unreachable: 'inmail'` AND `allow_inmail: true` → `send_inmail`
  - otherwise → `skipped` with `reason: 'unreachable_no_inmail_fallback'`
- **D-32:** `dry_run: true` returns the proposed action + risks WITHOUT calling any provider endpoint. Audit log records the dry-run (separate `result: 'dry_run'` enum) so operators can see what the LLM *would have done*.
- **D-33:** Dry-run skips rate-limit check (it's not a real action) but DOES write an audit row.

### linkedin_list_pending (UNI-10)
- **D-34:** Returns array of `{invitation_id, recipient_profile_url, recipient_name, sent_at, age_days, has_note}`. Sourced from `client.users.getAllInvitationsSent({account_id, since?: ISO_DATE})`.
- **D-35:** `older_than_days?` filter applied client-side after fetch (Unipile API doesn't support server-side date filtering on this endpoint per RESEARCH.md A3).
- **D-36:** Default limit 100, max 500. Pagination via Unipile's `cursor` field if needed.
- **D-37:** NOT a destructive tool (`destructive: false`). Just a read.

### Rate-limiter (UNI-11)
- **D-38:** Per-account counters in KV: `tenant:<id>:unipile:ratelimit:<account_id>:<tool>:<day>`. Format: `{daily_used: int, weekly_used: int, last_reset_at: ISO}`. Daily reset at UTC midnight; weekly reset Monday UTC.
- **D-39:** Default caps (per ROADMAP UNI-11): `LINKEDIN_DAILY_CONNECT_CAP=25`, `LINKEDIN_WEEKLY_CONNECT_CAP=100`, `LINKEDIN_DAILY_DM_CAP=50`, `LINKEDIN_DAILY_INMAIL_CAP=15`. All env-overridable via `KEBAB_UNIPILE_<METRIC>_CAP`.
- **D-40:** **Fail-closed by default**: if KV read fails or returns null, return `{blocked: true, reason: 'kv_unavailable'}`. Operator can override via `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open` env var. Aligned with my preference for "defaults généreux, escape hatch" (memory feedback_defensive_defaults — generous in TIME defaults like timeouts, but security-critical limits should fail-closed).
- **D-41:** Returns `{blocked: true|false, daily_used, daily_limit, retry_after?: ISO}` — never throws exceptions. Caller's responsibility to surface to operator.
- **D-42:** Retrofit into `linkedin_send_connection` (phase 68 tool) — rate-limit check added BEFORE dedup check (cheaper).

### Phase 68 retrofit
- **D-43:** `linkedin_send_connection` (phase 68) gets `rateLimiter.check(...)` added at the top of the handler. If blocked → return early with `{provider_ok: false, verified: false, blocked_by_rate_limit: true, daily_used, daily_limit, audit_id}` + audit row with `result: 'error_rate_limit_kebab'` (new enum to distinguish Kebab cap from Unipile 429).

### Backlog from phase 68 live test (resolve in this phase)
- **D-44:** UNI-25 (URL query string normalization) — extend `SLUG_RE` regex in `lib/identifiers.ts` to allow `\?[^/]*` suffix. Add 3 tests for `?originalSubdomain=fr`, `?miniProfileUrn=...`, `?utm_source=...`.
- **D-45:** UNI-26 (4xx error mis-classification) — add 2 new enum members to `lib/errors.ts`: `error_recipient_unreachable` (422 invalid_recipient) + `error_invalid_request` (400 invalid_parameters). Map in `classifyUnipileError()`.

### Claude's Discretion
- Choice of attachment validation library (recommend: native `File.size` check, no new dep)
- Whether `linkedin_engage` accepts `note?` param (recommend: yes, passed through to send_connection branch only)
- Error code naming convention for the 3 new enum members (D-29, D-44, D-45) — Claude proposes consistent prefix `error_*`

</decisions>

<canonical_refs>
## Canonical References

### Anchor Documents
- `docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md`
- `.planning/milestones/v0.17-unipile-connector-ROADMAP.md` (UNI-07..11 + UNI-25/26 backlog)
- `.planning/phases/68-unipile-foundation/68-CONTEXT.md` (D-01..D-21 phase 68 decisions — phase 69 honors all)

### Existing Phase 68 Code (reuse + extend)
- `src/connectors/unipile/lib/client.ts` (getUnipileClient — reuse)
- `src/connectors/unipile/lib/retry.ts` (withRetry — wrap all SDK calls)
- `src/connectors/unipile/lib/errors.ts` (classifyUnipileError — ADD 3 new enum members per D-29/D-44/D-45)
- `src/connectors/unipile/lib/identifiers.ts` (resolveProviderId — reuse + UPDATE SLUG_RE per D-44)
- `src/connectors/unipile/lib/audit.ts` (writeAuditRow + checkDedup — reuse)
- `src/connectors/unipile/lib/crm-bridge.ts` (crmBridge — reuse, still skeleton in phase 69)
- `src/connectors/unipile/tools/linkedin-send-connection.ts` (RETROFIT with rate-limiter per D-43)

### External Docs (Unipile)
- https://developer.unipile.com/docs/messaging — sendNewMessage signature, attachment limits
- https://developer.unipile.com/docs/invite-users — invitation_id format, getAllInvitationsSent
- https://developer.unipile.com/docs/inmail — InMail credit semantics, premium requirements
- https://developer.unipile.com/docs/provider-limits-and-restrictions — LinkedIn daily caps reference

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from phase 68)
- All 5 lib/* files are mature foundations — phase 69 extends, doesn't replace
- The `withRetry` helper is already plumbed for 429/5xx — rate-limiter integration must NOT double-retry on Kebab's own caps
- `audit.ts::AuditResult` enum to extend with: `dry_run`, `error_rate_limit_kebab`, `error_recipient_unreachable`, `error_invalid_request`, `error_inmail_not_authorized`, `error_inmail_requires_premium`, `error_attachment_too_large`, `error_not_connected`

### Integration Points
- `src/connectors/unipile/manifest.ts` — add 4 new `defineTool({})` entries (tools array grows from 2 to 6)
- `src/core/registry.ts` — bump `toolCount: 2 → 6`
- `content/docs/connectors.md` + `README.md` — update tool count (93 → 97 tools)
- `tests/contract/kv-allowlist.test.ts` — NO new entries needed (rate-limiter uses `getContextKVStore()` per D-18 pattern)

### Established Patterns
- Tool handler shape: `args → resolveAccountId(D-20) → checkDedup → rateLimiter.check → resolveProviderId → withRetry(SDK call) → verify-after-write → writeAuditRow → crmBridge → return envelope`
- Test layering: unit (hashing, normalization, rate-limit counters) + integration (mocked SDK) + smoke (scripts/smoke-unipile.ts manual extension)

</code_context>

<specifics>
## Specific Ideas

- **Anti-pattern enforced (carried from phase 68):** No `'pending'` enum value. `verified` is strictly boolean across ALL 4 new tools.
- **Rate-limiter UX**: when blocked, caller receives `retry_after` (ISO timestamp of next reset). NOT a delta in seconds — operators reason in clock time better than "wait 3457 seconds".
- **dry_run is FIRST-CLASS in engage**: many GTM workflows will want to preview "what would Claude do for these 100 prospects?" before committing. Audit log explicitly tracks dry_run so the bill-of-actions can be reviewed.

</specifics>

<deferred>
## Deferred Ideas

- **`linkedin_warm_prospect` workflow tool** (engage + multi-step nurture) — V2 product brief, NOT this phase
- **Bulk operations** (send to N profiles in one call) — not in scope, single-target only
- **InMail credit alerts** (notify when remaining < X) — phase 71 metrics, not phase 69
- **Rate-limiter dashboard widget** (per-account usage chart) — phase 71

</deferred>

---

*Phase: 69-linkedin-writes*
*Context gathered: 2026-05-18 via --auto mode*
