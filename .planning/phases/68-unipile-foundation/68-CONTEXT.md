# Phase 68: Unipile Foundation - Context

**Gathered:** 2026-05-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Ship the foundation of `src/connectors/unipile/`: manifest registration, lazy SDK client, identifier resolver with KV cache, audit log, CRM bridge skeleton (logger-only for now), and the first end-to-end write tool `linkedin_send_connection` + read tool `linkedin_get_relationship_status`. Re-validate the Antoine Vercken connect flow that failed 2026-05-18 with Browserbase.

**In scope:**
- New connector wired into `src/core/registry.ts` lazy loader
- Unipile Node SDK singleton with exponential backoff retry (5xx/429, max 3)
- `linkedin.com/in/<slug>` → Unipile URN resolver with KV-backed cache
- KV-backed audit log keyed by `audit_id`
- CRM bridge **interface** + Twenty adapter **skeleton** (writes audit + `crm_log: 'pending'`, no actual Twenty integration yet)
- 2 tools shipped: `linkedin_send_connection` (write) + `linkedin_get_relationship_status` (read)
- Verify-after-write polling: 3 polls at 2s/5s/10s

**Out of scope (deferred to phase 69-71):**
- Other LinkedIn write tools (send_message, send_inmail, engage, list_pending) → phase 69
- Per-account rate-limiter (LINKEDIN_DAILY_CONNECT_CAP etc.) → phase 69
- Webhook ingress `/api/unipile/webhook` → phase 70
- Actual Twenty CRM integration (`UNIPILE_CRM_WEBHOOK_URL` POST + retry cron) → phase 70
- All WhatsApp tools → phase 70
- Kill switches, metrics dashboard, audit query API → phase 71

</domain>

<decisions>
## Implementation Decisions

### CRM Bridge V1 — Twenty
- **D-01:** Phase 68 ships the CRM bridge **interface and skeleton only** — no actual Twenty integration. The `crm-bridge.ts` writes the outbox entry to KV with `status: 'pending'` and stops there. Twenty propagation lands in phase 70 (CRM handlers). Rationale: keeps phase 68 focused on the foundation; avoids being blocked by a Twenty integration choice.
- **D-02:** When Twenty integration lands (phase 70), it WILL use the **outbox webhook pattern** (POST to `UNIPILE_CRM_WEBHOOK_URL` per-tenant, HMAC-signed) — not direct Twenty REST API calls. Locked now to anchor the interface design.
- **D-03:** HMAC secret for outbound CRM webhooks is **per-tenant**, via env var `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (e.g. `UNIPILE_CRM_WEBHOOK_SECRET_CADENS_001`). Rationale: consistent with v0.11 multi-tenant isolation; one secret compromise = one tenant exposed.
- **D-04:** Retry strategy for failed CRM webhook deliveries (phase 70 implementation): **exponential cron** at 1min, 5min, 30min. After 3 failures, status = `dead`, surfaced in `/config` dashboard. Pattern reuses the cron skeleton from phase 63 (`/api/cron/update-check`). For phase 68: just write `status: 'pending'`, no actual send, no retry.

### Audit Log
- **D-05:** `params_hash` is **strict** — SHA-256 of `{tool_name, profile_url_normalized, note_text}`. Same profile + same note text = dedup hit. Changing 1 char in the note = new call allowed. Rationale: protects against re-spam without blocking legitimate re-engagement with a different message.
- **D-06:** **No `dedup_key` override** — the caller cannot bypass dedup logic. Consequence: if you want to relance the same person with the same note 90 days later, the dedup will block it. Either change the note or call with a re-engage flag (TBD if needed in phase 69).
- **D-07:** Note text is **never stored in KV** — only the hash. The caller (CRM) holds the source text. Rationale: GDPR — no PII duplication in Kebab. Audit log row contains: `{actor_user_id, tool, account_id, params_hash, result, verified, dedup_hit, timestamp, audit_id}`.
- **D-08:** Audit log TTL: **90 days** in KV (Upstash native `EX 7776000`). Rationale: long enough for investigation post-incident, short enough for GDPR. No env var override in phase 68 (defaults-only); can add `UNIPILE_AUDIT_TTL_DAYS` later if needed.

### Identifiers Cache (profile_url → URN)
- **D-09:** Cache lives in **KV Upstash only** (no in-memory LRU). Key format: `unipile:urn:<sha256(normalized_url)>`. Value: `{urn, resolved_at, ttl}`. Rationale: Vercel lambdas don't share RAM; in-memory tier adds complexity for marginal warm-burst benefit at Cadens scale (5-30 calls/day).
- **D-10:** TTL **30 days**. On cache miss → resolve via Unipile + write KV. On Unipile 429 rate limit → return **explicit error** to caller (no stale-while-revalidate). Rationale: honest failure beats false confidence; rate limits are loud signals.
- **D-11:** Manual invalidation via **admin REST endpoint** `DELETE /api/admin/unipile/cache/urn?profile_url=...` (admin auth, follows existing `/api/admin/*` patterns). No MCP tool exposure — cache invalidation is maintenance, not LLM-visible.
- **D-12:** URL normalization rules (handle in `lib/identifiers.ts`):
  - Lowercase the slug
  - Strip trailing slash
  - Strip locale prefix (`fr.linkedin.com` → `linkedin.com`, `de.linkedin.com` → `linkedin.com`)
  - Accept both `linkedin.com/in/<slug>` and `https://linkedin.com/in/<slug>` and `www.linkedin.com/in/<slug>`
  - Unit tests cover all 4 variants

### Verify-After-Write — Strict Mode (Anti-Antoine-Vercken)
- **D-13:** After 3 polls at 2s/5s/10s (~17s total), if Unipile API still doesn't confirm the connection request reached LinkedIn, the tool returns **`verified: false`** — strict mode. NOT `'pending'`, NOT optimistic. Rationale: the 2026-05-18 incident proved that ambiguous "probably sent" states erode operator trust catastrophically. Better to surface "we don't know" as a hard error.
- **D-14:** Tool return envelope: `{provider_ok: bool, verified: bool, crm_sync: 'pending', dedup_hit: bool, audit_id: string, invitation_id?: string, error?: string}`. **No `'pending'` enum value anywhere.** `verified` is strictly boolean.
- **D-15:** When `verified: false` due to 3-poll timeout, the audit log records `result: 'unverified_timeout'` (distinct from `result: 'error_xxx'` for explicit Unipile failures). This lets the dashboard distinguish "Unipile said no" from "we never got confirmation".
- **D-16:** **No auto re-poll** in phase 68. Caller (Claude / CRM) is responsible for re-calling `linkedin_get_relationship_status` later if they want to refresh state. Phase 71 may add a metric `unipile_send_unverified_count` so we detect if `verified: false` rate becomes anomalous.
- **D-17:** CRM display semantics (when phase 70 integration lands): `verified: false` → CRM shows **"Erreur d'envoi - retry"** (red icon). NOT "envoyée orange ambigu". Operator must explicitly re-trigger.

### Amendments After Research (2026-05-18, post-RESEARCH.md)
- **D-18:** All `unipile:*` KV keys are **tenant-prefixed** via `getContextKVStore()` (e.g. `tenant:<id>:unipile:audit:<audit_id>`). The admin DELETE eviction endpoint uses the root-scope escape hatch (like phase 53 metrics). Resolves RESEARCH.md Open Q2.
- **D-19:** `testConnection()` implementation calls `client.account.getAll()` and verifies `≥1 LinkedIn account` is connected. Returns `unhealthy` if no LinkedIn account is wired, even if the API token itself is valid. Reason: silent "active but unusable" connectors mislead operators. Resolves RESEARCH.md Open Q3 (the CONTEXT.md `/account/me` reference is incorrect — the SDK doesn't expose it).
- **D-20:** `account_id` param on `linkedin_send_connection` is **optional**. Resolution rules: (a) if exactly one LinkedIn account is connected → use it silently; (b) if zero → throw `error_no_linkedin_account`; (c) if multiple → throw `error_account_id_required` with the list of available accounts in the error body. Resolves RESEARCH.md Open Q4.
- **D-21:** `linkedin_get_relationship_status` envelope in phase 68 = `{degree, connection_status}` only. The `last_message_at` + `has_replied` fields from CONTEXT.md's earlier draft are **dropped from phase 68** — Unipile doesn't expose them on `getProfile`. Will be added in phase 69 when messaging tools (`client.messaging.getAllMessagesFromChat`) land. Resolves RESEARCH.md Open Q5.

### Claude's Discretion
- Choice of hashing function for `params_hash` (SHA-256 truncated to 16 hex chars recommended for KV key efficiency)
- Internal structure of `client.ts` retry middleware (axios interceptor, fetch wrapper, SDK middleware — whatever the SDK supports natively)
- Error code taxonomy for `result` field (suggest: `success`, `unverified_timeout`, `error_rate_limit`, `error_not_connected`, `error_account_restricted`, `error_unipile_5xx`)
- Test strategy split between unit (URL normalization, hashing, KV mock) and integration (SDK sandbox or full mock)

### Folded Todos
None — no pending todos matched phase 68 scope.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture Decisions
- `docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md` — Why Unipile over LinkedAPI/Browserbase Scale; tool catalog; cost; risks; Plan B.

### Milestone Scope
- `.planning/milestones/v0.17-unipile-connector-ROADMAP.md` — Full 4-phase breakdown (68-71), 24 requirements (UNI-01..24), success criteria.

### Existing Patterns (read for analogues)
- `src/connectors/apify/manifest.ts` — Connector manifest pattern, lazy tool registration via `defineTool({})`
- `src/connectors/apify/lib/client.ts` — SDK singleton + lazy init pattern (analogue for `unipile/lib/client.ts`)
- `src/connectors/webhook/manifest.ts` — Webhook receiver pattern (NOT used for Unipile — Unipile gets its own `/api/unipile/webhook` in phase 70, but the HMAC validation pattern is reusable)
- `src/core/kv-store.ts` — KV abstraction layer used for audit log + URN cache + outbox
- `src/core/registry.ts` — Lazy connector loader (manifest must be registered here per UNI-01)
- `src/core/credential-store.ts` — Cred hydration pattern for `UNIPILE_DSN`, `UNIPILE_TOKEN`, `UNIPILE_CRM_WEBHOOK_URL`, `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT>`
- `app/api/cron/update-check/route.ts` (phase 63) — Cron route template (will be reused in phase 70 for CRM retry cron)

### External Docs (Unipile)
- https://developer.unipile.com/docs/linkedin — LinkedIn endpoints catalog
- https://developer.unipile.com/docs/provider-limits-and-restrictions — Rate limits to respect (LinkedIn 80-100 connects/day on paid)
- https://github.com/unipile/unipile-node-sdk — Node SDK source (for retry middleware integration)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/core/kv-store.ts`** — Existing KV abstraction. Use for `unipile:audit:<audit_id>`, `unipile:urn:<hash>`, `unipile:outbox:<audit_id>` keys. KV allowlist must be updated (`kv-allowlist` Rule 3 contract test).
- **`src/core/credential-store.ts`** — Hydrates env vars from KV (`hydrateCredentialsStep`). Unipile env vars (`UNIPILE_DSN`, `UNIPILE_TOKEN`) must be added to the hydration list. Phase 62 fix (`f623119`) ensures transient KV failures don't poison the lambda — leverage that for new credentials.
- **`src/connectors/apify/lib/client.ts`** — Direct analogue for `unipile/lib/client.ts`: lazy singleton, env-validated init, scoped error handling.
- **`src/connectors/apify/manifest.ts`** — Direct analogue for tool definition wrapping (`defineTool({})`), `isActive(env)` predicate based on required env vars.
- **`src/core/connector-errors.ts`** — Standard error taxonomy. Unipile should emit `[CONNECTOR:unipile]` tagged errors via this module.

### Established Patterns
- **Logger tags:** `[CONNECTOR:unipile]` for all connector logs (matches `[CONNECTOR:apify]`, `[CONNECTOR:browser]` convention).
- **Manifest registration:** Lazy in `src/core/registry.ts` — added once, surfaced in `toolCount`, picked up by `npx tsx scripts/contract-test.ts` automatically.
- **Test layering:**
  - Unit: hashing, URL normalization, KV key generation (pure functions, no I/O)
  - Integration: against mocked Unipile SDK (no live API calls in CI)
  - Manual: live test via Antoine Vercken connect attempt (re-validates the 2026-05-18 incident)
- **Doc-counts gate:** `scripts/check-doc-counts.ts` will fail if connector count or tool count in docs drifts — update `docs/CONNECTORS.md` and any tool catalog tables as part of phase 68 commits (UNI-23 is phase 71, but the count drift gate fires earlier).

### Integration Points
- `src/core/registry.ts` — Add Unipile manifest to lazy loader map
- `src/core/credential-store.ts` — Add `UNIPILE_*` env vars to hydration list
- KV allowlist (contract test) — Add `unipile:audit:*`, `unipile:urn:*`, `unipile:outbox:*` patterns
- No new UI in phase 68 (`/config` connector tile appears automatically once manifest registers + `isActive(env)` returns true)

### Creative Options
- Unipile SDK might expose a webhook subscription bootstrap (instead of manual dashboard config). If so, phase 68's `testConnection()` could optionally verify webhook subscription state — flag for phase 70.
- The audit log could double as a "what did I send today" tool for free (e.g., `linkedin_audit_today` listing recent sends) — but that belongs in phase 71 (UNI-22 admin audit query API).

</code_context>

<specifics>
## Specific Ideas

- **Anti-pattern explicitly forbidden:** The "verified: pending" state. Antoine Vercken (2026-05-18) failed silently with Browserbase under exactly this kind of "probably sent, maybe?" semantics. Phase 68 hardcodes the lesson: `verified` is strictly boolean. If we don't know, that's `false`. Period.
- **Test E2E target:** Re-run the Antoine Vercken connect attempt against Unipile sandbox (or real account if available). Must produce `verified: true` within 17s OR explicit `verified: false` with `result: 'unverified_timeout'` — never silent success.
- **Naming:** Tool names use snake_case, prefixed with channel: `linkedin_send_connection`, `linkedin_get_relationship_status`. Matches `apify_linkedin_profile` etc. convention.

</specifics>

<deferred>
## Deferred Ideas

- **Twenty CRM actual integration** — written off phase 68 explicitly. Phase 70 owns it. Phase 68 ships the interface + skeleton + `pending` status only.
- **In-memory LRU tier for URN cache** — considered, rejected (Vercel serverless, marginal benefit at our scale).
- **`unipile_audit_today` tool** — interesting QoL but belongs to UNI-22 (phase 71).
- **Auto re-poll of `pending` verifications** — N/A since we eliminated `pending`. If we ever re-introduce it, a cron pattern is ready (see D-04).
- **Configurable `UNIPILE_AUDIT_TTL_DAYS` env var** — defaults-only in phase 68. Add if a tenant requests longer retention.
- **`dedup_key` override** — explicitly rejected (D-06). The strict dedup is a feature.

</deferred>

---

*Phase: 68-unipile-foundation*
*Context gathered: 2026-05-18*
