# Phase 70: Webhooks + WhatsApp V1 - Research

**Researched:** 2026-05-18
**Domain:** Unipile inbound webhook ingestion + WhatsApp messaging tools + Twenty CRM real adapter + Vercel cron
**Confidence:** HIGH (HMAC question resolved EMPIRICALLY against live tenant; WhatsApp + webhook payload + signing scheme captured from a real round-trip; SDK shapes verified by reading `node_modules/unipile-node-sdk/dist/types/`)

## Summary

Phase 70 turns the Unipile connector into a bidirectional integration: inbound webhooks land at a dedicated route, three event handlers wire into the existing audit log / outbox primitives, four WhatsApp tools mirror the LinkedIn handler skeleton, and the phase-68 Twenty `CrmAdapter` skeleton becomes a real HMAC-signed HTTP outbox flush with a retry cron.

**Decisive empirical finding (resolves D-52's "TBD" question):** I created a live messaging webhook on the provided tenant pointing at webhook.site, triggered a real `message_received` event, and captured the full request. **There is NO `X-Unipile-Signature` header.** Unipile sends ONLY the static custom headers configured at webhook-creation time, with user-agent `axios/1.7.7`. The defensive dual-mode HMAC + static-fallback design in D-52 is therefore **the right architecture**, but in practice the HMAC branch will never trigger on the live tenant — the static-header branch is the path Unipile actually takes. The dual-mode code is cheap insurance against (a) a future Unipile rollout, (b) a contradictory marketing page that mentions HMAC, and (c) tenant-specific differences we can't see — keep both branches, log which one fires, simplify after 30 days of real traffic per D-52.

**Second decisive finding:** the `new_relation` event lives under a SEPARATE webhook source called `"users"` (NOT `"messaging"`). The SDK's `WebhookCreateBodySchema` ONLY validates `messaging | account_status | email | email_tracking` — so creating the new_relation webhook from the typed SDK method **will fail TypeBox validation**. We must use `client.request.send({path:'webhooks', method:'POST', body:{source:'users', ...}})` escape hatch. The other two phase-70 webhooks (`account_status`, `messaging`) work through the typed SDK methods.

**Primary recommendation:** Implement THREE separate webhook subscriptions during operator onboarding (script + diagnostics in the unipile manifest), with one dedup KV row per `message_id` (24h TTL). Reply to Unipile within 30s by writing the dedup row synchronously and firing handlers via `void asyncFn().catch(log.error)` (matches the existing webhook receiver fire-and-forget convention). WhatsApp tools reuse the LinkedIn handler skeleton 1:1 — only the SDK call changes (`messaging.startNewChat` with `attendees_ids: ['<phone>@s.whatsapp.net']`). Twenty CRM real adapter implements the **Twenty webhook signature scheme** (HMAC-SHA256 over `timestamp:json_body`, `X-Twenty-Webhook-Signature` + `X-Twenty-Webhook-Timestamp` headers) so the outbox flush works against a vanilla Twenty install with no glue server.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Webhook Route (UNI-12)**
- **D-51:** Route at `app/api/unipile/webhook/route.ts` — DEDICATED, NOT the generic `app/api/webhook/[name]/route.ts` receiver. Per ADR 0001.
- **D-52 (amended 2026-05-18):** HMAC verification is **DEFENSIVE dual-mode** — verify HMAC-SHA256 of body via `X-Unipile-Signature` header first; if that header is absent OR mismatched, fall back to static-token equality check against `Unipile-Auth` header. Both checks use `timingSafeEqual`. Log which mode actually triggered (`hmac` vs `static`) per request for observability — after enough real traffic, we'll know which Unipile actually sends and can simplify (phase 71 or later). Empirically verify in execute-phase by inspecting the first real POST.
- **D-53:** Webhook secret env var: `UNIPILE_WEBHOOK_SECRET` (single global secret — Unipile sends one signature per webhook URL, not per-tenant). Multi-tenant routing happens INSIDE the handler via `account_id` lookup, not at the signature layer.
- **D-54:** Idempotency: KV key `unipile:webhook:event:<event_id>` with 24h TTL. If event already seen → return 200 immediately (acknowledge to Unipile, no re-processing). Per ROADMAP UNI-12.
- **D-55:** Reply within 30s budget. Heavy work (CRM propagation, notifications) MUST run async via background task or queued. For phase 70: simplest = `void` async fire-and-forget after writing the dedup row, return 200 immediately.

**account.status Handler (UNI-13)**
- **D-56:** On status transitions to error states (`credentials_expired`, `restricted`, `disconnected`), set connector-level halt flag in KV: `tenant:<id>:unipile:halt:<account_id>: {reason, halted_at, status}`. All write tools check this flag at the TOP of their handler (NEW pre-flight step — BEFORE dedup even).
- **D-57:** Halt flag surfaces in `/config → Connectors` dashboard tile (visual indicator). Implementation: extend existing `testConnection()` to read halt flags + return aggregate health.
- **D-58:** Optional operator notification: log.warn + (if `KEBAB_UNIPILE_NOTIFY_WEBHOOK_URL` env var set) POST `{tenant_id, account_id, status, halted_at}` to it. Simple Slack/Discord webhook compatible.

**new_relation Handler (UNI-14)**
- **D-59:** When Unipile emits `new_relation` (LinkedIn invitation accepted by recipient), the handler:
  1. Looks up the original audit row by `recipient_provider_id` (search dedup hash pointers) — best-effort, may not find
  2. Updates the matching outbox row: `status: 'pending' → 'completed'` + `completed_at: now`
  3. Triggers CRM webhook POST: `{event_type: 'linkedin.connection_accepted', recipient_profile_url, audit_id?, accepted_at}` to `UNIPILE_CRM_WEBHOOK_URL` per D-02
- **D-60:** If no matching audit row found (e.g., connection accepted from a request sent outside Kebab) → still POST CRM webhook with `{audit_id: null, source: 'external_invitation'}`. CRM decides what to do.

**new_message Handler (UNI-15)**
- **D-61:** When Unipile emits `message.received` (LinkedIn DM or WhatsApp inbound), the handler:
  1. Updates outbox row last-replied-at if applicable
  2. Triggers CRM webhook POST: `{event_type: 'linkedin.message_received'|'whatsapp.message_received', sender_profile_url|sender_phone, content_hash, received_at}` to `UNIPILE_CRM_WEBHOOK_URL`
- **D-62:** **NEVER POST the message body to the CRM webhook.** Only content_hash (SHA-256, truncated) — consistent with D-07 PII rules from phase 68. CRM can fetch full body via `whatsapp_get_conversation` if needed.
- **D-63:** Optional Slack notification: if `KEBAB_UNIPILE_INBOUND_NOTIFY=true` AND `KEBAB_UNIPILE_NOTIFY_WEBHOOK_URL` set, POST a Slack-compatible payload `{text: "📩 New LinkedIn DM from X"}`. Opt-in, defaults false.

**Real Twenty CRM Integration**
- **D-64:** `lib/crm-bridge.ts` `TwentyAdapter` class implements `CrmAdapter` interface (replaces `TwentyAdapterSkeleton`). Method `notifyEvent({event_type, payload, tenant_id})` POSTs to `UNIPILE_CRM_WEBHOOK_URL_<TENANT_ID>` (per-tenant URL) with HMAC-SHA256 signature `X-Kebab-Signature` using `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (per-tenant secret per D-03).
- **D-65:** Outbox row state machine: `pending → sending → sent | failed`. Cron `/api/cron/unipile-crm-retry` retries `failed` rows with exponential backoff per D-04 (1min, 5min, 30min). After 3 failures → `status: 'dead'`, surfaced in dashboard.
- **D-66:** Cron schedule: every 2 minutes (Vercel cron expression `*/2 * * * *`).
- **D-67:** Backward compat: phase 68 `TwentyAdapterSkeleton` deprecated but kept exported (no breaking change).

**WhatsApp Tools (UNI-16..19)**
- **D-68:** All 4 WhatsApp tools share the same handler skeleton as LinkedIn (dedup → account → rate-limit → SDK call → audit). Rate-limit reuses `lib/rate-limiter.ts` with new tool keys: `whatsapp_send`, default cap `KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP=200`. Read tools NOT rate-limited.
- **D-69:** `whatsapp_send_message` recipient resolution: accepts `to` as (a) E.164 phone, (b) existing `chat_id` (skip resolution), (c) contact name → resolve via `whatsapp_list_contacts` filter. Plan picks (a) + (b) first, (c) deferred.
- **D-70:** Attachments: same `{filename, mimetype, base64}` shape as LinkedIn (D-46), max 15MB.
- **D-71:** `whatsapp_list_chats` default limit 20, max 100. Sort by `last_message_at DESC`.
- **D-72:** `whatsapp_get_conversation` default limit 50, max 200. Pagination via Unipile cursor.
- **D-73:** `whatsapp_list_contacts` returns `{contact_id, name, phone_e164, has_chat}`. `query?` optional substring filter (client-side).
- **D-74:** WhatsApp tool result envelope mirrors LinkedIn: `{provider_ok, verified, dedup_hit, audit_id, message_id?, error?}`. For reads: just the data array + cursor.

**Multi-tenant + halt flag enforcement**
- **D-75:** ALL write tools (LinkedIn + WhatsApp) gain a NEW pre-flight step: check halt flag for `account_id`. If halted → return `{error: 'error_account_halted', reason, halted_at}` immediately, no dedup, no rate-limit, no audit row beyond a single halt-noted entry. This is BEFORE D-49's dedup-first ordering (halt is highest priority).

### Claude's Discretion
- Choice of background task mechanism (recommend: `void asyncFn().catch(log.error)` since Vercel doesn't expose proper queue without extra deps).
- Twenty payload shape exact fields beyond minimum.
- Cron retry exact backoff curve.
- Dashboard halt indicator UI (just text "⚠ halted" — no fancy modal in this phase).

### Deferred Ideas (OUT OF SCOPE)
- WhatsApp groups, reactions, read receipts — V2.
- Email + Calendar Unipile channels — out of milestone.
- Contact name fuzzy resolution in `whatsapp_send_message` (D-69 c) — phase 71 if needed.
- Real CRM beyond Twenty (HubSpot, Pipedrive native) — only when a 2nd tenant demands.
- Webhook event replay tool — backlog.
- Dashboard widget showing inbound webhook event rate — phase 71 metrics.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UNI-12 | `/api/unipile/webhook` route — HMAC verify, idempotency, 30s reply | §1, §2, §3 |
| UNI-13 | `account.status` handler with halt flag KV writes | §2 (account_status event shape) + §7 (new enum members) |
| UNI-14 | `new_relation` handler — outbox row update + CRM POST | §1 (users source escape hatch) + §2 + §6 |
| UNI-15 | `message.received` / `message_received` handler — CRM POST, no body PII | §2 (empirical payload) + §6 |
| UNI-16 | `whatsapp_send_message` — E.164 / chat_id resolution, attachments | §4 |
| UNI-17 | `whatsapp_list_chats` — limit + cursor pagination | §4 |
| UNI-18 | `whatsapp_get_conversation` — limit + cursor pagination | §4 |
| UNI-19 | `whatsapp_list_contacts` — local substring filter, has_chat flag | §4 |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Inbound HTTP webhook ingress | API/Backend (`app/api/unipile/webhook/route.ts`) | — | Vercel lambda, runs HMAC + dedup + dispatch under 30s |
| Webhook signature verification | API/Backend (in-route) | — | `node:crypto.createHmac` + `timingSafeEqual` — no shared infra needed; pattern mirrors `src/connectors/webhook/route.ts` lines 44-55 |
| Idempotency KV writes | API/Backend (KV) | — | `unipile:webhook:event:<id>` 24h TTL — uses **root-scope `getKVStore()` not tenant** because webhook events arrive un-authenticated and route to a tenant via `account_id` lookup INSIDE the handler |
| Halt-flag pre-flight check | API/Backend (tool handler) | — | KV read at top of every write tool — added to LinkedIn 3 tools + WhatsApp 1 write tool (4 retrofits + 1 new) |
| WhatsApp SDK calls | API/Backend (lambda) | — | Same lazy singleton as LinkedIn — reuse `getUnipileClient()` |
| Twenty CRM HTTP POST (outbox flush) | API/Backend (cron lambda) | API/Backend (synchronous flush in webhook handler too — opportunistic) | Cron is the durable retry path; synchronous flush is a low-latency fast-path |
| Cron retry execution | API/Backend (`/api/cron/unipile-crm-retry`) | — | Vercel cron at `*/2 * * * *`; scans outbox keys with `status in (pending, failed)` and tries to deliver |
| Halt flag display on connector tile | Frontend Server (RSC) | Browser | Extends existing `testConnection()` — no NEW UI route in phase 70 |

## Standard Stack

### Core (already installed phase 68)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `unipile-node-sdk` | 1.9.3 | SDK lazy singleton — same as phase 68 [VERIFIED: `node_modules/unipile-node-sdk/package.json`] | Already vendored |

### Supporting (already in stack)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node `crypto` (built-in) | — | HMAC-SHA256 verify (inbound) + sign (outbound CRM); `timingSafeEqual` for comparison | Webhook route + Twenty adapter — pattern mirrored from `src/connectors/webhook/route.ts:49-54` |
| `@/core/kv-store` `getKVStore()` | — | Root-scope KV for cross-tenant webhook dedup keys | **Webhook idempotency keys ONLY** — these are root-scope per allowlist (no tenant context at ingress time) |
| `@/core/request-context` `getContextKVStore()` | — | Tenant-scoped KV for halt flags, outbox rows, audit rows | All handler logic AFTER tenant routing |
| `@/core/config-facade` `getConfig()` | — | Read env vars (UNIPILE_WEBHOOK_SECRET, UNIPILE_CRM_WEBHOOK_URL_*, UNIPILE_CRM_WEBHOOK_SECRET_*) | Never `process.env` directly (Phase 48 lint rule `kebab/no-direct-process-env`) |
| `@/core/pipeline` `composeRequestPipeline` | — | Standard Vercel-route composition with rehydrateStep + bodyParseStep | Pattern from `src/connectors/webhook/route.ts:139-146` — REUSE for `app/api/unipile/webhook/route.ts` |
| `@/core/error-utils` `toMsg()` | — | Stringify unknown errors in fire-and-forget catches | Pattern from `app/api/cron/health/route.ts:99-103` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `void asyncFn().catch(log.error)` for async handlers (D-55) | BullMQ / Vercel Queues / external queue | Adds infra + dep + per-tenant config. At Cadens scale (handful of webhooks/day), fire-and-forget under a 30s lambda budget is fine — Vercel keeps the lambda alive for 30s post-response by default. **Verdict: hand-roll fire-and-forget.** |
| Generic `app/api/webhook/[name]/route.ts` (existing) for Unipile | Reuse the existing pattern | The existing receiver is a generic store-and-forward; Unipile needs typed handlers, halt-flag writes, CRM dispatch, idempotency. Squeezing it into the generic shape requires the generic receiver to grow knowledge of Unipile events — wrong direction. **Verdict (locked D-51):** dedicated route. |
| Twenty's REST API for status sync | Direct Twenty SDK calls instead of webhook outbox | Direct SDK = synchronous, no retry, no decoupling. Outbox = durable + observable + decoupled — operator can swap CRM behind the same webhook contract. **Verdict (locked D-02):** outbox webhook only. |
| ISO-8601 timestamp comparison for cron retry scheduling | Cron-job heartbeat with `last_attempt_at` int | Both work; ISO is human-readable, ints are faster to compare. Sticking with ISO for consistency with audit log (`timestamp: ISO-8601`). |

**Installation:** None. Phase 70 adds zero new dependencies — all infra reuses what phase 68/69 already brought in.

**Version verification:** `unipile-node-sdk` is unchanged from phase 68 [VERIFIED: `npm view unipile-node-sdk version` returns 1.9.3, no new release since phase 68 research 2026-05-18]. No package upgrades planned.

## Architecture Patterns

### System Architecture Diagram

```
                ┌─────────────────────────────────────────────────────┐
   UNIPILE      │              app/api/unipile/webhook/route.ts        │
   (axios/1.7.7)│  ┌────────────────────────────────────────────────┐  │
   POST ──────▶│  │ 1. composeRequestPipeline(rehydrate,bodyParse) │  │
                │  │ 2. HMAC-SHA256 verify body x X-Unipile-Sig     │  │
                │  │    OR fallback static-eq Unipile-Auth header   │──┼─▶ 401 on mismatch
                │  │    (both via timingSafeEqual) — log which fired│  │
                │  │ 3. Idempotency: kv.setIfNotExists(             │  │
                │  │      unipile:webhook:event:<message_id>, 24h)  │──┼─▶ if seen: 200 immediately
                │  │ 4. void dispatchEventAsync(event).catch(log)   │  │   (root-scope KV — no tenant ctx)
                │  │ 5. return 200 (Unipile happy under 30s)        │  │
                │  └─────────────────┬──────────────────────────────┘  │
                │                    │ async branch                    │
                │                    ▼                                 │
                │  ┌────────────────────────────────────────────────┐  │
                │  │  dispatchEventAsync(payload):                  │  │
                │  │   switch (payload.event) {                     │  │
                │  │     'account_status':   → handleAccountStatus  │──┼─▶ KV: tenant:<id>:unipile:halt:<acc>
                │  │     'new_relation':     → handleNewRelation    │──┼─▶ outbox row update + CRM POST
                │  │     'message_received': → handleMessageReceived│──┼─▶ CRM POST (hash only, no body)
                │  │   }                                            │  │
                │  └────────────────────────────────────────────────┘  │
                └─────────────────────────────────────────────────────┘
                                                              │
                                                              ▼ (D-02 outbox)
                ┌─────────────────────────────────────────────────────┐
                │  src/connectors/unipile/lib/crm-bridge.ts            │
                │   TwentyAdapter (REPLACES TwentyAdapterSkeleton):    │
                │   - read UNIPILE_CRM_WEBHOOK_URL_<TENANT_ID>         │
                │   - read UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>      │
                │   - HMAC-SHA256 body, X-Kebab-Signature header       │
                │   - POST to webhook URL                              │
                │   - 2xx → status='sent'                              │
                │   - other → status='failed' (attempts++)             │
                └─────────────────────────────────────────────────────┘
                                                              ▲
                                                              │ (cron retry)
                ┌─────────────────────────────────────────────────────┐
                │  app/api/cron/unipile-crm-retry/route.ts             │
                │   GET (vercel.json: */2 * * * *)                     │
                │   1. authStep('cron') — CRON_SECRET                  │
                │   2. scan unipile:outbox:* (status in pending|failed)│
                │   3. for each due row: call TwentyAdapter.notifyEvent│
                │   4. update row (sent/failed+attempts++/dead at 3)   │
                └─────────────────────────────────────────────────────┘

                ┌─────────────────────────────────────────────────────┐
                │  WhatsApp tool handlers (4 NEW)                      │
                │   whatsapp_send_message      → messaging.startNewChat│
                │       (attendees_ids:['<E164>@s.whatsapp.net'])      │
                │   whatsapp_list_chats        → messaging.getAllChats │
                │       (account_type='WHATSAPP', limit, cursor)       │
                │   whatsapp_get_conversation  → messaging.getAllMsgs… │
                │   whatsapp_list_contacts     → messaging.getAllAttend│
                │  Handler skeleton: halt-check → dedup → account →    │
                │   rate-limit → SDK call → audit → envelope           │
                └─────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/connectors/unipile/
├── tools/
│   ├── whatsapp-send-message.ts        # NEW (UNI-16)
│   ├── whatsapp-list-chats.ts          # NEW (UNI-17)
│   ├── whatsapp-get-conversation.ts    # NEW (UNI-18)
│   └── whatsapp-list-contacts.ts       # NEW (UNI-19)
├── webhook/                            # NEW directory
│   ├── verifier.ts                     # dual-mode HMAC + static verification
│   ├── dispatcher.ts                   # switch on event type → handler
│   ├── halt-flag.ts                    # KV read/write for halt flags + read in handlers
│   └── handlers/
│       ├── account-status.ts           # UNI-13
│       ├── new-relation.ts             # UNI-14
│       └── message-received.ts         # UNI-15
├── lib/
│   ├── crm-bridge.ts                   # REPLACE TwentyAdapterSkeleton → TwentyAdapter
│   ├── rate-limiter.ts                 # extend union with `whatsapp_send`
│   └── whatsapp-recipient.ts           # NEW — E.164 → `<phone>@s.whatsapp.net` resolver
└── manifest.ts                         # +4 tools, toolCount 6 → 10

app/api/unipile/webhook/route.ts        # NEW (UNI-12)
app/api/cron/unipile-crm-retry/route.ts # NEW (D-66)
vercel.json                             # +1 cron entry
```

### Pattern 1: Dual-mode signature verification (D-52)
**What:** Try HMAC first; fall back to static-secret comparison if no `X-Unipile-Signature` header or signature mismatch. Both checks use `timingSafeEqual` on hashed buffers.
**When to use:** Inside `app/api/unipile/webhook/route.ts`, after `bodyParseStep` provides the raw body.
**Example:**
```typescript
// src/connectors/unipile/webhook/verifier.ts
// Source: pattern adapted from src/connectors/webhook/route.ts:44-55
//         + empirical finding 2026-05-18 (no X-Unipile-Signature seen in live tenant)
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export type VerifyMode = "hmac" | "static" | "rejected";
export interface VerifyResult { mode: VerifyMode; ok: boolean; reason?: string }

export function verifyUnipileWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
): VerifyResult {
  // Path 1: HMAC-SHA256 of raw body via X-Unipile-Signature (if header present)
  const sig = headers.get("x-unipile-signature");
  if (sig) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const expHash = createHash("sha256").update(expected).digest();
    const sigHash = createHash("sha256").update(sig).digest();
    if (timingSafeEqual(expHash, sigHash)) return { mode: "hmac", ok: true };
    // HMAC header present but mismatched — REJECT (do NOT fall through; that
    // would be an unsafe downgrade attack vector)
    return { mode: "hmac", ok: false, reason: "hmac_mismatch" };
  }

  // Path 2: static-secret equality on Unipile-Auth header (the empirical
  // path — this is what the live tenant uses 2026-05-18)
  const authHdr = headers.get("unipile-auth");
  if (authHdr) {
    const a = createHash("sha256").update(secret).digest();
    const b = createHash("sha256").update(authHdr).digest();
    if (timingSafeEqual(a, b)) return { mode: "static", ok: true };
    return { mode: "static", ok: false, reason: "static_mismatch" };
  }

  return { mode: "rejected", ok: false, reason: "no_signature_or_auth_header" };
}
```
**Why hash-then-compare:** `timingSafeEqual` throws on different-length buffers. Hashing both sides to fixed-length sha256 digests prevents leaking length info AND avoids the throw — same idiom as the existing webhook receiver (lines 49-54).

### Pattern 2: Idempotent dedup via setIfNotExists (D-54)
**What:** Atomic SET-NX on `unipile:webhook:event:<message_id>` with 24h TTL. If returns "already exists" → respond 200 to Unipile, do NOT re-dispatch.
**When to use:** Right after signature verification, BEFORE the async dispatch.
**Example:**
```typescript
// src/connectors/unipile/webhook/route-helper.ts
// Source: setIfNotExists pattern from app/api/cron/update-check/route.ts:65-72
//         + KVStore.setIfNotExists is on the Upstash + Filesystem backend
//         (Phase 49 verified). FilesystemKV honors the NX semantic in dev.
import { getKVStore } from "@/core/kv-store";  // ROOT scope — webhook is pre-tenant

export async function checkAndMarkSeen(eventId: string): Promise<boolean> {
  const kv = getKVStore();
  if (typeof kv.setIfNotExists !== "function") {
    // Should never happen on Upstash; FilesystemKV does support it.
    // Fail-open to avoid blocking legitimate events under dev-only KV impl.
    return false;
  }
  const r = await kv.setIfNotExists(`unipile:webhook:event:${eventId}`, "1", {
    ttlSeconds: 24 * 3600,
  });
  return !r.ok;  // returns TRUE if event was ALREADY seen (skip dispatch)
}
```

**Critical:** `getKVStore()` is NOT the tenant-scoped one. Webhook ingestion has no `tenant_id` until the handler reads `payload.account_id` and resolves it. The dedup key must be globally unique. This is why CONTEXT-EXISTING-CODE flags a kv-allowlist entry for `unipile:webhook:event:*`.

### Pattern 3: Fire-and-forget async dispatch (D-55)
**What:** Reply 200 to Unipile under 30s, then run handler async on the SAME lambda invocation. Vercel keeps the lambda alive for ~30s after response by default.
**Example:**
```typescript
// inside the route handler, after dedup check
const payload = parsed as UnipileWebhookPayload;
void dispatchEventAsync(payload).catch((err) =>
  log.error("[CONNECTOR:unipile] webhook dispatch failed", { error: toMsg(err), event: payload.event })
);
return new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
```
**Anti-pattern:** `await dispatchEventAsync(payload)` would block the response until handlers complete — risking 30s timeout on slow CRM POSTs.
**Pattern source:** the existing webhook receiver (`src/connectors/webhook/route.ts:131-136`) returns immediately after KV write; we use the same idiom for the async handler chain.

### Pattern 4: Twenty CRM HMAC signature (Twenty-native scheme)
**What:** Twenty's official webhook spec [CITED: docs.twenty.com/developers/api-and-webhooks/webhooks] uses `X-Twenty-Webhook-Signature` (HMAC-SHA256 hex digest) over `{timestamp}:{jsonBody}` with secret as the key, plus `X-Twenty-Webhook-Timestamp` (ISO).
**When to use:** Inside `TwentyAdapter.notifyEvent()` AND inside the cron retry adapter, when building the outbound POST.
**Example:**
```typescript
// src/connectors/unipile/lib/crm-bridge.ts (replaces TwentyAdapterSkeleton)
// Source: docs.twenty.com/developers/api-and-webhooks/webhooks (Twenty webhook spec) [CITED]
//         + D-64 + per-tenant URL/secret env-var naming convention (D-03)
import { createHmac } from "node:crypto";
import { getConfig } from "@/core/config-facade";
import { getContextKVStore } from "@/core/request-context";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

export class TwentyAdapter implements CrmAdapter {
  async writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void> {
    // Same as skeleton — kept for backward compat
    const row: CrmOutboxRow = {
      audit_id: auditId, status: "pending",
      crm_log: payload.crm_log, queued_at: new Date().toISOString(),
    };
    const kv = getContextKVStore();
    await kv.set(`unipile:outbox:${auditId}`, JSON.stringify(row));
  }

  async notifyEvent(args: {
    event_type: string;
    payload: Record<string, unknown>;
    tenant_id: string;
  }): Promise<{ ok: boolean; status?: number; error?: string }> {
    const tenantUpper = args.tenant_id.toUpperCase().replace(/-/g, "_");
    const url = getConfig(`UNIPILE_CRM_WEBHOOK_URL_${tenantUpper}`);
    const secret = getConfig(`UNIPILE_CRM_WEBHOOK_SECRET_${tenantUpper}`);
    if (!url || !secret) {
      return { ok: false, error: "missing_tenant_webhook_config" };
    }
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      event_type: args.event_type,
      timestamp,
      tenant_id: args.tenant_id,
      payload: args.payload,
    });
    // Twenty signing convention: HMAC-SHA256(secret).update(`${timestamp}:${body}`)
    const signature = createHmac("sha256", secret).update(`${timestamp}:${body}`).digest("hex");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twenty-Webhook-Signature": signature,
          "X-Twenty-Webhook-Timestamp": timestamp,
          // Bonus: also send the Kebab-flavoured header alias for non-Twenty
          // consumers that just want HMAC verification of body+timestamp.
          "X-Kebab-Signature": signature,
          "X-Kebab-Timestamp": timestamp,
        },
        body,
      });
      if (r.ok) return { ok: true, status: r.status };
      return { ok: false, status: r.status, error: `http_${r.status}` };
    } catch (err) {
      log.warn("Twenty CRM notify failed", { error: toMsg(err) });
      return { ok: false, error: toMsg(err) };
    }
  }
}
```

### Pattern 5: Vercel cron retry route (D-66, analog phase 63)
**Example:**
```typescript
// app/api/cron/unipile-crm-retry/route.ts
// Source: pattern from app/api/cron/update-check/route.ts:99-107
//         + outbox state machine D-65
import {
  composeRequestPipeline, rehydrateStep, authStep, rateLimitStep,
  hydrateCredentialsStep, type PipelineContext,
} from "@/core/pipeline";
import { getKVStore } from "@/core/kv-store";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("cron.unipile-crm-retry");

async function cronUnipileCrmRetryHandler(_ctx: PipelineContext): Promise<Response> {
  // Scan outbox keys (root-scope KV with tenant prefix, scan all tenants)
  const kv = getKVStore();
  const keys = await kv.list("unipile:outbox:");  // ⚠ scans across tenants
  let processed = 0, sent = 0, failed = 0, dead = 0;
  for (const key of keys) {
    const raw = await kv.get(key);
    if (!raw) continue;
    let row: CrmOutboxRow;
    try { row = JSON.parse(raw); } catch { continue; }
    if (row.status === "sent" || row.status === "dead") continue;
    if (row.next_retry_at && new Date(row.next_retry_at) > new Date()) continue;
    processed++;
    // ... call TwentyAdapter.notifyEvent, update row per D-65 state machine
  }
  return Response.json({ ok: true, processed, sent, failed, dead });
}

export const GET = composeRequestPipeline(
  [
    rehydrateStep,
    authStep("cron"),
    rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 }),
    hydrateCredentialsStep,
  ],
  cronUnipileCrmRetryHandler,
);
```

**vercel.json delta (append to existing crons array):**
```json
{ "path": "/api/cron/unipile-crm-retry", "schedule": "*/2 * * * *" }
```

### Pattern 6: WhatsApp handler skeleton (mirrors LinkedIn phase 69)
**Example structure:**
```typescript
// src/connectors/unipile/tools/whatsapp-send-message.ts
async function handleWhatsappSendMessage(args) {
  // 1. NEW (D-75): halt-flag pre-flight — HIGHEST priority
  const halt = await readHaltFlag(args.account_id);
  if (halt) return makeEnvelope({ error: "error_account_halted", reason: halt.reason, halted_at: halt.halted_at });

  // 2. Dedup (D-49 inherited from phase 69 — dedup-first)
  const paramsHash = computeParamsHash({
    tool: "whatsapp_send_message",
    profile_url_normalized: args.to,  // E.164 or chat_id, normalized
    note: args.text,
  });
  const dup = await checkDedup(paramsHash);
  if (dup) return makeEnvelope({ dedup_hit: true, ... });

  // 3. Resolve account_id (D-20 analog for WhatsApp — filter type==="WHATSAPP")
  const accResolved = await resolveAccountId({ account_id: args.account_id, type: "WHATSAPP" });
  if ("error" in accResolved) return makeEnvelope({ error: accResolved.error, ... });

  // 4. Rate-limit (D-68)
  const decision = await checkUnipileRateLimit({ account_id: accResolved.accountId, tool: "whatsapp_send" });
  if (decision.blocked) {
    await writeAuditRow({ ..., result: "error_rate_limit_kebab" });
    return makeEnvelope({ blocked_by_rate_limit: true, ... });
  }

  // 5. Resolve recipient — phone E.164 → "<phone>@s.whatsapp.net" → attendee, OR chat_id passthrough
  const attendeeId = await resolveWhatsappAttendee(args.to, accResolved.accountId);

  // 6. SDK call
  const resp = await withRetry(() =>
    getUnipileClient().messaging.startNewChat({
      account_id: accResolved.accountId,
      attendees_ids: [attendeeId],
      text: args.text,
      ...(buffers ? { attachments: buffers } : {}),
    })
  );

  // 7. Audit + envelope (no verify-after-write for WhatsApp V1 — startNewChat returns message_id immediately)
  await writeAuditRow({ ..., result: "success", verified: true });
  return makeEnvelope({ provider_ok: true, verified: true, message_id: resp.message_id, ... });
}
```

### Anti-Patterns to Avoid
- **HMAC downgrade attack via empty `X-Unipile-Signature`:** the verifier MUST NOT fall through from "HMAC header present but mismatch" to the static-secret path. Empirical evidence shows real Unipile won't send the HMAC header at all — fallthrough is only triggered by the header being ABSENT. A header that's present but wrong is a signal of tampering, reject hard. (See Pattern 1 code — the `if (sig)` branch returns `ok: false` without trying the fallback.)
- **`await dispatchEventAsync(...)` in the route:** turns 200ms response into 5-30s response → Unipile retries → duplicate handler runs even with dedup (race on the SET-NX).
- **Tenant-scoped KV for the webhook idempotency key:** there is no tenant context at webhook arrival time. `unipile:webhook:event:*` MUST live in root-scope KV. Add the prefix to `tests/contract/kv-allowlist.test.ts`.
- **Storing the message body in CRM webhook payload:** D-62 forbids it. Only `content_hash` (SHA-256 truncated) leaves Kebab. The CRM can fetch full body via `whatsapp_get_conversation` if it has reason to.
- **Writing audit rows for inbound webhooks beyond a single dedup-noted entry on halt:** the audit log is for OUTBOUND tool calls. Adding inbound rows pollutes the dedup hash space.
- **Skipping the `account_status` halt-flag clear on `OK` / `RECONNECTED`:** if the handler only writes the flag on error states (D-56) and never clears it, accounts stay halted forever. Handler MUST clear (`kv.delete(haltKey)`) on `OK | CREATION_SUCCESS | RECONNECTED | SYNC_SUCCESS`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HMAC signature verification | `bcrypt`, `crypto-verify`, custom hex compare | Node `crypto.createHmac` + `timingSafeEqual` over hashed buffers | Built-in, constant-time. Pattern proven in `src/connectors/webhook/route.ts:44-55`. |
| Webhook idempotency tracking | Custom mutex / lock library | Upstash KV `setIfNotExists` with TTL | Atomic, distributed-safe, single round-trip. Already plumbed via `app/api/cron/update-check/route.ts:65-72`. |
| WhatsApp message send | Direct HTTPS POST to WhatsApp Cloud API + token mgmt | `client.messaging.startNewChat` with `attendees_ids: ['<phone>@s.whatsapp.net']` | Unipile handles WhatsApp Web link, sync, attendee resolution. That's literally the value prop. |
| Cron retry scheduling | External queue / BullMQ | Vercel cron + `next_retry_at` ISO check in KV row | Vercel cron is free, no infra. Backoff lookup is one timestamp compare per row. |
| Twenty CRM webhook signing | Custom convention | Twenty's `X-Twenty-Webhook-Signature` HMAC over `timestamp:body` | Twenty's spec is authoritative — match it so a vanilla Twenty install verifies our POSTs out of the box. |
| Background async dispatch from webhook handler | `setImmediate` / `process.nextTick` / external queue | `void asyncFn().catch(log.error)` | Vercel keeps lambda alive ~30s post-response by default — plenty for a CRM POST or two. |
| Halt-flag pre-flight check infra | New module / table | One KV read in each write tool handler (`tenant:<id>:unipile:halt:<acc>`) | Per D-75 the check is highest-priority — must be inline, can't be middleware (tool args define the account). |

**Key insight:** Almost everything in phase 70 reuses an existing Kebab primitive (KV, pipeline, config-facade, logger). The only NEW primitives are (a) the dual-mode signature verifier (~30 LOC), (b) the WhatsApp attendee resolver (~20 LOC), (c) the halt-flag read/write helpers (~30 LOC), and (d) the Twenty HMAC-signed POST in TwentyAdapter (~40 LOC). The phase is high-leverage because the surface area is small but unlocks the bidirectional ADR-0001 vision.

## Runtime State Inventory

This phase is **NOT a rename/refactor/migration** — it's net-new code (webhooks, WhatsApp tools, real CRM adapter). The phase 68 `TwentyAdapterSkeleton` is being REPLACED with a real `TwentyAdapter`, but D-67 mandates the skeleton export stays as a deprecated alias (back-compat). No KV migrations, no env-var renames, no breaking changes.

**Explicitly answered for each category (per researcher discipline):**

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **None.** Phase 70 ADDS new KV key prefixes (`unipile:webhook:event:*`, `unipile:halt:*`) — no existing data to migrate. Existing `unipile:outbox:*` rows from phase 68 (status='pending') will be picked up by the new cron and processed normally — that's an UPGRADE not a migration. | None — cron handles pre-existing pending rows naturally on first run |
| Live service config | **3 NEW Unipile webhooks** must be created out-of-band per tenant (one each for `source: messaging`, `source: account_status`, `source: users`). NOT in git; lives in the Unipile dashboard or set via API on operator action. | Add an admin REST endpoint OR an operator-run script `scripts/unipile-bootstrap-webhooks.ts` that creates all 3 subscriptions pointing at the deployed `/api/unipile/webhook` URL with the configured `UNIPILE_WEBHOOK_SECRET` baked into the custom `Unipile-Auth` header. Phase 70 plan should include this as a Wave-final task. |
| OS-registered state | **None.** No Vercel Task Scheduler equivalent — Vercel cron is declared in `vercel.json` (in git). | None |
| Secrets/env vars | **NEW env vars added:** `UNIPILE_WEBHOOK_SECRET` (single global per D-53), `UNIPILE_CRM_WEBHOOK_URL_<TENANT_ID>`, `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (per-tenant), `KEBAB_UNIPILE_NOTIFY_WEBHOOK_URL` (optional), `KEBAB_UNIPILE_INBOUND_NOTIFY` (optional), `KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP` (optional, default 200). All flow through `credential-store.ts` hydration list. | Add all 6 to `src/core/credential-store.ts` hydration list + update Settings UI tile if it enumerates Unipile env vars |
| Build artifacts | **None.** No new installed packages. SDK already vendored. | None |

## Common Pitfalls

### Pitfall 1: Webhook idempotency key collision across tenants
**What goes wrong:** If we tenant-prefix the idempotency key (via `getContextKVStore()`), tenant A processes event X and tenant B re-processes the same event X because they have different KV namespaces.
**Why it happens:** Unipile emits one webhook per `account_id` (not per tenant). At ingress the route doesn't know which tenant owns the account_id until it inspects the payload — and even then, tenant routing for the dedup key is wrong because the same event must be dedup'd globally.
**How to avoid:** Use root-scope `getKVStore()` for `unipile:webhook:event:*`. Add this prefix to `tests/contract/kv-allowlist.test.ts` (existing rule says connectors must use context-scoped; the webhook route is the SECOND exception alongside admin DELETE routes).
**Warning signs:** Same `message_id` getting handler-dispatched twice in logs.

### Pitfall 2: Unipile's `new_relation` is NOT real-time
**What goes wrong:** The `new_relation` webhook (LinkedIn invitation accepted) fires **up to 8 hours after** the recipient accepts [CITED: developer.unipile.com/docs/detecting-accepted-invitations]. If the handler expects to find a matching audit row by `recipient_provider_id` synchronously after the send, it can find none — the send happened, the accept happened, but the webhook arrives much later when the audit row's `params_hash` was matched against a different note.
**Why it happens:** LinkedIn doesn't expose an "invitation accepted" push API. Unipile polls.
**How to avoid:** D-59 already says "best-effort, may not find" — emphasize this in handler tests. The fallback (D-60: POST CRM webhook with `audit_id: null, source: 'external_invitation'`) is the right semantics.
**Warning signs:** CRM frequently receives `audit_id: null` even for connections sent through Kebab.

### Pitfall 3: SDK `WebhookCreateBodySchema` rejects `source: "users"`
**What goes wrong:** Attempting `client.webhook.create({source: "users", ...})` throws TypeBox validation error because `WebhookCreateBodySchema` is a `TUnion` of only 4 literal sources [VERIFIED: `node_modules/unipile-node-sdk/dist/types/webhooks/webhooks-create.types.d.ts` line 95-154]. SDK is stale relative to the API surface (consistent with phase 68 Pitfall 5).
**Why it happens:** SDK v1.9.3 published 2025-05; `users` source webhooks (for `new_relation`) post-date that release.
**How to avoid:** Use the SDK escape hatch for that ONE webhook creation:
```typescript
await client.request.send({
  path: ['webhooks'],
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: {
    source: 'users',
    request_url: 'https://<deploy>/api/unipile/webhook',
    name: 'kebab-new-relation',
    headers: [{ key: 'Unipile-Auth', value: '<UNIPILE_WEBHOOK_SECRET>' }],
  },
});
```
The other 2 webhooks (`messaging`, `account_status`) can use the typed `client.webhook.create()` method.
**Warning signs:** Operator-onboarding script fails for the `users` webhook subscription with a TypeBox compile error.

### Pitfall 4: `message_received` fires for OUTBOUND messages too
**What goes wrong:** [LIVE-VERIFIED 2026-05-18] When I sent a WhatsApp message TO MYSELF and Unipile delivered the webhook, the payload included `"is_sender": true`. The `message_received` event fires for BOTH incoming AND outgoing messages on a chat. If the handler unconditionally POSTs to the CRM as `'message_received'`, the CRM will get notifications for messages OUR account sent.
**Why it happens:** Unipile's `message_received` event is really `message_observed_on_chat` — the docs are misleading.
**How to avoid:** Filter at the dispatcher: `if (payload.is_sender === true) skip` (or route to `message.sent` semantics if the CRM cares). Locked recommendation: skip — phase 70 only cares about replies from prospects (inbound), not echoes of our own sends.
**Warning signs:** CRM receives a "message received from prospect X" notification immediately after a send — that's the echo.

### Pitfall 5: `axios/1.7.7` User-Agent is the ONLY identification of Unipile in the payload
**What goes wrong:** [LIVE-VERIFIED 2026-05-18] there is no `X-Webhook-Source: Unipile` or similar branding header. Any attacker who learns the static secret can spoof a Unipile webhook from any user-agent.
**Why it happens:** Unipile uses generic axios as their HTTP client without setting a custom UA or origin marker.
**How to avoid:** The static-secret check is the ONLY auth. Treat `UNIPILE_WEBHOOK_SECRET` as production-critical (don't log it, hydrate via `credential-store.ts`). Consider rotating quarterly. There's no second factor available.
**Warning signs:** UA-based filtering won't work — don't add it. Logs should record the User-Agent for forensics but not gate on it.

### Pitfall 6: `format: "json"` configures the body shape; Content-Type is misleading
**What goes wrong:** [LIVE-VERIFIED 2026-05-18] Unipile sends `Content-Type: application/x-www-form-urlencoded` EVEN WHEN the webhook is configured with `format: "json"`, but the body IS valid JSON. Naive content-type sniffing would parse with `URLSearchParams` and fail.
**Why it happens:** Likely a bug in Unipile's axios client. Empirically confirmed in two separate test webhook sends.
**How to avoid:** Always parse as JSON regardless of Content-Type. The `bodyParseStep({maxBytes: 1MB})` from the existing pipeline does JSON-first with raw-string fallback — that's the right behavior.
**Warning signs:** Webhook handler returns 400 / parse error on real Unipile traffic but works on `webhook.site` replays through other tools.

### Pitfall 7: `message_id` (not `event_id`) is the only idempotency key for messaging events
**What goes wrong:** Searching for an `event_id` field returns nothing [LIVE-VERIFIED]. The payload has `message_id` (per-message unique). For `account_status` events there's no message_id at all — need a different idempotency key.
**Why it happens:** Unipile webhooks don't have a unified event identifier across event types.
**How to avoid:** Derive an idempotency key per event type:
- `message_received` → `message_id`
- `new_relation` → `${account_id}:${user_provider_id}` (one acceptance per relationship per account)
- `account_status` → `${account_id}:${status}:${timestamp}` (status changes have a timestamp)

**Warning signs:** Duplicate audit-side effects after handler retries (Unipile retries up to 5x on non-200 per docs).

### Pitfall 8: WhatsApp attendee resolution requires a chat-init round-trip
**What goes wrong:** Unipile's `messaging.startNewChat({attendees_ids: ['<phone>@s.whatsapp.net']})` accepts the WhatsApp public-identifier format `<E164>@s.whatsapp.net` directly [LIVE-VERIFIED 2026-05-18]. You do NOT need a pre-step "resolve attendee_id" round-trip for WhatsApp. **But** the returned attendees come back with `phone_number: "hidden"` from `getAllAttendees`, so reverse-lookup (attendee_id → phone) is impossible — privacy enforcement on Unipile's side.
**Why it happens:** WhatsApp doesn't expose phone numbers in their public API; Unipile honors that.
**How to avoid:** For send, accept E.164 from the LLM and append `@s.whatsapp.net` server-side. For list_contacts, return `phone_e164: null` for hidden contacts and surface `name` (which may also be empty for unknown contacts).
**Warning signs:** Operators ask "why doesn't whatsapp_list_contacts return phone numbers?" — answer: privacy gate at Unipile, not us.

## Code Examples

### A — webhook route entrypoint
```typescript
// app/api/unipile/webhook/route.ts
// Source: pipeline pattern from src/connectors/webhook/route.ts:139-146
import {
  composeRequestPipeline, rehydrateStep, bodyParseStep, type PipelineContext,
} from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";
import { getKVStore } from "@/core/kv-store";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { verifyUnipileWebhook } from "@/connectors/unipile/webhook/verifier";
import { dispatchEventAsync, getIdempotencyKey } from "@/connectors/unipile/webhook/dispatcher";

const MAX_BODY = 256 * 1024; // 256KB — Unipile messaging payloads ~1-2KB; account_status ~500B
const log = getLogger("CONNECTOR:unipile-webhook");

async function unipileWebhookHandler(ctx: PipelineContext): Promise<Response> {
  const secret = getConfig("UNIPILE_WEBHOOK_SECRET");
  if (!secret) {
    log.error("UNIPILE_WEBHOOK_SECRET not set — rejecting webhook");
    return new Response(JSON.stringify({ error: "webhook_not_configured" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
  const rawBody = typeof ctx.parsedBody === "string" ? ctx.parsedBody : JSON.stringify(ctx.parsedBody ?? "");
  const result = verifyUnipileWebhook(rawBody, ctx.request.headers, secret);
  log.info("webhook signature verification", { mode: result.mode, ok: result.ok, reason: result.reason });
  if (!result.ok) {
    return new Response(JSON.stringify({ error: "invalid_signature", reason: result.reason }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  let payload: Record<string, unknown>;
  try { payload = typeof ctx.parsedBody === "object" && ctx.parsedBody !== null ? ctx.parsedBody as Record<string, unknown> : JSON.parse(rawBody); }
  catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 }); }

  const idemKey = getIdempotencyKey(payload);
  if (!idemKey) return new Response(JSON.stringify({ error: "missing_idempotency_field" }), { status: 400 });
  const kv = getKVStore(); // ROOT scope per Pitfall 1
  const setRes = await kv.setIfNotExists?.(`unipile:webhook:event:${idemKey}`, "1", { ttlSeconds: 86400 });
  if (setRes && !setRes.ok) {
    log.info("duplicate webhook event — acknowledging without dispatch", { idemKey });
    return new Response(JSON.stringify({ ok: true, deduped: true }), { status: 200 });
  }
  void dispatchEventAsync(payload).catch((err) =>
    log.error("webhook dispatch failed", { error: toMsg(err), event: payload.event })
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

export const POST = composeRequestPipeline(
  [rehydrateStep, bodyParseStep({ maxBytes: MAX_BODY })],
  unipileWebhookHandler,
);
```

### B — dispatcher routing by event type
```typescript
// src/connectors/unipile/webhook/dispatcher.ts
export function getIdempotencyKey(p: Record<string, unknown>): string | null {
  const event = String(p.event ?? "");
  if (event === "message_received" && typeof p.message_id === "string") return p.message_id;
  if (event === "new_relation" && typeof p.account_id === "string" && typeof p.user_provider_id === "string")
    return `${p.account_id}:${p.user_provider_id}`;
  // account_status webhook payload includes account_id + account_status; derive composite
  if (typeof p.account_id === "string" && typeof p.account_status === "string")
    return `${p.account_id}:${p.account_status}:${p.timestamp ?? Date.now()}`;
  return null;
}

export async function dispatchEventAsync(payload: Record<string, unknown>): Promise<void> {
  const event = String(payload.event ?? "");
  // Pitfall 4 — skip echoed outbound messages
  if (event === "message_received" && payload.is_sender === true) {
    log.debug("skipping outbound echo", { message_id: payload.message_id });
    return;
  }
  switch (event) {
    case "message_received": return handleMessageReceived(payload);
    case "new_relation":     return handleNewRelation(payload);
    default:
      // account_status path: payload has no top-level `event` field per the
      // subscription schema — it has `account_status` field instead. Detect that.
      if (typeof payload.account_status === "string") return handleAccountStatus(payload);
      log.warn("unknown event type", { event });
  }
}
```

### C — WhatsApp send (UNI-16)
```typescript
// src/connectors/unipile/tools/whatsapp-send-message.ts
export const whatsappSendMessageSchema = {
  to: z.string().describe("E.164 phone (e.g. +33660036335) OR existing chat_id"),
  text: z.string().min(1).max(4096),
  account_id: z.string().optional(),
  actor_user_id: z.string(),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(255),
    mimetype: z.enum(["application/pdf","image/png","image/jpeg","image/gif"]),
    base64: z.string(),
  })).max(5).optional(),
  crm_log: z.record(z.string(), z.unknown()).optional(),
};

export async function handleWhatsappSendMessage(args: WhatsappSendMessageArgs): Promise<ToolResult> {
  // ...halt-check, dedup, account resolve, rate-limit (skeleton above)
  const recipientId = args.to.startsWith("+")
    ? `${args.to.replace(/^\+/, "")}@s.whatsapp.net`
    : args.to; // assume chat_id passthrough
  // ...send via messaging.startNewChat OR messaging.sendMessage if chat_id known
}
```

### D — halt-flag helpers
```typescript
// src/connectors/unipile/webhook/halt-flag.ts
import { getContextKVStore } from "@/core/request-context";

export interface HaltFlag { reason: string; halted_at: string; status: string }

const HALT_STATUSES = new Set([
  "credentials_expired", "CREDENTIALS",
  "restricted", "ERROR",
  "disconnected", "DELETED",
]);
const RECOVERY_STATUSES = new Set([
  "OK", "CREATION_SUCCESS", "RECONNECTED", "SYNC_SUCCESS",
]);

export async function readHaltFlag(accountId: string): Promise<HaltFlag | null> {
  const raw = await getContextKVStore().get(`unipile:halt:${accountId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as HaltFlag; } catch { return null; }
}

export async function writeHaltFlag(accountId: string, flag: HaltFlag): Promise<void> {
  await getContextKVStore().set(`unipile:halt:${accountId}`, JSON.stringify(flag));
}

export async function clearHaltFlag(accountId: string): Promise<void> {
  await getContextKVStore().delete(`unipile:halt:${accountId}`);
}

export function isHaltStatus(s: string): boolean { return HALT_STATUSES.has(s); }
export function isRecoveryStatus(s: string): boolean { return RECOVERY_STATUSES.has(s); }
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 68 `TwentyAdapterSkeleton` writes `pending` and stops | Phase 70 `TwentyAdapter` writes `pending` + cron flushes via HMAC-signed POST | This phase (D-64..D-66) | CRM finally sees events; outbox becomes a real retry queue. |
| Phase 68/69 write tools start with dedup | Phase 70 adds halt-flag pre-flight as HIGHEST priority (D-75) | This phase | Restricted accounts can't burn quota chasing actions that will fail at LinkedIn anyway. |
| Manual webhook setup (operator clicks in Unipile dashboard) | Either operator-run script OR (recommended) admin REST endpoint that bootstraps all 3 webhooks via API | This phase (Specifics §) | Reproducible setup; tenant onboarding doesn't require dashboard access. |
| Polling every N seconds for InMail credits | Push-based via account_status when account loses Premium | This phase (D-56 indirectly — account state changes surface fast) | Less Unipile quota burn on read calls. |

**Deprecated/outdated (carry-over from phase 69):**
- LinkedIn write tools that don't check halt flag — phase 70 retrofits all 3 (D-75).
- Phase 68's `TwentyAdapterSkeleton` becomes a deprecated alias for `TwentyAdapter` (D-67).

## Project Constraints (from CLAUDE.md)

`./CLAUDE.md` is the gitignored personal scratchpad (per its own contents). The canonical contributor doc is `docs/ARCHITECTURE.md`. Phase 70-applicable constraints (carry-over from phase 68/69, no new ones in this phase):

- **No `process.env` direct reads** — `getConfig()` only. Enforced by ESLint rule `kebab/no-direct-process-env`. New env vars (`UNIPILE_WEBHOOK_SECRET`, etc.) flow through this.
- **`getContextKVStore()` vs `getKVStore()`:** webhook idempotency keys are ROOT-scope (Pitfall 1) — use `getKVStore()`. Halt flags / outbox / audit rows are tenant-scoped — use `getContextKVStore()`. The kv-allowlist contract test (`tests/contract/kv-allowlist.test.ts`) needs ONE new entry: `unipile:webhook:event:*` allowed for root scope in the unipile-webhook-route file.
- **No new `MYMCP_*` env var names** — all new vars use `KEBAB_*` (or `UNIPILE_*` since those carry over the v0.10 nomenclature).
- **Connector logger tag:** `[CONNECTOR:unipile]` for tools, `[CONNECTOR:unipile-webhook]` for the route handler (separate sub-tag so logs filter cleanly).
- **Tests use `vi.mock()`**, no real KV/SDK calls in CI.
- **Git push auto:** memory feedback — always `git push` after commit, no confirm.
- **Defensive defaults:** D-52 dual-mode HMAC, D-40 fail-closed rate-limit — both consistent with "generous defaults in TIME, fail-closed in SECURITY" pattern.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js ≥18 | Vercel runtime | ✓ | 20.x | — |
| `unipile-node-sdk` 1.9.3 | already installed | ✓ | 1.9.3 [VERIFIED] | escape hatch via `client.request.send` for `source: "users"` webhook |
| `UNIPILE_DSN`, `UNIPILE_TOKEN` | inherited from phase 68 | ✓ at deploy time | — | connector goes Inactive |
| `UNIPILE_WEBHOOK_SECRET` (NEW) | webhook route signature check | ✗ (operator must set) | — | route returns 503 if missing — explicit |
| `UNIPILE_CRM_WEBHOOK_URL_<TENANT>` (NEW per-tenant) | TwentyAdapter.notifyEvent | ✗ (per-tenant) | — | adapter returns `{ok:false, error:'missing_tenant_webhook_config'}` — row goes to `failed` until configured |
| `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT>` (NEW per-tenant) | TwentyAdapter HMAC signing | ✗ (per-tenant) | — | same as above |
| `CRON_SECRET` (existing) | cron route auth | ✓ in prod | — | `authStep("cron")` rejects unauthenticated callers |
| Upstash KV | webhook dedup + halt flags + outbox + cron scan | ✓ in prod (`UPSTASH_REDIS_REST_URL`+`_TOKEN`) | — | FilesystemKV in dev — `setIfNotExists` honored, but `kv.list("prefix:")` may be slower |
| Vercel cron infra | `/api/cron/unipile-crm-retry` schedule | ✓ at deploy time | — | none — phase 70 hard-depends on Vercel cron (matches phase 63 pattern) |
| Live Unipile tenant for empirical testing | Wave 0 / Wave-final | ✓ provided | DSN api41.unipile.com:17153 | — |
| WhatsApp account on the tenant | end-to-end WhatsApp tool test | ✓ (id `2qQuXs25TsimaAE62T2xSw`, phone `+33660036335`) | — | — |
| LinkedIn account on the tenant | new_relation handler smoke test | ✓ (id `eYRQtT4kTxq0Ns1XjP38MQ`) | — | — |

**Missing dependencies with no fallback:** `UNIPILE_WEBHOOK_SECRET` MUST be provisioned at deploy time — webhook route returns 503 (loud, deliberate) if absent.

**Missing dependencies with fallback:** Per-tenant CRM URL/secret missing → outbox row goes to `failed` and cron retries — non-fatal, surfaces in dashboard.

## Security Domain

The project config does not set `security_enforcement` — treating as default (enabled). LinkedIn + WhatsApp writes + inbound webhooks carry serious compliance + tampering risk.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (cron + webhook) | `CRON_SECRET` via `authStep("cron")` for cron; static-shared-secret on `Unipile-Auth` header for inbound webhook (D-52) |
| V3 Session Management | n/a (stateless lambda) | — |
| V4 Access Control | yes | Halt flag pre-flight (D-75) is technically an access-control gate at the tool-handler level; per-tenant secret isolation (D-03) for outbound CRM POSTs |
| V5 Input Validation | yes | `zod` on tool schemas + bodyParseStep maxBytes limit on webhook route; HMAC verification rejects tampered bodies |
| V6 Cryptography | yes | Node `crypto.createHmac` + `timingSafeEqual` — built-in, NEVER hand-roll; sha256 for hashing both sides before timing-safe compare (existing webhook receiver pattern) |
| V7 Error Handling | yes | Webhook route returns generic error reasons (`invalid_signature`, `invalid_json`) — no internal detail leakage; full detail goes to logs not response |
| V11 Business Logic | yes | Idempotency (D-54) protects against replay; halt-flag (D-75) protects against quota burn on broken accounts |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged webhook from attacker who knows the URL | Spoofing | Static-secret check via `timingSafeEqual` (D-52); rotate `UNIPILE_WEBHOOK_SECRET` quarterly |
| Replay attack — captured webhook POST replayed by attacker | Replay (Tampering) | Idempotency key dedup (D-54, 24h TTL) — first replay is processed, all subsequent replays return 200 deduped without dispatch |
| HMAC downgrade attack — attacker strips `X-Unipile-Signature` header to force static-secret path | Spoofing / Tampering | Verifier rejects HARD on present-but-mismatched HMAC (Anti-Pattern 1 in Pattern 1 example); only falls through on header ABSENCE |
| Per-tenant secret leak from one tenant compromising another's CRM | Information Disclosure | Per-tenant `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT>` (D-03); one compromise = one tenant blast radius |
| Outbox row tampering via KV admin access | Tampering | Outbox rows include `audit_id` which is UUIDv4 — collision-resistant; row contents are JSON; admin KV access already requires admin auth (existing) |
| Message body leak via CRM webhook payload | Information Disclosure / GDPR | D-62 explicitly forbids posting message body; only content_hash leaves Kebab |
| User-Agent based spoofing | Spoofing | UA is `axios/1.7.7` — generic, can't gate on it (Pitfall 5); secret is the only auth |
| Tenant-A's webhook handler write leaking to tenant-B's KV | Information Disclosure | Handler routes via `account_id` payload field → tenant lookup → `getContextKVStore()` per-tenant scoping; tested by contract test |

## Sources

### Primary (HIGH confidence — empirical / live-verified)

- **LIVE WEBHOOK PAYLOAD CAPTURE** [2026-05-18, against `api41.unipile.com:17153`]:
  - Created 2 webhooks via `POST /api/v1/webhooks` (messaging + account_status) with custom `X-Kebab-Test-Auth` header
  - Sent WhatsApp self-message via `POST /api/v1/chats` (PowerShell `Invoke-RestMethod` — Windows curl SChannel bug blocked direct curl)
  - Captured the real Unipile webhook delivery via webhook.site `446f7da7-88d8-4d0f-b8b2-95a849fc6f2a`
  - Confirmed: NO `X-Unipile-Signature` header, only static `x-kebab-test-auth`; User-Agent `axios/1.7.7`; Content-Type `application/x-www-form-urlencoded` with JSON body; `is_sender: true` for outbound echoes; `message_id` field present (unique); NO `event_id` field
  - Deleted test webhooks via `DELETE /api/v1/webhooks/<id>` (cleanup confirmed: list returns `items: []`)
- **Unipile SDK source** [VERIFIED `node_modules/unipile-node-sdk/dist/types/`]:
  - `resources/webhook.resource.d.ts` — only `getAll/create/delete` methods; NO `test` method
  - `webhooks/webhooks-create.types.d.ts` — `WebhookCreateBodySchema` is `TUnion<[messaging, account_status, email, email_tracking]>` — does NOT include `users` literal source (SDK staleness vs API)
  - `webhooks/webhooks-list.types.d.ts` — full webhook record shape with `account_ids[].type` union including `WHATSAPP`, `LINKEDIN`, etc.
  - `resources/messaging.resource.d.ts` — full method list (sendMessage, startNewChat, getAllChats, getAllMessagesFromChat, getAllAttendees, getAttendee, etc.)
  - `messaging/chats/chats-list.types.d.ts` — Chat schema with `account_type` literal union including `WHATSAPP`, `timestamp`, `attendee_provider_id`
  - `messaging/chat-attendees/chat-attendees-list.types.d.ts` — ChatAttendee schema with `specifics.phone_number` (string, but actual API returns `"hidden"` for WhatsApp privacy)
  - `types/input/input-messaging.d.ts` — `PostNewChatInput`, `PostMessageInput` with `attachments: Array<[string, Buffer]>`
- **LIVE API SHAPE VERIFICATION** [2026-05-18]:
  - `GET /api/v1/accounts` — confirmed 1 WhatsApp (`2qQuXs25TsimaAE62T2xSw`, OK status) + 1 LinkedIn (`eYRQtT4kTxq0Ns1XjP38MQ`, Sales Nav, OK status)
  - `GET /api/v1/chats?account_id=…&limit=3` — confirmed Chat shape with `attendee_public_identifier: "<phone>@s.whatsapp.net"`
  - `GET /api/v1/chat_attendees?account_id=…&limit=3` — confirmed `phone_number: "hidden"` for WhatsApp privacy
  - `GET /api/v1/chats/<chat_id>/messages?limit=2` — confirmed Message shape with `is_sender: 0|1`, `timestamp: ISO`, `original` field with raw WhatsApp protocol data
- **Existing codebase patterns** [VERIFIED — direct file reads]:
  - `src/connectors/webhook/route.ts:44-55` — `verifySignature` HMAC + `timingSafeEqual` over hashed buffers (model for our verifier)
  - `src/connectors/webhook/route.ts:139-146` — `composeRequestPipeline` with `rehydrateStep + bodyParseStep` (model for our route)
  - `app/api/cron/update-check/route.ts:64-72` — `kv.setIfNotExists` for anti-stampede lock (model for our dedup key)
  - `app/api/cron/update-check/route.ts:99-107` — cron route with `authStep("cron") + rateLimitStep`
  - `src/connectors/unipile/lib/crm-bridge.ts` — current `TwentyAdapterSkeleton` to be replaced (preserves outbox row shape)
  - `src/connectors/unipile/lib/rate-limiter.ts` — to be extended with `whatsapp_send` tool union member
  - `src/connectors/unipile/lib/account.ts` — D-20 LinkedIn account resolver pattern (model for `resolveWhatsappAccount`)
  - `src/connectors/unipile/lib/audit.ts` — `AuditResult` enum to be extended (only `error_account_halted` is genuinely new — see §7)
  - `src/connectors/unipile/lib/errors.ts` — `UnipileErrorResult` union to extend; `classifyUnipileError` likely needs no changes for phase 70
  - `vercel.json` — cron schedule registration (model for adding `unipile-crm-retry`)

### Secondary (MEDIUM confidence — official docs)

- developer.unipile.com/docs/webhooks-2 — auth mechanism description (static `Unipile-Auth` header confirmed). NO HMAC mention on this page.
- developer.unipile.com/docs/detecting-accepted-invitations — confirms `source: "users"`, `event: "new_relation"`, payload field list, and the "up to 8 hours delay" warning.
- developer.unipile.com/docs/new-messages-webhook — message webhook payload schema (less complete than what we captured live — docs missed `is_sender`).
- docs.twenty.com/developers/api-and-webhooks/webhooks — `X-Twenty-Webhook-Signature` + `X-Twenty-Webhook-Timestamp` HMAC-SHA256 over `${timestamp}:${body}` convention.

### Tertiary (LOW confidence — flagged)

- unipile.com/developer-real-time/ — marketing page mentions "HMAC signature verification available" but contradicts the official docs (which only describe the static `Unipile-Auth`). Empirical evidence (live capture) sides with the official docs — HMAC is NOT actually sent. Defensive D-52 covers both regardless.
- Twenty CRM CVE-2026-26720 — irrelevant to our outbound POST direction; we are the SENDER, Twenty is the RECEIVER. Note for the future if we ever ingest webhooks FROM Twenty.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Twenty CRM webhook signing convention is HMAC-SHA256 over `${timestamp}:${body}` with `X-Twenty-Webhook-Signature` + `X-Twenty-Webhook-Timestamp` headers | §4 Pattern 4, §State of the Art | [CITED: docs.twenty.com] but I did not verify against a live Twenty instance. Risk: Twenty install rejects our POSTs as invalid signature. Mitigation: also send `X-Kebab-Signature` (our convention) so consumers can verify either way; first integration test against the actual Cadens Twenty will surface mismatch immediately. The dual header sending is cheap. |
| A2 | Vercel keeps lambda alive ~30s post-response for fire-and-forget background tasks | §Pattern 3 + D-55 | [ASSUMED — based on Vercel docs guidance, not measured]. Risk: handlers may get killed mid-CRM-POST, leaving outbox rows in inconsistent state. Mitigation: outbox state machine D-65 has `pending → sending → sent|failed` — if the lambda dies between `sending` and final state, the cron picks up `sending` rows older than 5 minutes and retries. Plan should include this safety net. |
| A3 | `bodyParseStep` returns the raw string when JSON parse fails AND surfaces both via `ctx.parsedBody` | §Code Example A | [VERIFIED in `src/connectors/webhook/route.ts:77-78`] — but the test for the Content-Type-x-www-form-urlencoded-but-body-is-JSON case isn't documented. Risk: bodyParseStep tries to URL-decode the JSON and corrupts it. Mitigation: integration test with a captured live Unipile payload (we have one) must verify the path. |
| A4 | `account_status` webhook payload structure is `{account_id, account_status, account_status_specifics, ...}` with NO top-level `event` field | §Code Example B + Pitfall 7 | [INFERRED from the webhook record `data: [{key:"account_status"}, {key:"account_status_specifics"}]` we captured + docs]. We did NOT live-trigger an `account_status` event (would require deauthing the LinkedIn account or similar). Risk: actual payload has a different field name, our dispatcher routing misses it. Mitigation: phase 70 plan should include an integration test that mocks the documented account_status shape; live verification can happen in execute-phase by toggling the account in Unipile dashboard. |
| A5 | `messaging.startNewChat` with `attendees_ids: ['<E164>@s.whatsapp.net']` works for WhatsApp without a pre-step attendee lookup | §4 + Pitfall 8 | [LIVE-VERIFIED 2026-05-18 — successfully sent a self-message using this exact format]. HIGH confidence. |
| A6 | The 3 webhook subscriptions can all point at the same `request_url` (`/api/unipile/webhook`) and the route demultiplexes by `event` field | §1 + Architecture Diagram | [HIGH confidence] — Unipile imposes no restriction on `request_url` uniqueness; the SDK's create endpoint allows duplicate URLs. Our dispatcher routes by event field. |
| A7 | Vercel cron `*/2 * * * *` is supported (every 2 minutes) on the deployment tier in use | §Pattern 5 + D-66 | [ASSUMED — Vercel Hobby tier limits cron to once-per-day; Pro+ supports per-minute]. Risk: deploy fails or cron doesn't fire. Mitigation: confirm Vercel plan during execute-phase; fallback to `*/5 * * * *` (every 5 min) or hourly is trivial — just change vercel.json. |
| A8 | KV `kv.list("unipile:outbox:")` returns ALL tenant-prefixed outbox keys (cron scans cross-tenant) | §Pattern 5 | [ASSUMED — `kv.list` with prefix matches all keys with that substring; tenant prefix `tenant:<id>:` is BEFORE `unipile:outbox:`]. Actually the prefix as stored is `tenant:<id>:unipile:outbox:*` so `kv.list("unipile:outbox:")` would miss them! Risk: cron finds zero rows. Mitigation: scan with `kv.list("tenant:")` and filter client-side OR maintain a separate tenant-index key. Plan should clarify; this is a real risk surfaced in research. |
| A9 | The 3 phase 70 webhook subscriptions can all share `UNIPILE_WEBHOOK_SECRET` via the same `Unipile-Auth` header value | §D-53 + §1 | [HIGH confidence — Unipile documented multi-subscription support; one secret per URL is the docs convention]. |

## 1. Webhook Subscription API (POST/GET/DELETE + test endpoint)

**Endpoints (verified live 2026-05-18 against `api41.unipile.com:17153`):**

| Method | Path | Purpose | Body |
|--------|------|---------|------|
| POST | `/api/v1/webhooks` | Create subscription | `{source, request_url, name?, format?, account_ids?, enabled?, headers?, events?, data?}` |
| GET | `/api/v1/webhooks` | List all subscriptions | — (query: `limit`, `cursor`) |
| DELETE | `/api/v1/webhooks/<id>` | Delete subscription | — |
| **POST `/api/v1/webhooks/<id>/test`** | **DOES NOT EXIST** | n/a — returned 404 in live probe | — |

**Conclusion on "test endpoint":** Unipile docs mention webhook testing, but the API does NOT expose a dedicated test endpoint. The only way to trigger a webhook is to actually fire a real event (send a message, etc.) — which is what we did in research. The CONTEXT-Specifics §1 step (2) assumption "Unipile has a `POST /api/v1/webhooks/<id>/test` endpoint per docs" is **WRONG** — empirically verified.

**Source field values (locked from SDK + escape hatch):**

| Source | SDK support | Used for |
|--------|------------|----------|
| `messaging` | typed via `client.webhook.create()` | `message_received` event (LinkedIn DMs + WhatsApp inbound) |
| `account_status` | typed via `client.webhook.create()` | `OK`, `CREDENTIALS`, `ERROR`, etc. account state transitions |
| `users` | **escape hatch via `client.request.send()`** — SDK schema doesn't validate it | `new_relation` event (LinkedIn invitation accepted) |

**Bootstrap script (recommended plan task):**
```typescript
// scripts/unipile-bootstrap-webhooks.ts
// Run once per tenant after deploy + UNIPILE_WEBHOOK_SECRET configured.
const baseUrl = `${getConfig('VERCEL_URL') ?? 'http://localhost:3000'}/api/unipile/webhook`;
const secret = getConfig('UNIPILE_WEBHOOK_SECRET');
const authHeader = { key: 'Unipile-Auth', value: secret! };
const client = getUnipileClient();

// 1. messaging (message_received)
await client.webhook.create({
  source: 'messaging',
  request_url: baseUrl, name: 'kebab-msg', format: 'json',
  events: ['message_received'],
  headers: [authHeader],
});
// 2. account_status
await client.webhook.create({
  source: 'account_status',
  request_url: baseUrl, name: 'kebab-status', format: 'json',
  headers: [authHeader],
});
// 3. users (new_relation) — escape hatch because SDK schema doesn't include 'users'
await client.request.send({
  path: ['webhooks'], method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: {
    source: 'users', request_url: baseUrl, name: 'kebab-relations', format: 'json',
    headers: [authHeader],
  },
});
```

## 2. Webhook Payload Schema (event types, headers, body)

### Headers Unipile actually sends [LIVE-VERIFIED 2026-05-18]

```
host: webhook.site
accept-encoding: gzip, compress, deflate, br
content-length: 1279
user-agent: axios/1.7.7
x-kebab-test-auth: my-static-secret-token-12345    ← custom header we configured
content-type: application/x-www-form-urlencoded    ← MISLEADING — body is actually JSON
accept: application/json, text/plain, */*
```

**There is NO `X-Unipile-Signature` header. There is NO `X-Webhook-Source` header.** The only Unipile-controlled identifying header is the `User-Agent` (which is generic `axios/1.7.7`). Auth = custom header set at webhook creation = the static secret pattern. Confirmed empirically.

### Body — `message_received` event [LIVE CAPTURE 2026-05-18]

```json
{
  "event": "message_received",
  "account_id": "2qQuXs25TsimaAE62T2xSw",
  "account_type": "WHATSAPP",
  "account_info": { "type": "WHATSAPP", "phone_number": "+33660036335" },
  "webhook_name": "kebab-research-msg",
  "chat_id": "bMYVqTemU_C8Cqovci-KPA",
  "attendees": [{
    "attendee_id": "KNW82cTTSwK7mqWchi3NPg",
    "attendee_provider_id": "140874994434143@lid",
    "attendee_name": "Yassine Hamou Tahra",
    "attendee_profile_url": null,
    "attendee_specifics": {
      "provider": "WHATSAPP",
      "phone_number": "+33660036335",
      "lid": "140874994434143@lid"
    },
    "attendee_public_identifier": "33660036335@s.whatsapp.net"
  }],
  "sender": { /* same shape as attendees[0] */ },
  "subject": null,
  "message": "phase 70 webhook research probe",   ← FULL BODY in payload!
  "message_id": "QUPm14_tVs2lDOiuXy7zEQ",          ← unique idempotency key
  "timestamp": "2026-05-18T19:44:12.000Z",
  "attachments": [],
  "is_sender": true,                                ← TRUE for echoes of our own sends — Pitfall 4
  "provider_chat_id": "140874994434143@lid",
  "provider_message_id": "3EB04E080C9EDA200019D4",
  "is_event": 0,
  "chat_pinned": 0,
  "quoted": null,
  "is_forwarded": null,
  "chat_content_type": null,
  "message_type": null,
  "is_group": false,
  "folder": ["INBOX"]
}
```

### Body — `account_status` event [from subscription `data` schema; live-trigger not feasible without disrupting tenant]

The webhook record shows `data: [{key:"account_status", name:"AccountStatus"}, {key:"account_status_specifics", name:"Product"}]`. Inferred payload structure:

```json
{
  "webhook_name": "kebab-status",
  "account_id": "<account_id>",
  "account_type": "WHATSAPP" | "LINKEDIN" | ...,
  "account_status": "OK" | "CREDENTIALS" | "ERROR" | "CONNECTING" | "CREATION_SUCCESS" | "RECONNECTED" | "SYNC_SUCCESS" | "DELETED",
  "account_status_specifics": "<provider-specific detail string>",
  "timestamp": "<ISO-8601>"
}
```

**No `event` field on account_status payloads** (the dispatcher must route by presence of `account_status` field — see Code Example B).

### Body — `new_relation` event [from docs + payload field list, not live-captured]

```json
{
  "event": "new_relation",
  "account_id": "<linkedin_account_id>",
  "account_type": "LINKEDIN",
  "webhook_name": "kebab-relations",
  "user_full_name": "<recipient name>",
  "user_provider_id": "<linkedin provider_id of the recipient>",
  "user_public_identifier": "<linkedin slug>",
  "user_profile_url": "https://www.linkedin.com/in/<slug>",
  "user_picture_url": "<url>"
}
```

**Important behavior:** up to **8 hours delay** between actual acceptance and webhook firing [CITED: developer.unipile.com/docs/detecting-accepted-invitations]. Plan handler tolerance accordingly.

### Event type mapping summary

| Subscription `source` | Webhook payload `event` field | Idempotency key | Handler |
|----------------------|------------------------------|-----------------|---------|
| `messaging` | `"message_received"` | `message_id` | `handleMessageReceived` |
| `account_status` | (none — route by `account_status` field) | `${account_id}:${account_status}:${timestamp}` | `handleAccountStatus` |
| `users` | `"new_relation"` | `${account_id}:${user_provider_id}` | `handleNewRelation` |

## 3. HMAC Verification — Empirical Findings

**Question (D-52, locked CONTEXT decision):** Use defensive dual-mode HMAC + static-secret fallback?

**Live evidence (2026-05-18 against `api41.unipile.com:17153` with real webhook delivery):**
- Created webhook with custom header `{key: "X-Kebab-Test-Auth", value: "my-static-secret-token-12345"}`
- Sent real WhatsApp message via `POST /api/v1/chats`
- Captured the webhook delivery: webhook.site received POST with `x-kebab-test-auth: my-static-secret-token-12345` and NO `X-Unipile-Signature` header

**Conclusion:**
- The HMAC branch in the verifier will **NEVER FIRE** on this Unipile tenant. The static-header branch is the path the API actually takes.
- D-52's defensive dual-mode design is still correct — keeps us safe if Unipile rolls out HMAC later, AND aligns with the unipile.com marketing page (which claims HMAC support). But the HMAC path is "insurance code" — we won't see it execute in production unless Unipile changes their behavior.
- Per D-52, the verifier MUST log which mode fired (`mode: "hmac" | "static"`). After 30 days of real traffic, the static branch will dominate and we can simplify in phase 71 if desired.

**Implementation requirements (matches D-52 verbatim):**
1. Read `X-Unipile-Signature` header. If present:
   - Compute `expected = createHmac('sha256', UNIPILE_WEBHOOK_SECRET).update(rawBody).digest('hex')`
   - Hash both `expected` and the header value to sha256-digest buffers (fixed length avoids `timingSafeEqual` length-throw)
   - `timingSafeEqual(expHash, headerHash)` — return `{ok: true, mode: 'hmac'}` on match
   - On mismatch → return `{ok: false, mode: 'hmac', reason: 'hmac_mismatch'}` — DO NOT fall through (downgrade-attack protection)
2. If `X-Unipile-Signature` absent, read `Unipile-Auth` header:
   - Hash both `UNIPILE_WEBHOOK_SECRET` and the header value
   - `timingSafeEqual` — return `{ok: true, mode: 'static'}` on match
   - Mismatch → `{ok: false, mode: 'static', reason: 'static_mismatch'}`
3. Neither header present → `{ok: false, mode: 'rejected', reason: 'no_signature_or_auth_header'}`

**Per-request log line:** `log.info("webhook signature verification", { mode, ok, reason })` — operator visibility, retroactively answers "did HMAC ever fire?" before phase 71 simplification.

**Important nuance:** Unipile sends the static secret as a custom-named header (we configure the NAME at webhook creation time via `headers: [{key, value}]`). The CONTEXT says we configure `Unipile-Auth` — to match that literal header name, the bootstrap script must set `headers: [{key: "Unipile-Auth", value: secret}]`. The verifier reads `headers.get("unipile-auth")` (case-insensitive in standard HTTP).

## 4. WhatsApp SDK Endpoints (send, list_chats, get_conversation, list_contacts)

All 4 tools use the same `MessagingResource` class as LinkedIn DMs, with `account_type: "WHATSAPP"` filter where applicable.

### 4.1 `whatsapp_send_message` (UNI-16)

**SDK call:** Same as LinkedIn — `client.messaging.startNewChat()` with `attendees_ids: ['<E164-phone>@s.whatsapp.net']`. No LinkedIn options. Returns `{object: "ChatStarted", chat_id, message_id}` [LIVE-VERIFIED].

**No verify-after-write polling needed** — WhatsApp delivery is synchronous and `startNewChat` returns immediately with `message_id` set on success. Set `verified: true` directly. (Contrast with LinkedIn where `message_id` can be `null` and verification needs polling.)

**Recipient resolution rules (D-69):**
- If `args.to` matches `^\+[0-9]{8,15}$` (E.164) → recipient = `${args.to.replace(/^\+/, "")}@s.whatsapp.net`
- Else if it looks like a Unipile chat_id (base64-ish, no `+` or `@`) → use `client.messaging.sendMessage({chat_id: args.to, text})` instead of startNewChat
- Phase 70 does NOT implement contact-name resolution (deferred to phase 71)

**Attachments:** Same as LinkedIn (D-70) — `{filename, mimetype, base64}` schema, decoded to `Buffer`, max 15MB. PostNewChatInput accepts `attachments: Array<[string, Buffer]>` [VERIFIED in `dist/types/types/input/input-messaging.d.ts:47, 71`].

### 4.2 `whatsapp_list_chats` (UNI-17)

**SDK call:** `client.messaging.getAllChats({account_type: "WHATSAPP", account_id?, limit, cursor?, unread?})` [VERIFIED method signature in `resources/messaging.resource.d.ts:14`].

**Default limit 20, max 100** (D-71). Sort by `timestamp DESC` (the API already returns chats in this order — confirmed by live response showing newest-first).

**Response shape per chat:** `{id, name, type (0=single|1=group|2=channel), provider_id, timestamp, attendee_provider_id, attendee_public_identifier, unread_count, archived, muted_until, ...}`. For WhatsApp single chats `name` may be `null` (use `attendee_public_identifier`).

**Tool response (per D-74):**
```typescript
{
  count: number,
  cursor: string | null,
  items: Array<{
    chat_id: string,
    type: "single" | "group" | "channel",
    name: string | null,
    last_message_at: string,            // = chat.timestamp
    attendee_phone_e164: string | null, // parsed from attendee_public_identifier
    unread_count: number,
  }>
}
```

### 4.3 `whatsapp_get_conversation` (UNI-18)

**SDK call:** `client.messaging.getAllMessagesFromChat({chat_id, limit, cursor?, before?, after?, sender_id?})` [VERIFIED].

**Default limit 50, max 200** (D-72).

**Response per message:** `{id, text, timestamp, is_sender (0|1), seen, edited, deleted, sender_id, sender_attendee_id, attachments[], chat_id, provider_id, ...}` [LIVE-VERIFIED].

**Tool response:**
```typescript
{
  count: number,
  cursor: string | null,
  items: Array<{
    message_id: string,
    text: string,
    timestamp: string,
    is_sender: boolean,
    sender_attendee_id: string,
    attachment_count: number,
  }>
}
```

### 4.4 `whatsapp_list_contacts` (UNI-19)

**SDK call:** `client.messaging.getAllAttendees({account_id, limit?, cursor?})` [VERIFIED method signature]. Returns `ChatAttendeeListApiResponse` with `items[].specifics.phone_number` for WhatsApp.

**Caveat (Pitfall 8):** `phone_number` returns the literal string `"hidden"` for contacts not in our address book [LIVE-VERIFIED]. Surface as `phone_e164: null` in our tool response.

**`has_chat` flag derivation:** Compare `attendee.provider_id` against `chat.attendee_provider_id` for the account. Run `getAllChats({account_type: "WHATSAPP"})` once, build a Set of `attendee_provider_id`s, then for each attendee `has_chat = chatSet.has(attendee.provider_id)`. One extra round-trip; cache for ~60s in the route.

**Optional `query?` substring filter (D-73):** apply on the `name` field (client-side, case-insensitive) after fetch. Do NOT push to Unipile (no filter param on getAllAttendees).

**Tool response:**
```typescript
{
  count: number,
  cursor: string | null,
  items: Array<{
    contact_id: string,           // = attendee.id (Unipile internal)
    name: string,                 // empty string for unknown contacts
    phone_e164: string | null,    // null when Unipile returns "hidden"
    has_chat: boolean,
  }>
}
```

## 5. Vercel Cron Pattern (for unipile-crm-retry)

**Existing analog:** `app/api/cron/update-check/route.ts` [READ in research] — daily cron pattern with `composeRequestPipeline([rehydrateStep, authStep("cron"), rateLimitStep({...}), hydrateCredentialsStep])`. We mirror it exactly for `unipile-crm-retry`.

**vercel.json delta:**
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "crons": [
    { "path": "/api/cron/health", "schedule": "0 8 * * *" },
    { "path": "/api/cron/update-check", "schedule": "0 8 * * *" },
    { "path": "/api/cron/unipile-crm-retry", "schedule": "*/2 * * * *" }
  ]
}
```

**Per-Tenant Plan Caveat (A7):** Vercel Hobby tier limits cron to once/day. If the deploy is on Hobby, `*/2 * * * *` will be rejected at deploy time. Pro+ supports per-minute. Verify in execute-phase; fallback `*/5 * * * *` is fine if needed.

**Cron handler shape (matches health/update-check):**
- `composeRequestPipeline([rehydrateStep, authStep("cron"), rateLimitStep({scope: "cron", keyFrom: "cronSecretTokenId", limit: 120}), hydrateCredentialsStep], handler)`
- Handler scans `unipile:outbox:*` keys → filters `status in {pending, failed}` → checks `next_retry_at` due → calls `TwentyAdapter.notifyEvent(...)` → updates row
- Returns `Response.json({ ok: true, processed, sent, failed, dead })` for observability

**Anti-stampede (optional but recommended):** `kv.setIfNotExists("unipile:crm-retry:lock", "1", {ttlSeconds: 100})` at the top of the handler. With `*/2 * * * *` schedule and 100s lock, overlapping runs are impossible. Pattern from `update-check/route.ts:64-72`.

**Backoff schedule (D-65 + Claude's discretion):**
```typescript
// 60s * attempt^2, capped at 1h. For attempts 1..N:
//   attempt 1 → 60s   (next_retry_at = now + 60s)
//   attempt 2 → 240s = 4 min
//   attempt 3 → 540s = 9 min
//   attempt 4 → 960s = 16 min (dead after this)
function nextRetryAt(attempt: number): string {
  const delaySec = Math.min(60 * attempt ** 2, 3600);
  return new Date(Date.now() + delaySec * 1000).toISOString();
}
```
This honors D-04's spirit ("1min, 5min, 30min") with a closed-form curve that's easier to reason about than a lookup table.

## 6. Twenty CRM webhook ingestion shape (best guess from public docs)

**Twenty's documented webhook RECEIVER convention** [CITED: docs.twenty.com/developers/api-and-webhooks/webhooks via 2026-05-18 web search]:

| Header | Value |
|--------|-------|
| `X-Twenty-Webhook-Signature` | hex digest of HMAC-SHA256(secret).update(`${timestamp}:${json_body}`) |
| `X-Twenty-Webhook-Timestamp` | ISO-8601 timestamp included in the signature payload |

**Recommended outbound POST body shape** (D-64 + reasonable defaults):
```json
{
  "event_type": "linkedin.connection_accepted" | "linkedin.message_received" | "whatsapp.message_received" | "linkedin.connection_sent",
  "timestamp": "2026-05-18T20:00:00.000Z",
  "tenant_id": "cadens_001",
  "audit_id": "uuid-or-null",
  "payload": {
    /* event-specific fields, NO message body per D-62 */
    "recipient_profile_url": "...",
    "content_hash": "sha256-truncated-16chars",
    "received_at": "..."
    /* etc */
  }
}
```

**Compatibility approach:** Send BOTH the Twenty-style headers AND our `X-Kebab-Signature` (same hex digest, different header name). Vanilla Twenty installs verify out of the box; non-Twenty consumers (or future operators on HubSpot/Pipedrive) can verify with our generic header convention. Costs nothing — same signature, two headers.

**Plan note:** Twenty CRM bug CVE-2026-26720 affects Twenty INBOUND webhook handling on Twenty's side (their server has a known vuln) — NOT our outbound POSTs. Operators should be on Twenty ≥ v1.16.0 for security, but this is their concern, not ours.

## 7. New AuditResult + UnipileErrorResult enum members

Audit log enum analysis [from `src/connectors/unipile/lib/audit.ts`]: phase 68/69 already shipped 13 members; phase 70 needs only ONE genuinely new member.

### 7.1 Net-new AuditResult members for phase 70

| Member | From decision | Used by | Trigger |
|--------|--------------|---------|---------|
| `error_account_halted` | D-75 (NEW) | ALL write tools (linkedin_send_*, whatsapp_send_message) | Pre-flight halt-flag check returns truthy; tool refuses without dedup/rate-limit |

**That's it.** No other audit enum changes for phase 70. Reasoning:
- Webhook-event handlers do NOT write audit rows (the audit log is for outbound tool invocations only — per phase 68 architecture). Only the halt-flag pre-flight surfaces in audit, and that maps to `error_account_halted`.
- WhatsApp tools reuse existing enum members verbatim (`success`, `error_rate_limit_kebab`, `unverified_timeout`, `error_attachment_too_large`, etc.) — the underlying SDK errors flow through the same `classifyUnipileError` path as LinkedIn.
- CRM retry cron does NOT write audit rows for retry attempts (would pollute the audit hash space and isn't the audit log's purpose). Outbox row `status` field tracks retry state instead.

**Updated full enum (with phase 70 addition appended):**
```typescript
export type AuditResult =
  // Phase 68 (locked)
  | "success"
  | "unverified_timeout"
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  // Phase 69 — CONTEXT-mandated
  | "dry_run"
  | "error_attachment_too_large"
  | "error_inmail_not_authorized"
  | "error_inmail_requires_premium"
  | "error_invalid_request"
  | "error_rate_limit_kebab"
  | "error_recipient_unreachable"
  // Phase 69 — Claude's discretion
  | "error_inmail_recipient_not_eligible"
  | "error_inmail_cap_exceeded"
  // Phase 70 — D-75 halt-flag pre-flight
  | "error_account_halted";  // NEW
```

### 7.2 UnipileErrorResult — no changes

Phase 70 introduces NO new SDK error mappings. Existing 4xx/5xx classifications in `classifyUnipileError` cover the WhatsApp paths (the same Unipile SDK errors are thrown across LinkedIn and WhatsApp endpoints — they all come from `UnsuccessfulRequestError`).

### 7.3 New `UnipileRateLimitedTool` member

`src/connectors/unipile/lib/rate-limiter.ts:68` currently declares `type UnipileRateLimitedTool = "send_connection" | "send_message" | "send_inmail"`. Phase 70 extends:

```typescript
export type UnipileRateLimitedTool =
  | "send_connection" | "send_message" | "send_inmail"
  | "whatsapp_send";   // NEW (D-68)
```

And `getCaps()` gains:
```typescript
case "whatsapp_send":
  return {
    daily: getConfigInt("KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP", 200),
    weekly: null,
  };
```

### 7.4 New `CrmOutboxStatus` member

`src/connectors/unipile/lib/crm-bridge.ts:48` currently: `"pending" | "sent" | "failed" | "dead"`. Phase 70 adds:

```typescript
export type CrmOutboxStatus =
  | "pending"   // initial — phase 68 skeleton stops here
  | "sending"   // NEW (D-65 amend) — cron has claimed the row and is mid-POST (lambda lifecycle safety net A2)
  | "sent"
  | "failed"
  | "dead";
```

Plus 3 new fields on `CrmOutboxRow` (committed at the row level, NOT a type-only change):

```typescript
export interface CrmOutboxRow {
  audit_id: string;
  status: CrmOutboxStatus;
  crm_log: unknown;
  queued_at: string;
  // Phase 70 — D-65 attempt tracking
  attempts?: number;          // 0 initially, incremented per try
  last_attempt_at?: string;   // ISO of most recent attempt
  next_retry_at?: string;     // ISO of when cron should next pick this up
  error?: string;             // last error reason — surfaced in dashboard
  // Phase 70 — D-59 completion tracking
  completed_at?: string;      // ISO when new_relation handler marked it completed
}
```

## 8. Open Questions for Planner

**Q1 — Cron KV scan strategy [HIGH IMPACT, planner must resolve before Wave 2].** The cron at `/api/cron/unipile-crm-retry` needs to scan ALL tenant outbox rows. Per A8, the keys are stored as `tenant:<id>:unipile:outbox:<audit_id>` (tenant prefix applied by `TenantKVStore`). A scan via `getKVStore().list("unipile:outbox:")` would MISS them all because tenant prefix is first. Options:
- **Option A (recommended):** scan `tenant:` prefix and filter client-side to `*:unipile:outbox:*`. Cheap at Cadens scale (<100 keys per scan).
- **Option B:** maintain a separate index key per tenant (`unipile:outbox:tenants` = JSON Set of tenant_ids) and iterate. Adds write complexity.
- **Option C:** require the cron to receive a `tenant_id` query param and only scan that tenant. Operator must register one cron per tenant in vercel.json — doesn't scale.

**Recommendation:** Option A for phase 70; revisit if metrics show scan exceeding 200ms.

**Q2 — Webhook bootstrap: admin REST endpoint or operator script? [MEDIUM IMPACT].** CONTEXT-Specifics §1 step (1) says "Plan 01 MUST include a setup task that creates a webhook subscription via POST /api/v1/webhooks". Should this be:
- (a) An admin REST endpoint `POST /api/admin/unipile/webhooks/bootstrap` triggered from the /config UI?
- (b) A one-off `scripts/unipile-bootstrap-webhooks.ts` operator runs locally?
- (c) Both — script is the source of truth, admin endpoint wraps the same logic?

**Recommendation:** Option (c) — script first (fast to build, easy to test), then admin endpoint wraps it in phase 71. Lets phase 70 ship without UI dependency.

**Q3 — `account_status` payload event field [LOW IMPACT, deferrable to execute-phase].** The webhook subscription `data` field shows `[{key:"account_status"}, {key:"account_status_specifics"}]` — but we didn't live-trigger this event. The actual payload structure (does it have `event: "account_status_updated"` or just the bare fields?) is A4 in Assumptions. Dispatcher routes by presence of `account_status` field as a fallback. Plan should add an integration test using the documented shape, with a live-verification task in the smoke script.

**Q4 — `verified` semantics for inbound webhook handlers [LOW IMPACT].** Webhook handlers don't have a verify-after-write equivalent (they're inbound, not outbound). The CRM POST status (sent vs failed) is tracked on the outbox row, not in any audit envelope. **Recommendation:** webhook handlers do NOT write audit rows at all — they update outbox rows and POST to CRM. Only the inbound-triggered halt-flag write surfaces in `testConnection()` and the dashboard tile. Planner: confirm.

**Q5 — `is_sender: true` echo skip — what about explicit message_sent observability? [LOW IMPACT].** Pitfall 4 says we should skip dispatching when `is_sender: true` to avoid CRM notification on our own sends. But the operator might want a "sent" notification too (to update a "last contact at" timestamp in CRM). **Recommendation:** phase 70 skips ALL `is_sender: true` events (cleanest). If operators need it later, phase 71 can route them to a separate CRM `event_type: 'message_sent'` POST.

**Q6 — Halt-flag pre-flight in READ tools? [LOW IMPACT].** D-75 says "ALL write tools" check halt flag. What about WhatsApp read tools (list_chats, get_conversation, list_contacts)? Technically a halted account can't read either (the Unipile API will error out). **Recommendation:** also add halt-check to WhatsApp reads — same KV cost, clearer error message ("account halted" vs raw Unipile 403). LinkedIn `get_relationship_status` (phase 68) and `list_pending` (phase 69) should also be retrofitted. Plan should make this explicit (it's a 1-line addition per tool).

**Q7 — webhook.site empirical evidence retention — should we screenshot/save? [MEDIA].** The live capture is documented in this RESEARCH.md. The webhook.site token `446f7da7-88d8-4d0f-b8b2-95a849fc6f2a` expires 2026-05-25. **Recommendation:** the empirical payload is already inlined in §2.2 — no further preservation needed. Cleanup script (already run) deleted the 2 test webhooks on the live tenant; verified `items: []` post-cleanup.

**Q8 — `account_id` → tenant resolution lookup in webhook handlers [MEDIUM IMPACT].** When a webhook arrives, we have `payload.account_id` but no tenant context (no auth header). How does the handler know which tenant owns the account? Options:
- (a) Maintain a KV index `unipile:account-tenant:<account_id>` → `tenant_id`, written when the operator adds the Unipile account in /config. Read at webhook time.
- (b) Scan all tenants and check each tenant's `account.getAll()` for the matching id. Expensive — 1 KV read + 1 SDK call per tenant.
- (c) Single-tenant deployments: skip routing entirely, just use the default tenant context.

**Recommendation:** Option (a) — index maintained at credential-write time. Phase 70 must include a one-time backfill task (read existing tenants, populate the index). Adds maybe 10 LOC + 1 KV key prefix.

## Sources

### Primary (HIGH confidence — empirical / live-verified)
- LIVE webhook payload capture against `api41.unipile.com:17153` + `webhook.site/446f7da7-88d8-4d0f-b8b2-95a849fc6f2a` 2026-05-18 — proves NO HMAC header, static-secret only, full body inlined in §2
- LIVE WhatsApp send via `POST /api/v1/chats` 2026-05-18 — proves `<E164>@s.whatsapp.net` attendee format works
- LIVE `GET /api/v1/webhooks` 2026-05-18 — proves webhook record shape, account_ids[].type union including WHATSAPP
- LIVE `DELETE /api/v1/webhooks/<id>` 2026-05-18 — proves delete returns `{object: "WebhookDeleted"}`, list returns `items: []` post-cleanup
- LIVE 404 on `POST /api/v1/webhooks/<id>/test` 2026-05-18 — proves no test endpoint exists
- SDK source files inspected via direct read (`node_modules/unipile-node-sdk/dist/types/**`) — all method signatures, type unions, validators
- Existing Kebab codebase patterns inspected via direct read (`src/connectors/webhook/route.ts`, `app/api/cron/update-check/route.ts`, `src/connectors/unipile/lib/*`, `vercel.json`)

### Secondary (MEDIUM confidence — official docs)
- developer.unipile.com/docs/webhooks-2 — auth = static `Unipile-Auth` header (no HMAC mention)
- developer.unipile.com/docs/detecting-accepted-invitations — `source: "users"`, `event: "new_relation"`, 8h delay
- developer.unipile.com/docs/new-messages-webhook — message webhook payload list (less complete than live capture)
- docs.twenty.com/developers/api-and-webhooks/webhooks — Twenty signing convention `HMAC-SHA256(secret, "${ts}:${body}")` + `X-Twenty-Webhook-Signature`/`X-Twenty-Webhook-Timestamp` headers

### Tertiary (LOW confidence — contradictory or unverified)
- unipile.com/developer-real-time/ — marketing page mentions HMAC verification but live tenant doesn't send it. D-52 dual-mode covers both scenarios.

## Metadata

**Confidence breakdown:**
- Webhook signing mechanism: **HIGH** — empirically verified on live tenant 2026-05-18; defensive D-52 dual-mode is the right design
- Webhook payload shape (messaging): **HIGH** — live capture verbatim in §2
- Webhook payload shape (account_status, new_relation): **MEDIUM** — derived from subscription schema + docs, not live-triggered
- WhatsApp SDK endpoints: **HIGH** — SDK types verified + live send proves attendee format
- Cron pattern: **HIGH** — existing analog in `update-check/route.ts` is mature
- Twenty CRM signing: **MEDIUM** — docs cited, no live verification against a Twenty install (A1)
- Halt-flag + audit enum: **HIGH** — minimal additions, existing patterns
- Cron KV scan strategy: **MEDIUM** — Q1 needs planner decision

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (30 days — Unipile API behavior empirically locked; revisit if SDK ships a new version, since v1.9.3 has been static for 12 months and a new release could surface `source: "users"` typed support, simplifying §1).

## RESEARCH COMPLETE
