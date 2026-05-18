# Phase 70 — Pattern Map (REWRITTEN 2026-05-18 post scope correction)

**Scope after correction:** Webhook INGRESS + halt-flag retrofit only. WhatsApp tools dropped (deferred to backlog). NO outbound CRM, NO TwentyAdapter, NO cron. See `70-CONTEXT.md` "Out of scope" section for the explicit exclusion list.

## Files to be created/modified

| # | File | Status | Analog | Notes |
|---|------|--------|--------|-------|
| 1 | `app/api/unipile/webhook/route.ts` | **SHIPPED** (Plan 70-01, commit `40ca1ca`) | `src/connectors/webhook/route.ts` | Dual-mode verifier (HMAC + static) per D-52, body parse handles wrong content-type (D-77), idempotency via KV `setIfNotExists` (D-54), fire-and-forget dispatch (D-55) |
| 2 | `src/connectors/unipile/webhook/verifier.ts` | **SHIPPED** (`3b080ea`) | `src/connectors/webhook/route.ts:44-55` | `timingSafeEqual` HMAC + static fallback only on HMAC header ABSENCE (D-52 downgrade guard) |
| 3 | `src/connectors/unipile/webhook/dispatcher.ts` | **SHIPPED** (`40ca1ca`) | NEW (no analog) | Routes `event_type` → handler. Stub handlers in Plan 70-01, real handlers in Plan 70-02. |
| 4 | `src/connectors/unipile/webhook/halt-flag.ts` | **SHIPPED** (`3b080ea`) | `src/connectors/unipile/lib/audit.ts` KV pattern | `isHalted/setHaltFlag/clearHaltFlag` via `getContextKVStore()` per D-18 |
| 5 | `src/connectors/unipile/webhook/account-tenant-index.ts` | **SHIPPED** (`3b080ea`) | NEW reverse-index pattern | Root-scope `getKVStore()` because webhook ingress has no tenant context (D-56). New kv-allowlist entry. |
| 6 | `scripts/setup-unipile-webhooks.ts` | **SHIPPED** (`381b7fe`) | None — Node script using SDK directly | Bootstrap 3 webhook subscriptions, idempotent. Uses SDK escape hatch for `users` source (D-68). |
| 7 | `src/connectors/unipile/webhook/handlers/account-status.ts` | **TODO** (Plan 70-02) | `webhook/halt-flag.ts` (just shipped) | Set/clear halt flag on status transitions (D-57/D-58) |
| 8 | `src/connectors/unipile/webhook/handlers/new-relation.ts` | **TODO** (Plan 70-02) | `lib/audit.ts::writeAuditRow` | Enrich audit row with `accepted_at` OR insert `inbound_accept_unknown_origin` (D-61/D-62) |
| 9 | `src/connectors/unipile/webhook/handlers/new-message.ts` | **TODO** (Plan 70-02) | `lib/audit.ts::writeAuditRow` | Skip `is_sender:true` echoes (D-63), update `last_replied_at` or `inbound_message_unknown_origin` (D-64). Content_hash only, never body (D-64). |
| 10 | `src/connectors/unipile/lib/audit.ts` | **MODIFY** (Plan 70-02) | Existing | Add 3 new `AuditResult` members: `error_account_halted`, `inbound_accept_unknown_origin`, `inbound_message_unknown_origin` (D-78). Add `findAuditByProviderId()` read helper for handlers. |
| 11 | All 4 write tools (`linkedin-send-connection`, `-message`, `-inmail`, `engage`) | **RETROFIT** (Plan 70-03) | `webhook/halt-flag.ts::isHalted` | Add Step 0 halt-check BEFORE dedup (D-65/D-66). Four sites total (no WhatsApp anymore). |
| 12 | `src/connectors/unipile/manifest.ts` + `manifest.test.ts` | **NO CHANGE** | Existing | Still 6 tools — WhatsApp dropped. No toolCount bump in phase 70. |
| 13 | `src/core/registry.ts` | **NO CHANGE** | Existing | Still toolCount: 6 |
| 14 | `content/docs/connectors.md` + `README.md` | **NO CHANGE** | Existing | Still 97 tools — no delta |

## Pattern excerpts (for handlers — Plan 70-02 consumes)

### Halt flag write (`webhook/halt-flag.ts::setHaltFlag` — already shipped)
```typescript
export async function setHaltFlag(accountId: string, reason: string, status: string): Promise<void> {
  const kv = getContextKVStore();
  await kv.set(`unipile:halt:${accountId}`, { reason, halted_at: new Date().toISOString(), status });
}
```
→ Use in `handlers/account-status.ts` when transitioning to error state.

### Audit row update (no existing helper — Plan 70-02 must ADD `findAuditByProviderId` to `lib/audit.ts`)
```typescript
// NEW in lib/audit.ts (Plan 70-02 Task 1):
export async function findAuditByProviderId(providerId: string): Promise<AuditRow | null> {
  const kv = getContextKVStore();
  const keys = await kv.list("unipile:audit:");
  for (const key of keys) {
    if (key.includes(":hash:")) continue;  // skip dedup pointers
    const row = await kv.get(key) as AuditRow | null;
    if (row?.provider_id_target === providerId) return row;
  }
  return null;
}
```
**Performance note:** O(n) KV scan. Acceptable at Cadens scale (~12k audit rows/year/tenant). Phase 71 may add a secondary index `unipile:audit:by-provider:<id>` if hot path.

### Echo skip (`handlers/new-message.ts`)
```typescript
export async function handleNewMessage(payload: NewMessagePayload): Promise<void> {
  if (payload.is_sender === true) {
    log.debug("[CONNECTOR:unipile] Skipping outbound echo", { event_id: payload.event_id });
    return;  // D-63: don't process our own outbound messages echoed back
  }
  // ... rest of handler
}
```

### Halt-check Step 0 (Plan 70-03 retrofit)
```typescript
// At the TOP of every write handler, BEFORE dedup:
const halted = await isHalted(accountId);
if (halted) {
  const auditId = generateAuditId();
  await writeAuditRow({ /* minimal halt row */, result: "error_account_halted" });
  return envelope({ verified: false, error: "error_account_halted", reason: halted.reason, halted_at: halted.halted_at, audit_id: auditId });
}
```

## What was REMOVED from the original PATTERNS.md (pre-scope-correction)

The original draft included these obsolete sections — DO NOT reintroduce:

- ~~`TwentyAdapter` real implementation (replacing skeleton)~~ — connector never POSTs out
- ~~Outbox state machine extension (`pending → sending → sent | failed | dead`)~~ — skeleton stays as phase 68 D-01
- ~~`app/api/cron/unipile-crm-retry/route.ts`~~ — no cron in phase 70
- ~~`vercel.json` cron registration~~ — N/A
- ~~`tools/whatsapp-send-message.ts` + 3 other WhatsApp tools~~ — DROPPED from phase 70 scope (user decision 2026-05-18)
- ~~`UnipileRateLimitedTool` union extension with `whatsapp_send`~~ — N/A no WhatsApp
- ~~`KEBAB_UNIPILE_NOTIFY_WEBHOOK_URL` env var~~ — no outbound notify from connector

If any of these resurface in a downstream artifact (executor, checker), flag as scope creep and reject.
