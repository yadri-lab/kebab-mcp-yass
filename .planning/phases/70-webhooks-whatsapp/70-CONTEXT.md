# Phase 70: Webhooks Ingress + WhatsApp V1 - Context

**Gathered:** 2026-05-18
**Status:** Ready for planning
**Source:** Auto-mode (Claude tranche les recommandés, scope-corrected after user feedback)

<domain>
## Phase Boundary

Build the inbound webhook ingress + WhatsApp tool suite. The connector receives events from Unipile and updates its OWN internal state (audit log, halt flag). The connector does NOT propagate events to any external system (CRM, Slack, etc.) — that is the caller's responsibility.

**2 deliverables (REDUCED 2026-05-18 from 6 — WhatsApp tools dropped):**
- `/api/unipile/webhook` route (dedicated, dual-mode auth, idempotent) — **Plan 70-01 SHIPPED**
- 3 INGRESS handlers updating connector state ONLY — **Plan 70-02 TODO**:
  - `account.status` → set halt flag in KV (write tools check pre-flight)
  - `new_relation` → enrich audit log row with `accepted_at`
  - `new_message` → enrich audit log with `last_replied_at` (or insert standalone inbound entry)
- Halt-check Step 0 retrofit on 4 LinkedIn write tools — **Plan 70-03 TODO**

**Out of phase 70 (deferred):**
- ~~4 WhatsApp tools~~ → backlog post-milestone

**In scope:**
- New route handler at `app/api/unipile/webhook/route.ts` (NOT under generic webhook receiver)
- Dual-mode signature verification (HMAC + static header — research-verified static is what's actually sent)
- KV-backed idempotency by `event_id` (24h TTL)
- 3 INGRESS event handlers (state mutation only, no outbound HTTP)
- 4 WhatsApp tools registered in manifest (toolCount 6 → 10)
- HALT-CHECK pre-flight Step 0 added to all 5 write tools (4 LinkedIn retrofit + 1 new WhatsApp)

**Out of scope — IMPORTANT:**
- ❌ **NO outbound CRM push.** No `TwentyAdapter`, no `UNIPILE_CRM_WEBHOOK_URL`, no `notifyEvent()` POST.
- ❌ **NO cron retry.** No `/api/cron/unipile-crm-retry`, no outbox state machine beyond what phase 68 already shipped.
- ❌ **NO outbound Slack/Discord notification** from connector code (operator can build that as a separate caller, e.g. n8n workflow listening to audit log).
- Phase 68 "outbox skeleton" = INTERNAL KV row `unipile:audit:<id>.crm_sync: 'pending'` that the CALLER reads via future audit query tool (UNI-22, phase 71). Connector never pushes anywhere.
- Kill switches (`LINKEDIN_TOOLS_DISABLED`, `WHATSAPP_TOOLS_DISABLED`) — phase 71
- Metrics dashboard widgets — phase 71
- Audit query API (the tool callers use to react to enriched audit state) — phase 71 UNI-22
- WhatsApp groups / reactions / read receipts (V1 = 1-to-1 messaging only)
- Email / Calendar Unipile channels (out of milestone)

</domain>

<decisions>
## Implementation Decisions

### Webhook Route (UNI-12)
- **D-51:** Route at `app/api/unipile/webhook/route.ts` — DEDICATED, NOT the generic `app/api/webhook/[name]/route.ts` receiver. Per ADR 0001.
- **D-52:** Verification is **DEFENSIVE dual-mode** — verify HMAC-SHA256 of body via `X-Unipile-Signature` header first; if header is ABSENT, fall back to static-token equality check against `Unipile-Auth` header. Both checks use `timingSafeEqual`. Log which mode actually triggered for observability. Research live-verified static-only is what Unipile sends today, but keep HMAC for forward compat.
- **D-53:** Webhook secret env var: `UNIPILE_WEBHOOK_SECRET` (single global secret — Unipile sends one signature per webhook URL, not per-tenant). Multi-tenant routing happens INSIDE the handler via `account_id` → tenant lookup.
- **D-54:** Idempotency: KV key `unipile:webhook:event:<event_id>` with 24h TTL. If event already seen → return 200 immediately (acknowledge to Unipile, no re-processing).
- **D-55:** Reply within 30s budget. Heavy work runs async via `void asyncFn().catch(log.error)` after writing the dedup row + returning 200 immediately. Vercel lambda stays alive ~30s post-response per docs.

### Account-Tenant Reverse Index (NEW — webhook ingress needs it)
- **D-56:** Webhook ingress has no auth context → no tenant. Maintain `unipile:account-tenant:<account_id> → tenant_id` (root-scope KV, written at account-claim time + on first observation). Webhook handler reads this index to route to correct tenant context. NEW kv-allowlist entry.

### account.status Handler (UNI-13)
- **D-57:** On status transitions to error states (`credentials_expired`, `restricted`, `disconnected`), set halt flag in KV: `tenant:<id>:unipile:halt:<account_id>: {reason, halted_at, status}`. Write tools check this flag at the TOP of their handler (NEW Step 0 — BEFORE dedup).
- **D-58:** On status transition BACK to `OK` (operator reconnects), CLEAR the halt flag. Same handler.
- **D-59:** Halt flag surfaces in connector `testConnection()` aggregate health response (becomes visible in `/config → Connectors` dashboard tile automatically).
- **D-60:** No outbound notification. If operator wants Slack alert on halt, they build that via separate workflow watching the connector health endpoint or audit log.

### new_relation Handler (UNI-14)
- **D-61:** When Unipile emits `new_relation` (LinkedIn invitation accepted by recipient), the handler:
  1. Looks up the original audit row by `recipient_provider_id` (best-effort scan of recent audit rows for matching `provider_id_target`)
  2. If found, UPDATES the audit row: `accepted_at: now`, `crm_sync: 'completed'` (was `'pending'`)
  3. If NOT found (connection accepted from request sent outside Kebab), insert a NEW audit row `{result: 'inbound_accept_unknown_origin', accepted_at, recipient_provider_id}`
- **D-62:** Research-confirmed: `new_relation` events have **up to 8h delay** from accept. Caller's audit query tool (phase 71) must tolerate this latency.

### new_message Handler (UNI-15)
- **D-63:** When Unipile emits `message.received`:
  1. **SKIP if `is_sender: true`** (research finding #3 — Unipile echoes outbound sends). Log info, no audit row, return.
  2. Otherwise, look up audit row for the same `attendee_provider_id`. If found, update `last_replied_at: now`. If not found, insert standalone `{result: 'inbound_message_unknown_origin', received_at, sender_provider_id, content_hash}`.
- **D-64:** **NEVER store message body in KV.** Only `content_hash` (SHA-256 truncated 16 chars) per D-07 PII rules from phase 68. Caller fetches body via `whatsapp_get_conversation` if needed.

### Multi-tenant + Halt enforcement (NEW STEP 0 on all write tools)
- **D-65:** ALL write tools (LinkedIn + WhatsApp) gain a NEW pre-flight Step 0: read halt flag for `account_id`. If halted → return `{error: 'error_account_halted', reason, halted_at, audit_id}` + insert single audit row `{result: 'error_account_halted'}`. NO dedup check, NO rate-limit, NO provider call. This is the highest-priority gate.
- **D-66:** Halt-check is the FIRST thing in every write handler, BEFORE D-49's dedup-first ordering from phase 69. Order: halt-check → dedup → (other pre-flight gates per tool) → rate-limit → provider call → audit → envelope.

### Bootstrap Script (one-shot subscription creation)
- **D-67:** `scripts/setup-unipile-webhooks.ts` — creates the 3 webhook subscriptions in Unipile (messaging, account_status, users) via API. Idempotent: lists existing webhooks, skips already-configured ones. Uses SDK escape hatch for `users` source (D-68 below).
- **D-68:** `new_relation` subscription uses SDK escape hatch — `client.request.send({path: ['webhooks'], method: 'POST', body: {source: 'users', request_url, ...}})`. The typed `client.webhook.create()` doesn't accept source `"users"`.

### WhatsApp Tools (UNI-16..19) — DROPPED 2026-05-18
- All 4 WhatsApp tools (UNI-16, UNI-17, UNI-18, UNI-19) are **deferred to post-milestone backlog**. Reason: core need is LinkedIn connect + DM (covered by phase 68/69). WhatsApp not demanded immediately. Phase 70 scope reduces to webhook ingress + halt-flag retrofit only.
- D-69 through D-76 (previously defining WhatsApp tools) are RESCINDED.
- Manifest tool count stays at 6 (no toolCount bump in phase 70).
- The WhatsApp account already connected to Unipile (`2qQuXs25TsimaAE62T2xSw`) remains visible via `linkedin_engage`/audit but no MCP tools target it.

### Body parsing quirk
- **D-77:** Webhook body MAY arrive with `Content-Type: application/x-www-form-urlencoded` despite JSON content (Unipile axios bug, research finding #7). Body parser MUST attempt JSON parse regardless of content-type header.

### New AuditResult enum members (minimal)
- **D-78:** Add `error_account_halted` (D-65 halt path), `inbound_accept_unknown_origin` (D-61 fallback), `inbound_message_unknown_origin` (D-63 fallback). That's it — 3 new members.

### Backlog from phase 69 live test (none)
- Phase 69 closed cleanly with 228 tests + live validation. No carry-over.

### Claude's Discretion
- Choice of background task mechanism (recommend: `void asyncFn().catch(log.error)`)
- Exact match-strategy for audit reverse lookup (recommend: scan KV pattern `tenant:<id>:unipile:audit:*`, filter by `provider_id_target` — accept it's not perfect)
- Logging level for skipped echoes (recommend: `log.debug` to avoid noise)

</decisions>

<canonical_refs>
## Canonical References

### Anchor Documents
- `docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md`
- `.planning/milestones/v0.17-unipile-connector-ROADMAP.md` (UNI-12..19)
- `.planning/phases/68-unipile-foundation/68-CONTEXT.md` (D-01..D-21 honored — note D-01 "skeleton" stays as-is, NOT replaced with outbound POST)
- `.planning/phases/69-linkedin-writes/69-CONTEXT.md` (D-22..D-50 honored, esp. D-49 handler ordering)

### Existing Patterns (reuse + extend)
- `src/connectors/webhook/route.ts` (existing HMAC verification idiom — analog only, NOT shared infra)
- `src/connectors/unipile/lib/audit.ts` (extend with 3 new AuditResult members + read functions for reverse lookup)
- `src/connectors/unipile/lib/rate-limiter.ts` (extend `UnipileRateLimitedTool` union with `whatsapp_send`)
- `src/connectors/unipile/lib/crm-bridge.ts` (KEEP AS-IS — phase 68 skeleton stays, no real adapter built)
- `src/connectors/unipile/lib/account.ts` (resolveAccountId — reuse for WhatsApp tools)

### External Docs (Unipile)
- https://developer.unipile.com/docs/webhooks-2
- https://developer.unipile.com/docs/messaging — WhatsApp endpoints
- https://developer.unipile.com/reference/webhookscontroller_create

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/credential-store.ts` — `UNIPILE_WEBHOOK_SECRET` flows through `cred:*` keys
- `src/connectors/webhook/route.ts` lines 50-100 — HMAC verification + timingSafeEqual pattern
- `src/connectors/unipile/lib/audit.ts` — `writeAuditRow` for inbound event audits
- `src/connectors/unipile/tools/linkedin-send-message.ts` — handler skeleton for WhatsApp tools to mirror

### Integration Points
- `src/connectors/unipile/manifest.ts` — add 4 WhatsApp tools (toolCount 6 → 10)
- `src/core/registry.ts` — bump unipile `toolCount` 6 → 10
- `content/docs/connectors.md` + `README.md` — count delta (97 → 101 tools)
- `tests/contract/kv-allowlist.test.ts` — 2 NEW entries needed:
  1. Webhook route (root-scope `unipile:webhook:event:*` for cross-tenant idempotency)
  2. Account-tenant reverse index (root-scope `unipile:account-tenant:*`)
- No `vercel.json` cron change (no cron in this phase anymore)

### Established Patterns
- Tool handler shape (NEW after phase 70): halt-check (D-65) → dedup → account → ... → audit → envelope
- Webhook idempotency: KV `SET NX` on `event_id` (atomic)
- HMAC verification: `timingSafeEqual(computed, received)` — never `===`

### Creative Options
- The audit reverse-lookup pattern is imperfect (KV scan + filter). If it becomes a perf bottleneck, phase 71 could add a secondary index `unipile:audit:by-provider:<provider_id> → audit_id`. Don't pre-optimize.

</code_context>

<specifics>
## Specific Ideas

- **Empirical HMAC findings (D-52):** Research already LIVE-verified. The HMAC code path will never fire on current tenant — kept for forward compat only. Plan must include `log.info("[CONNECTOR:unipile] webhook auth mode", {mode: 'hmac'|'static'})` to confirm.
- **WhatsApp self-test ready:** account `2qQuXs25TsimaAE62T2xSw` (phone 33660036335) is OK status. Phase 70 can live-test WhatsApp send via the smoke-unipile.ts extension (whatsapp-send-self scenario).
- **Webhook ingress live test:** webhook.site free service is perfect for capturing real Unipile webhook POSTs during smoke testing. Setup script can point at webhook.site URL first, then re-target to real ingress once code is shipped.

</specifics>

<deferred>
## Deferred Ideas

- **Outbound CRM push (TwentyAdapter, cron retry, HMAC outbox)** — explicitly NOT in connector scope. Caller's responsibility via separate workflow. May become a SEPARATE connector someday (kebab-twenty-sync) but never inside Unipile.
- **Audit reverse-index by provider_id** — phase 71+ if KV scan perf hurts
- **WhatsApp groups, reactions, read receipts** — V2
- **Email + Calendar Unipile channels** — out of milestone (Google Workspace covers it)
- **Contact name fuzzy resolution in `whatsapp_send_message`** (D-71 c) — phase 71 if needed
- **Webhook event replay tool** — backlog
- **Dashboard widget showing inbound webhook event rate** — phase 71 metrics

</deferred>

---

*Phase: 70-webhooks-whatsapp*
*Context gathered: 2026-05-18 via --auto mode + scope correction post user feedback*
