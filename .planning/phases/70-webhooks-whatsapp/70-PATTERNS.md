# Phase 70: Webhooks + WhatsApp V1 — Pattern Map

**Mapped:** 2026-05-18
**Files analyzed:** 18 (4 NEW route/dispatcher + 3 NEW handlers + 4 NEW WhatsApp tools + 1 NEW bootstrap script + 6 MODIFIED + 1 NEW retry-cron file)
**Analogs found:** 16 / 18 — all but the dispatcher router and the WhatsApp recipient resolver have a strong in-repo analog. Both novel files have unambiguous code excerpts in 70-RESEARCH.md (Pattern 5/6, Code Examples A/B/C/D).

**Key insight:** Phase 70 is layered on top of phases 68-69. Every new tool handler can lift the 9-step structure from `linkedin-send-message.ts`. The webhook route + verifier + idempotency idiom comes from `app/api/webhook/[name]/route.ts:44-55,139-146`. The retry cron lifts from `app/api/cron/update-check/route.ts:99-107`. The Twenty real-adapter REPLACES the phase-68 skeleton in-place (keeps the same `CrmAdapter` interface — zero call-site changes for `crmBridge.writeOutbox`). The only fully novel design is the **dual-mode signature verifier** (D-52) — RESEARCH §1 Pattern 1 ships verbatim code.

---

## File Classification

| New/Modified | File | Role | Data Flow | Closest Analog | Match Quality |
|--------------|------|------|-----------|----------------|---------------|
| NEW | `app/api/unipile/webhook/route.ts` | route (webhook ingress) | request-response + fire-and-forget async | `app/api/webhook/[name]/route.ts` (HMAC + pipeline + KV write) | exact-on-pipeline |
| NEW | `src/connectors/unipile/webhook/verifier.ts` | utility (dual-mode HMAC + static-secret verifier) | transform | `src/connectors/webhook/route.ts:44-55` (HMAC + timingSafeEqual idiom) + verbatim RESEARCH §1 Pattern 1 | role-match + verbatim source |
| NEW | `src/connectors/unipile/webhook/dispatcher.ts` | router (event → handler) | event-driven (switch) | **none** — verbatim RESEARCH §1 Code Example B (~30 lines) | no analog (invent) |
| NEW | `src/connectors/unipile/webhook/halt-flag.ts` | library (KV read/write/clear for halt status) | KV transform | `src/connectors/unipile/lib/audit.ts` (KV set/get/delete + tenant scope idiom) + verbatim RESEARCH §1 Code Example D | role-match + verbatim source |
| NEW | `src/connectors/unipile/webhook/handlers/account-status.ts` | handler (write halt flag) | event-driven KV write | `src/connectors/unipile/lib/audit.ts` `writeAuditRow` (KV write + JSON stringify) | role-match |
| NEW | `src/connectors/unipile/webhook/handlers/new-relation.ts` | handler (outbox update + CRM POST) | event-driven + transform | `src/connectors/unipile/lib/crm-bridge.ts` (outbox row read/update pattern) | role-match |
| NEW | `src/connectors/unipile/webhook/handlers/new-message.ts` | handler (CRM POST hash-only) | event-driven | same as `new-relation.ts` analog | role-match |
| NEW | `app/api/cron/unipile-crm-retry/route.ts` | cron route (drain outbox) | scheduled batch + KV scan | `app/api/cron/update-check/route.ts:99-107` (composeRequestPipeline + authStep("cron") + KV write) | exact-on-shape |
| NEW | `src/connectors/unipile/tools/whatsapp-send-message.ts` | tool handler (destructive write) | request-response | `src/connectors/unipile/tools/linkedin-send-message.ts` (9-step handler) | exact (1:1 mirror per D-68) |
| NEW | `src/connectors/unipile/tools/whatsapp-list-chats.ts` | tool handler (read, paginated) | request-response | `src/connectors/unipile/tools/linkedin-list-pending.ts` (cursor-pagination read tool) | exact |
| NEW | `src/connectors/unipile/tools/whatsapp-get-conversation.ts` | tool handler (read, paginated) | request-response | `src/connectors/unipile/tools/linkedin-list-pending.ts` | exact |
| NEW | `src/connectors/unipile/tools/whatsapp-list-contacts.ts` | tool handler (read + client-side filter) | request-response + transform | `src/connectors/unipile/tools/linkedin-list-pending.ts` | exact |
| NEW | `scripts/setup-unipile-webhooks.ts` | script (one-shot subscription bootstrap) | request-response (3x POST) | `scripts/check-doc-counts.ts` (CLI shape only) + RESEARCH §1 verbatim body | partial (CLI shape) + verbatim source |
| REPLACED | `src/connectors/unipile/lib/crm-bridge.ts` | library (adapter interface + REAL Twenty impl) | request-response + KV | the file itself (phase 68 skeleton — `TwentyAdapterSkeleton` kept as alias per D-67) + RESEARCH §1 Pattern 4 verbatim | exact (surgical extend) |
| MODIFIED | `src/connectors/unipile/lib/rate-limiter.ts` | utility (extend tool union with `whatsapp_send`) | n/a | the file itself — add `whatsapp_send` to `UnipileRateLimitedTool` + `getCaps` | exact (surgical) |
| MODIFIED | `src/connectors/unipile/tools/linkedin-send-connection.ts`<br>`...linkedin-send-message.ts`<br>`...linkedin-send-inmail.ts`<br>`...linkedin-engage.ts` | tool handler (retrofit halt-check pre-flight) | n/a | each file itself — insert step 0 (halt-flag check) BEFORE step 1 dedup | exact (surgical insert) |
| MODIFIED | `src/connectors/unipile/manifest.ts` | manifest | static | the file itself — append 4 new defineTool entries to `buildTools()` (lines 157-228) | exact (extend) |
| MODIFIED | `src/core/registry.ts` | registry (lazy loader catalog) | n/a | line 168 unipile entry — change `toolCount: 6 → 10` | exact (one-line) |
| MODIFIED | `tests/contract/kv-allowlist.test.ts` | contract test | n/a | the file itself — add `app/api/unipile/webhook/route.ts` and `app/api/cron/unipile-crm-retry/route.ts` to `ALLOWLIST` Set (lines 34-105) | exact (extend Set) |
| MODIFIED | `vercel.json` | config (cron schedule) | n/a | the file itself — append `{path: "/api/cron/unipile-crm-retry", schedule: "*/2 * * * *"}` to `crons` array | exact (one-entry) |
| MODIFIED | `content/docs/connectors.md` + `README.md` | docs | n/a | the files themselves — count claims `97 → 101 tools` (4 new) | exact (text edit) |

---

## Pattern Assignments

### NEW: `app/api/unipile/webhook/route.ts` (route — webhook ingress)

**Analog:** `app/api/webhook/[name]/route.ts` (`composeRequestPipeline` + `bodyParseStep` + HMAC verify + KV write idiom; lines 1-9, 44-55, 57-65, 77-78, 139-146)

**Imports pattern** (webhook/[name]/route.ts:1-10 — model directly):
```typescript
import { createHmac, createHash, timingSafeEqual } from "crypto";
import { getKVStore } from "@/core/kv-store";  // ROOT scope per D-81 / Pitfall 1
import {
  composeRequestPipeline,
  rehydrateStep,
  bodyParseStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { verifyUnipileWebhook } from "@/connectors/unipile/webhook/verifier";
import { dispatchEventAsync, getIdempotencyKey } from "@/connectors/unipile/webhook/dispatcher";
```

**Pipeline composition pattern** (webhook/[name]/route.ts:139-146 — model exactly):
```typescript
export const POST = composeRequestPipeline(
  [
    rehydrateStep,
    // NO rateLimitStep — unlike the generic receiver. Unipile sends ≤5 webhooks/sec; the 30s
    // reply budget is the real backstop. Empirical webhook traffic is well under 1 req/min.
    bodyParseStep({ maxBytes: MAX_PAYLOAD_BYTES }),
  ],
  unipileWebhookHandler
);
```

**Body re-serialization for HMAC pattern** (webhook/[name]/route.ts:77-78 — load-bearing for HMAC over raw body):
```typescript
const parsed = ctx.parsedBody;
const body: string = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "");
```

**KV write pattern (root scope)** (webhook/[name]/route.ts:112-114 — but swap `getContextKVStore` → `getKVStore` per D-81):
```typescript
// D-81 + Pitfall 1: ROOT scope — webhook has no tenant context until handler reads account_id
const kv = getKVStore();
const setRes = await kv.setIfNotExists?.(`unipile:webhook:event:${idemKey}`, "1", {
  ttlSeconds: 86400, // 24h per D-54
});
```

**Fire-and-forget pattern** (verbatim from RESEARCH §1 Pattern 3 — Vercel keeps lambda alive ~30s post-response):
```typescript
void dispatchEventAsync(payload).catch((err) =>
  log.error("webhook dispatch failed", { error: toMsg(err), event: payload.event })
);
return new Response(JSON.stringify({ ok: true }), { status: 200 });
```

**Full skeleton:** see RESEARCH.md Code Example A (lines 590-643) — ready to paste with these adjustments:
- Replace `bodyParseStep` import path if it's slightly different
- Confirm `setIfNotExists` is exported on the KVStore type (Phase 49 verified)

**Deviation notes:**
- **Critical D-82 carve-out:** Unipile sends `Content-Type: application/x-www-form-urlencoded` even when the body IS valid JSON. The `bodyParseStep` already handles JSON-first parsing with raw-string fallback (webhook/[name]/route.ts:77-78). Verify in test: `bodyParseStep` must NOT URL-decode when content-type is form-urlencoded — it must try JSON parse first. If `bodyParseStep` URL-decodes ahead of JSON parse, this route needs a manual override: read raw body via `ctx.request.text()` instead.
- **No `rateLimitStep`** on the route (unlike the generic webhook receiver which has 30/min/IP). The 30s lambda response budget + KV idempotency dedup is the rate-defense.
- **Secret missing → 503, not 401.** Per RESEARCH §A, return 503 with `{error: "webhook_not_configured"}` if `UNIPILE_WEBHOOK_SECRET` is unset. This is deliberate signal-to-noise: 401 means "I expected a secret but yours is wrong" — 503 means "I'm not even set up yet".
- **Logger tag:** `CONNECTOR:unipile-webhook` (sub-tag per RESEARCH.md Project Constraints) — distinct from `CONNECTOR:unipile` so log filters work per surface.
- **MAX_PAYLOAD_BYTES = 256 * 1024** (256KB) per RESEARCH §A — Unipile messaging payloads are 1-2KB, account_status ~500B; 256KB is generous + protective vs DoS body-flood.

---

### NEW: `src/connectors/unipile/webhook/verifier.ts` (utility — dual-mode HMAC + static)

**Analog:** `src/connectors/webhook/route.ts:44-55` (`verifySignature` HMAC + `timingSafeEqual` over `createHash`-hashed buffers)

**Existing pattern to mirror** (webhook/route.ts:44-55 — verbatim load-bearing technique):
```typescript
function verifySignature(body: string, name: string, signature: string): boolean {
  const envKey = `MYMCP_WEBHOOK_SECRET_${name.toUpperCase().replace(/-/g, "_")}`;
  const secret = getConfig(envKey);
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  // Hash both sides to fixed length before comparing — prevents timing leak
  // on length mismatch (timingSafeEqual throws on different-length buffers).
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(signature).digest();
  return timingSafeEqual(expectedHash, providedHash);
}
```

**Full skeleton** (RESEARCH §1 Pattern 1, lines 230-266 — ship VERBATIM with the file-header comment annotating defensive dual-mode reasoning):
```typescript
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export type VerifyMode = "hmac" | "static" | "rejected";
export interface VerifyResult { mode: VerifyMode; ok: boolean; reason?: string }

export function verifyUnipileWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
): VerifyResult {
  // Path 1: HMAC-SHA256 of raw body via X-Unipile-Signature (defensive — D-76 says
  // this branch will likely never fire on the live tenant, but it's cheap insurance).
  const sig = headers.get("x-unipile-signature");
  if (sig) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const expHash = createHash("sha256").update(expected).digest();
    const sigHash = createHash("sha256").update(sig).digest();
    if (timingSafeEqual(expHash, sigHash)) return { mode: "hmac", ok: true };
    // HMAC header present but mismatched — REJECT HARD (downgrade-attack guard).
    return { mode: "hmac", ok: false, reason: "hmac_mismatch" };
  }

  // Path 2: static-secret equality on Unipile-Auth header (the empirical
  // path D-76 — this is what the live tenant actually uses 2026-05-18).
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

**Deviation notes:**
- **Anti-pattern (Pitfall in RESEARCH §AntiPatterns):** the `if (sig)` branch MUST NOT fall through to the static path on HMAC mismatch — that would be an unsafe downgrade. Only HMAC header ABSENT triggers fallback.
- Use `node:crypto` import (built-in, no dep).
- Tests must cover: HMAC valid, HMAC mismatch (returns mode='hmac' ok=false), static valid, static mismatch, both absent (returns mode='rejected'). Use `Headers` object literal (Web API) — not an `IncomingHttpHeaders` style.

---

### NEW: `src/connectors/unipile/webhook/dispatcher.ts` (router — event → handler)

**Analog:** **none** — invent per RESEARCH §1 Code Example B (lines 647-677, ~30 LOC verbatim).

**Full skeleton** (RESEARCH §1 Code Example B — ship verbatim):
```typescript
import { getLogger } from "@/core/logging";
import { handleMessageReceived } from "./handlers/message-received";
import { handleNewRelation } from "./handlers/new-relation";
import { handleAccountStatus } from "./handlers/account-status";

const log = getLogger("CONNECTOR:unipile-webhook");

/**
 * Derive the idempotency key per event type (Pitfall 7 — Unipile has no
 * unified `event_id`; `message_id` is per-message unique for messaging,
 * but new_relation + account_status need composite keys).
 */
export function getIdempotencyKey(p: Record<string, unknown>): string | null {
  const event = String(p.event ?? "");
  if (event === "message_received" && typeof p.message_id === "string") return p.message_id;
  if (event === "new_relation" && typeof p.account_id === "string" && typeof p.user_provider_id === "string")
    return `${p.account_id}:${p.user_provider_id}`;
  // account_status webhook payload has no top-level `event` field per the
  // subscription schema — it has `account_status` field instead.
  if (typeof p.account_id === "string" && typeof p.account_status === "string")
    return `${p.account_id}:${p.account_status}:${p.timestamp ?? Date.now()}`;
  return null;
}

export async function dispatchEventAsync(payload: Record<string, unknown>): Promise<void> {
  const event = String(payload.event ?? "");
  // D-78 / Pitfall 4 — skip echoed outbound messages (Unipile sends message_received
  // for BOTH inbound AND outbound — `is_sender: true` means it's our own outbound).
  if (event === "message_received" && payload.is_sender === true) {
    log.debug("skipping outbound echo", { message_id: payload.message_id });
    return;
  }
  switch (event) {
    case "message_received": return handleMessageReceived(payload);
    case "new_relation":     return handleNewRelation(payload);
    default:
      // account_status path: detect by `account_status` field, NOT by `event` field.
      if (typeof payload.account_status === "string") return handleAccountStatus(payload);
      log.warn("unknown event type", { event });
  }
}
```

**Tenant-routing helper** (NEW — must read the `unipile:account-tenant:<account_id>` reverse index per D-81 before invoking tenant-scoped KV operations):
```typescript
import { getKVStore } from "@/core/kv-store"; // ROOT scope — same allowlist exemption as the route
import { runWithTenant } from "@/core/request-context"; // verify name in src/core/request-context.ts

export async function resolveTenantFromAccountId(accountId: string): Promise<string | null> {
  const kv = getKVStore();
  const raw = await kv.get(`unipile:account-tenant:${accountId}`);
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// Wrap any handler body that needs tenant-scoped KV access:
//   const tenantId = await resolveTenantFromAccountId(payload.account_id);
//   if (!tenantId) { log.warn(...); return; }
//   await runWithTenant(tenantId, async () => { /* tenant-scoped writes */ });
```

**Deviation notes:**
- **D-81 NEW reverse index** `unipile:account-tenant:<account_id> → tenant_id` (root-scope) — must be written at account-claim time (operator action in the dashboard, NOT in this phase) AND on first observation by this dispatcher when present in payload. **Plan task:** add a helper `claimAccountForTenant(accountId, tenantId)` for the dashboard-side write; dispatcher writes opportunistically if missing.
- Logger tag `CONNECTOR:unipile-webhook` (same as the route — log filter cleanliness).
- Tests: 4 cases — message_received routing, new_relation routing, account_status routing, is_sender:true skip, unknown event warn.

---

### NEW: `src/connectors/unipile/webhook/halt-flag.ts` (library — halt-flag KV helpers)

**Analog:** `src/connectors/unipile/lib/audit.ts` (tenant-scoped KV set/get/delete; +`getContextKVStore` import pattern)

**Full skeleton** (RESEARCH §1 Code Example D, lines 706-736 — ship verbatim):
```typescript
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

**KV-key shape:** `unipile:halt:<account_id>` — auto-prefixed to `tenant:<id>:unipile:halt:<account_id>` by `getContextKVStore()` (same convention as `unipile:audit:*`, `unipile:urn:*`, `unipile:outbox:*` — no allowlist entry needed).

**Deviation notes:**
- Pre-flight read happens INSIDE the write tool handlers (D-75) — see "MODIFIED write tools" section below.
- Write/clear happens INSIDE `handlers/account-status.ts` — see next pattern.
- The `RECOVERY_STATUSES` set is critical (RESEARCH Anti-Pattern #5): if the handler only writes the flag on error but never clears on recovery, accounts stay halted forever.

---

### NEW: `src/connectors/unipile/webhook/handlers/account-status.ts` (handler — write/clear halt flag)

**Analog:** `src/connectors/unipile/lib/audit.ts` `writeAuditRow` (KV write with JSON stringify) + the halt-flag library above

**Handler skeleton** (build per D-56 + D-58 + RESEARCH Anti-Pattern #5):
```typescript
import { getLogger } from "@/core/logging";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";
import { writeHaltFlag, clearHaltFlag, isHaltStatus, isRecoveryStatus } from "../halt-flag";
import { resolveTenantFromAccountId } from "../dispatcher";
import { runWithTenant } from "@/core/request-context";

const log = getLogger("CONNECTOR:unipile-webhook");

export async function handleAccountStatus(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.account_id ?? "");
  const status = String(payload.account_status ?? "");
  if (!accountId || !status) {
    log.warn("account_status missing account_id or status", { keys: Object.keys(payload) });
    return;
  }

  const tenantId = await resolveTenantFromAccountId(accountId);
  if (!tenantId) {
    log.warn("account_status — no tenant mapping for account", { accountId, status });
    return;
  }

  await runWithTenant(tenantId, async () => {
    if (isHaltStatus(status)) {
      await writeHaltFlag(accountId, {
        reason: String(payload.account_status_specifics ?? status),
        halted_at: new Date().toISOString(),
        status,
      });
      log.warn("account halted", { accountId, status, tenantId });

      // D-58: optional operator notification
      const notifyUrl = getConfig("KEBAB_UNIPILE_NOTIFY_WEBHOOK_URL");
      if (notifyUrl) {
        try {
          await fetch(notifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenant_id: tenantId, account_id: accountId, status, halted_at: new Date().toISOString() }),
          });
        } catch (err) {
          log.warn("notify webhook failed", { err: toMsg(err) });
        }
      }
    } else if (isRecoveryStatus(status)) {
      await clearHaltFlag(accountId);
      log.info("account recovered — halt cleared", { accountId, status, tenantId });
    } else {
      log.debug("account_status no-op (neither halt nor recovery)", { accountId, status });
    }
  });
}
```

**Deviation notes:**
- **Must clear on recovery** (RESEARCH Anti-Pattern #5). Tests must include a recovery transition that asserts `kv.delete` was called.
- The `account_status_specifics` field shape is INFERRED per A4 (Assumptions Log) — plan should include integration test with documented shape.
- No audit row (inbound events don't pollute the dedup hash space — RESEARCH Anti-Pattern #5b).
- D-58 fire-and-forget for the notify URL — don't let a webhook timeout block the halt-flag write.

---

### NEW: `src/connectors/unipile/webhook/handlers/new-relation.ts` (handler — outbox update + CRM POST)

**Analog:** `src/connectors/unipile/lib/crm-bridge.ts` (outbox row idiom — read JSON, mutate, write back)

**Outbox update pattern** (lift the row shape from crm-bridge.ts:55-60 + extend with completion fields):
```typescript
import { getContextKVStore } from "@/core/request-context";
import { runWithTenant } from "@/core/request-context";
import { getLogger } from "@/core/logging";
import { TwentyAdapter } from "../../lib/crm-bridge";
import { resolveTenantFromAccountId } from "../dispatcher";

const log = getLogger("CONNECTOR:unipile-webhook");
const crm = new TwentyAdapter(); // singleton constructed at module load

export async function handleNewRelation(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.account_id ?? "");
  const userProviderId = String(payload.user_provider_id ?? "");
  if (!accountId || !userProviderId) return;

  const tenantId = await resolveTenantFromAccountId(accountId);
  if (!tenantId) {
    log.warn("new_relation — no tenant mapping", { accountId });
    return;
  }

  await runWithTenant(tenantId, async () => {
    const kv = getContextKVStore();

    // D-59: best-effort — find the matching audit row via dedup hash pointer.
    // The match is keyed on recipient_provider_id (we already have audit row's
    // params_hash → audit_id pointer mapping from phase 68 — we need a NEW
    // secondary index by recipient_provider_id, OR walk all outbox rows and
    // match server-side).
    // PLANNER NOTE: D-77 says new_relation arrives up to 8h late — best-effort
    // is the right semantics; D-60 fallback handles miss with audit_id: null.
    let matchingAuditId: string | null = null;
    // ... attempt lookup ...

    if (matchingAuditId) {
      const outboxKey = `unipile:outbox:${matchingAuditId}`;
      const raw = await kv.get(outboxKey);
      if (raw) {
        try {
          const row = JSON.parse(raw) as { status: string; crm_log: unknown; queued_at: string };
          const updated = { ...row, status: "completed", completed_at: new Date().toISOString() };
          await kv.set(outboxKey, JSON.stringify(updated));
        } catch (err) {
          log.warn("outbox update failed", { err: String(err) });
        }
      }
    }

    // D-59/D-60: POST CRM webhook (audit_id null on miss)
    await crm.notifyEvent({
      event_type: "linkedin.connection_accepted",
      payload: {
        recipient_profile_url: typeof payload.user_public_id === "string"
          ? `https://linkedin.com/in/${payload.user_public_id}` : null,
        audit_id: matchingAuditId,
        accepted_at: new Date().toISOString(),
        source: matchingAuditId ? "kebab_invitation" : "external_invitation",
      },
      tenant_id: tenantId,
    });
  });
}
```

**Deviation notes:**
- D-77 (8h delay): tests must NOT depend on real-time arrival. Mock the late event explicitly.
- D-60 fallback (no matching audit): still POST with `audit_id: null, source: 'external_invitation'`. CRM decides what to do.
- The "find matching audit row by recipient_provider_id" lookup is the open implementation question. Two viable paths:
  1. NEW secondary index: `unipile:audit:recipient:<provider_id> → audit_id` (write at send time in phase 68/69 tools)
  2. Scan outbox rows and filter (slow if outbox is large)
  3. Skip the lookup entirely — go straight to D-60 fallback (acceptable if CRM tolerates audit_id: null on connection acceptances)
- **Recommendation:** ship Option 3 in phase 70 (simplest) + add Option 1 in a backlog ticket for phase 71 if CRM dashboard needs the audit_id correlation.

---

### NEW: `src/connectors/unipile/webhook/handlers/new-message.ts` (handler — CRM POST hash-only)

**Analog:** same as `new-relation.ts` (TwentyAdapter notifyEvent pattern)

**Handler skeleton** (build per D-61 + D-62 + Pitfall 4):
```typescript
import { createHash } from "node:crypto";
import { getLogger } from "@/core/logging";
import { runWithTenant } from "@/core/request-context";
import { TwentyAdapter } from "../../lib/crm-bridge";
import { resolveTenantFromAccountId } from "../dispatcher";

const log = getLogger("CONNECTOR:unipile-webhook");
const crm = new TwentyAdapter();

export async function handleMessageReceived(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.account_id ?? "");
  const messageId = String(payload.message_id ?? "");
  if (!accountId || !messageId) return;

  // D-78 / Pitfall 4 — outbound echoes already filtered in dispatcher.ts;
  // double-check here as a defense-in-depth (logs only).
  if (payload.is_sender === true) {
    log.warn("handleMessageReceived received is_sender:true — dispatcher filter missed", { messageId });
    return;
  }

  const tenantId = await resolveTenantFromAccountId(accountId);
  if (!tenantId) {
    log.warn("message_received — no tenant mapping", { accountId });
    return;
  }

  await runWithTenant(tenantId, async () => {
    // D-62 GDPR: NEVER POST the message body — only a SHA-256 truncated hash.
    const bodyText = String(payload.body ?? payload.message ?? "");
    const contentHash = createHash("sha256").update(bodyText).digest("hex").slice(0, 16);

    // Determine channel — Unipile messaging covers both LinkedIn DMs + WhatsApp inbound.
    const accountType = String(payload.account_type ?? payload.provider ?? "");
    const eventType = accountType === "WHATSAPP"
      ? "whatsapp.message_received"
      : "linkedin.message_received";

    await crm.notifyEvent({
      event_type: eventType,
      payload: {
        sender_profile_url: typeof payload.sender_public_id === "string"
          ? `https://linkedin.com/in/${payload.sender_public_id}` : null,
        sender_phone: accountType === "WHATSAPP" && typeof payload.sender_attendee_id === "string"
          ? payload.sender_attendee_id.replace(/@s\.whatsapp\.net$/, "")
          : null,
        content_hash: contentHash,
        received_at: new Date().toISOString(),
        message_id: messageId,
        chat_id: typeof payload.chat_id === "string" ? payload.chat_id : null,
      },
      tenant_id: tenantId,
    });

    // D-63: optional Slack notification (gated by KEBAB_UNIPILE_INBOUND_NOTIFY=true)
    // ... see RESEARCH §D-63 for the simple POST shape ...
  });
}
```

**Deviation notes:**
- **D-62 hard rule:** body NEVER leaves Kebab. Tests must assert the `payload.content_hash` is a 16-char hex string and the original `bodyText` does NOT appear anywhere in the CRM POST.
- **Double-filter `is_sender`:** dispatcher already filters; handler logs a warning if it sees one anyway (catches dispatcher bugs).
- Tenant resolution mandatory — silent drop with warn log if missing (operator must claim the account).

---

### NEW: `app/api/cron/unipile-crm-retry/route.ts` (cron route — drain outbox)

**Analog:** `app/api/cron/update-check/route.ts:99-107` (composeRequestPipeline + authStep("cron") + KV write)

**Imports + pipeline pattern** (update-check/route.ts:1-13, 99-107 — copy verbatim, swap KV scan logic):
```typescript
import { NextResponse } from "next/server";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  rateLimitStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getKVStore } from "@/core/kv-store";  // ROOT scope per D-80
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import { TwentyAdapter, type CrmOutboxRow } from "@/connectors/unipile/lib/crm-bridge";
import { runWithTenant } from "@/core/request-context";

const log = getLogger("cron.unipile-crm-retry");
const crm = new TwentyAdapter();
```

**KV scan pattern (D-80 cross-tenant)** — CRITICAL FIX:
```typescript
// D-80: outbox rows are stored at `tenant:<id>:unipile:outbox:<audit_id>`.
// `kv.list("unipile:outbox:")` would miss them because the tenant prefix is
// inserted BEFORE the prefix we're searching for. Scan with `tenant:` and
// filter by suffix.
async function listAllTenantOutboxKeys(kv: ReturnType<typeof getKVStore>): Promise<Array<{ key: string; tenantId: string; auditId: string }>> {
  const allTenantKeys = await kv.list("tenant:");
  const out: Array<{ key: string; tenantId: string; auditId: string }> = [];
  for (const key of allTenantKeys) {
    const m = key.match(/^tenant:([^:]+):unipile:outbox:(.+)$/);
    if (m && m[1] && m[2]) out.push({ key, tenantId: m[1], auditId: m[2] });
  }
  return out;
}
```

**Handler skeleton (state machine D-65 + D-84 stuck-sending recovery)**:
```typescript
async function cronUnipileCrmRetryHandler(_ctx: PipelineContext): Promise<Response> {
  const kv = getKVStore();
  const allRows = await listAllTenantOutboxKeys(kv);
  let processed = 0, sent = 0, failed = 0, dead = 0, skipped = 0;
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const now = Date.now();

  for (const { key, tenantId, auditId } of allRows) {
    const raw = await kv.get(key);
    if (!raw) { skipped++; continue; }
    let row: CrmOutboxRow & { attempts?: number; next_retry_at?: string; sending_at?: string; last_error?: string };
    try { row = JSON.parse(raw); } catch { skipped++; continue; }

    if (row.status === "sent" || row.status === "dead") { skipped++; continue; }

    // D-84: rows stuck in `sending` for >5min are lambda-died — re-pick them up
    if (row.status === "sending" && row.sending_at && (now - new Date(row.sending_at).getTime()) < FIVE_MIN_MS) {
      skipped++; continue;
    }

    // Backoff check (D-65): skip if next_retry_at hasn't elapsed
    if (row.next_retry_at && new Date(row.next_retry_at).getTime() > now) {
      skipped++; continue;
    }

    processed++;

    // D-84: mark sending atomically before the POST
    const sendingRow = { ...row, status: "sending" as const, sending_at: new Date().toISOString() };
    await kv.set(key, JSON.stringify(sendingRow));

    // D-66: per-tenant POST attempt
    const result = await runWithTenant(tenantId, async () => {
      return crm.notifyEvent({
        event_type: String((row.crm_log as Record<string, unknown> | null)?.event_type ?? "outbox.generic"),
        payload: row.crm_log as Record<string, unknown>,
        tenant_id: tenantId,
      });
    });

    if (result.ok) {
      await kv.set(key, JSON.stringify({ ...sendingRow, status: "sent", sent_at: new Date().toISOString() }));
      sent++;
    } else {
      const attempts = (row.attempts ?? 0) + 1;
      const nextStatus = attempts >= 3 ? "dead" : "failed";
      // D-04 backoff: 60s × 2^(attempts-1), capped at 1h
      const backoffMs = Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
      await kv.set(key, JSON.stringify({
        ...sendingRow,
        status: nextStatus,
        attempts,
        last_error: result.error ?? `http_${result.status ?? "unknown"}`,
        next_retry_at: nextStatus === "failed" ? new Date(now + backoffMs).toISOString() : undefined,
      }));
      if (nextStatus === "dead") dead++; else failed++;
    }
  }

  log.info("cron unipile-crm-retry complete", { processed, sent, failed, dead, skipped });
  return NextResponse.json({ ok: true, processed, sent, failed, dead, skipped });
}

export const GET = composeRequestPipeline(
  [
    rehydrateStep,
    authStep("cron"),
    rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 }),
    hydrateCredentialsStep,
  ],
  cronUnipileCrmRetryHandler
);
```

**Deviation notes:**
- **D-80 critical:** scan with `kv.list("tenant:")` then filter — NOT `kv.list("unipile:outbox:")` (would return zero rows). Tests MUST cover the multi-tenant case explicitly (assumption A8 risk).
- **D-84 stuck-sending:** rows in `sending` >5min get re-picked. This is the lambda-died safety net (A2 risk mitigation).
- **Idempotency at the receiver:** repeated POSTs from this cron must be safe at Twenty (Twenty's spec includes timestamp-based replay protection — out of our hands).
- **`kv-allowlist.test.ts` update:** this file uses `getKVStore()` (root scope per D-80) — add to ALLOWLIST.
- Logger tag `cron.unipile-crm-retry` matches existing cron convention (`cron.update-check`, `cron.health`).

---

### NEW: `src/connectors/unipile/tools/whatsapp-send-message.ts` (tool handler — destructive write)

**Analog:** `src/connectors/unipile/tools/linkedin-send-message.ts` (9-step handler — copy structure 1:1 per D-68; swap profile→phone resolver + drop degree-check + drop polling)

**Imports pattern** (linkedin-send-message.ts:74-93 — same set, swap account resolver to WhatsApp-typed):
```typescript
import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import {
  computeParamsHash,
  checkDedup,
  writeAuditRow,
  generateAuditId,
  type AuditResult,
} from "../lib/audit";
import { crmBridge } from "../lib/crm-bridge";
import { classifyUnipileError, UnipileAttachmentTooLargeError } from "../lib/errors";
import { checkUnipileRateLimit } from "../lib/rate-limiter";
import { resolveWhatsappAccount } from "../lib/account"; // NEW — see Deviations
import { readHaltFlag } from "../webhook/halt-flag"; // NEW — D-75
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
```

**Schema pattern** (RESEARCH §1 Code Example C, lines 681-693 — verbatim):
```typescript
export const whatsappSendMessageSchema = {
  to: z.string().describe("E.164 phone (e.g. +33660036335) OR existing chat_id."),
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
```

**Handler skeleton — 8-step flow (D-75 halt-check inserted as step 0)** (lift linkedin-send-message.ts:233-end, drop degree-check, swap profile resolution):
```typescript
export async function handleWhatsappSendMessage(args: WhatsappSendMessageArgs): Promise<ToolResult> {
  const auditId = generateAuditId();

  // ═══ Step 0 (NEW D-75): HALT-FLAG PRE-FLIGHT — highest priority ═══
  // Note: halt check requires account_id; if not provided, deferred to after resolution.
  if (args.account_id) {
    const halt = await readHaltFlag(args.account_id);
    if (halt) {
      await writeAuditRow({
        audit_id: auditId, actor_user_id: args.actor_user_id, tool: "whatsapp_send_message",
        account_id: args.account_id, params_hash: "halted",
        result: "error_account_halted", verified: false, dedup_hit: false,
        timestamp: new Date().toISOString(),
      });
      return envelope({
        provider_ok: false, verified: false, crm_sync: "pending", dedup_hit: false,
        audit_id: auditId, error: "error_account_halted",
        halt_reason: halt.reason, halted_at: halt.halted_at,
      });
    }
  }

  // ═══ Step 1: DEDUP (D-49 — re-sends don't burn quota) ═══
  const paramsHash = computeParamsHash({
    tool: "whatsapp_send_message",
    profile_url_normalized: args.to, // E.164 or chat_id, used as-is for dedup
    note: args.text,
  });
  const dup = await checkDedup(paramsHash);
  if (dup) { /* same dedup envelope as linkedin-send-message.ts:259-278 */ }

  // ═══ Step 2: ACCOUNT-RESOLVE (D-68 — WhatsApp-typed) ═══
  const acct = await resolveWhatsappAccount(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) { /* error envelope */ }

  // ═══ Step 2b (D-75 re-check if account_id was inferred): halt-flag ═══
  if (!args.account_id) {
    const halt = await readHaltFlag(acct.accountId);
    if (halt) { /* same halt envelope */ }
  }

  // ═══ Step 3: ATTACHMENT-DECODE (pre-flight) ═══
  // Same as linkedin-send-message.ts attachment loop (15MB cap, base64 decode → [filename, Buffer][])

  // ═══ Step 4: RECIPIENT-RESOLVE (D-69 + D-83) ═══
  // D-83: E.164 → `<phone>@s.whatsapp.net` (no SDK round-trip). chat_id passthrough.
  let attendeeId: string;
  let chatId: string | undefined;
  if (args.to.startsWith("+")) {
    attendeeId = `${args.to.replace(/^\+/, "")}@s.whatsapp.net`;
  } else {
    // Assume it's already a chat_id — call sendMessage instead of startNewChat
    chatId = args.to;
    attendeeId = ""; // unused on the existing-chat path
  }

  // ═══ Step 5: RATE-LIMIT (D-68 — whatsapp_send tool key) ═══
  const rl = await checkUnipileRateLimit({ account_id: acct.accountId, tool: "whatsapp_send" });
  if (rl.blocked) { /* same blocked envelope as linkedin-send-message.ts */ }

  // ═══ Step 6: CRM OUTBOX ═══
  await crmBridge.writeOutbox(auditId, { crm_log: args.crm_log ?? null });

  // ═══ Step 7: SEND ═══
  const client = getUnipileClient();
  const resp = chatId
    ? await withRetry(() => client.messaging.sendMessage({
        account_id: acct.accountId,
        chat_id: chatId!,
        text: args.text,
        ...(attachmentTuples ? { attachments: attachmentTuples } : {}),
      }))
    : await withRetry(() => client.messaging.startNewChat({
        account_id: acct.accountId,
        attendees_ids: [attendeeId],
        text: args.text,
        ...(attachmentTuples ? { attachments: attachmentTuples } : {}),
      }));

  // ═══ Step 8: AUDIT + ENVELOPE (no verify-after-write — V1 trusts SDK message_id) ═══
  // ... writeAuditRow + envelope per D-74
}
```

**Deviation notes:**
- **D-68:** mirror the 9-step shape of `linkedin-send-message.ts` 1:1 but DROP the degree-check step (WhatsApp has no equivalent) and DROP the verify-after-write poll (V1 — D-74 says trust the `message_id` returned by startNewChat synchronously; phase 71 can add polling if needed).
- **D-69 + D-83:** E.164 → `<phone>@s.whatsapp.net` (server-side string concat). No `users.getProfile` round-trip per Pitfall 8 (verified live).
- **NEW lib function `resolveWhatsappAccount`:** extend `src/connectors/unipile/lib/account.ts` to accept a `type` filter (`"WHATSAPP" | "LINKEDIN"`). Currently filters only LinkedIn. Either:
  - Option A: add a second exported function `resolveWhatsappAccount` (clean separation)
  - Option B: parameterize `resolveAccountId` with `{ type?: "WHATSAPP" | "LINKEDIN" }` (one function, two callers)
  - **Recommended:** Option B (DRY, single source of truth — same `account.getAll()` round-trip; just filter on `type` parameter)
- **`sendMessage` vs `startNewChat`:** Unipile SDK has BOTH; use `sendMessage` when a `chat_id` is provided (existing chat), `startNewChat` for first contact (new chat). Verified live.
- **Halt check duplication:** if `account_id` is inferred from `account.getAll()`, do the halt check AFTER resolution (step 2b). Acceptable extra KV read.
- **`message_id` is per-call unique:** dedup-hit caller won't get a new message_id (envelope returns `dedup_hit: true` instead).
- Logger tag `CONNECTOR:unipile` (same as LinkedIn tools — they share the connector surface).

---

### NEW: `src/connectors/unipile/tools/whatsapp-list-chats.ts` (tool handler — read, paginated)

**Analog:** `src/connectors/unipile/tools/linkedin-list-pending.ts` (cursor-pagination read tool — no rate-limit, no audit row, no dedup)

**Schema pattern** (model on linkedin-list-pending.ts:502-509 — adapt for chats):
```typescript
export const whatsappListChatsSchema = {
  account_id: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20)
    .describe("Max chats to return (default 20, cap 100). Sorted by last_message_at DESC per D-71."),
  cursor: z.string().optional().describe("Pagination cursor from previous call."),
};
```

**Handler skeleton** (model on linkedin-list-pending.ts:514-549 — strip filtering, just paginate):
```typescript
export async function handleWhatsappListChats(args: ListChatsArgs): Promise<ToolResult> {
  const acct = await resolveWhatsappAccount(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) return envelope({ items: [], count: 0, error: acct.error });

  const resp = await withRetry(() =>
    getUnipileClient().messaging.getAllChats({
      account_id: acct.accountId,
      account_type: "WHATSAPP", // D-71 filter
      limit: Math.min(args.limit ?? 20, 100),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    })
  );
  const items = ((resp as { items?: Array<Record<string, unknown>> }).items ?? []).map(c => ({
    chat_id: c.id ?? null,
    attendee_provider_id: c.attendee_provider_id ?? null,
    last_message_at: c.timestamp ?? null,
    unread_count: c.unread_count ?? 0,
  }));
  const nextCursor = (resp as { cursor?: string | null }).cursor ?? null;
  return envelope({ items, count: items.length, cursor: nextCursor });
}
```

**Deviation notes:**
- **NOT destructive.** NO rate-limit check (idempotent read per D-68). NO audit row.
- D-71: default limit 20, max 100. Sort happens server-side (Unipile returns `last_message_at DESC` by default).
- Add the `account_type: "WHATSAPP"` filter (the `messaging.getAllChats` SDK method needs it — otherwise returns LinkedIn chats too).
- Cursor pagination same as `linkedin-list-pending` — pass `cursor` from response back as next call's input.

---

### NEW: `src/connectors/unipile/tools/whatsapp-get-conversation.ts` (tool handler — read, paginated)

**Analog:** `src/connectors/unipile/tools/linkedin-list-pending.ts` (same structure as `whatsapp-list-chats.ts` but for messages in a chat)

**Schema pattern**:
```typescript
export const whatsappGetConversationSchema = {
  chat_id: z.string().describe("Unipile chat_id (from whatsapp_list_chats)."),
  limit: z.number().int().positive().max(200).default(50)
    .describe("Max messages to return (default 50, cap 200). Per D-72."),
  cursor: z.string().optional().describe("Pagination cursor."),
};
```

**Handler skeleton** (uses `messaging.getAllMessagesFromChat` SDK method — same one used by `linkedin-send-message.ts` pollForMessage at line 195):
```typescript
export async function handleWhatsappGetConversation(args: GetConversationArgs): Promise<ToolResult> {
  const resp = await withRetry(() =>
    getUnipileClient().messaging.getAllMessagesFromChat({
      chat_id: args.chat_id,
      limit: Math.min(args.limit ?? 50, 200),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    })
  );
  const items = ((resp as { items?: Array<Record<string, unknown>> }).items ?? []).map(m => ({
    message_id: m.id ?? null,
    is_sender: m.is_sender === 1,
    sender_attendee_id: m.sender_attendee_id ?? null,
    text: m.text ?? null,
    attachments: m.attachments ?? [],
    timestamp: m.timestamp ?? null,
  }));
  const nextCursor = (resp as { cursor?: string | null }).cursor ?? null;
  return envelope({ items, count: items.length, cursor: nextCursor });
}
```

**Deviation notes:**
- **NOT destructive.** No rate-limit, no audit, no dedup.
- D-72: default 50, max 200.
- Note: this tool DOES return raw text. That's by design — the LLM operator may need to read the conversation to formulate a response. The GDPR rule (D-62) applies only to OUTBOUND webhook payloads (no message body leaves Kebab via webhook), NOT to MCP tool responses (operator initiated the request).

---

### NEW: `src/connectors/unipile/tools/whatsapp-list-contacts.ts` (tool handler — read + client-side filter)

**Analog:** `src/connectors/unipile/tools/linkedin-list-pending.ts` (read + client-side filter — `older_than_days` filter is the model for `query` substring filter)

**Schema pattern**:
```typescript
export const whatsappListContactsSchema = {
  account_id: z.string().optional(),
  query: z.string().optional().describe("Optional substring filter on contact name (case-insensitive, client-side)."),
  limit: z.number().int().positive().max(500).default(100),
};
```

**Handler skeleton** (uses `messaging.getAllAttendees` SDK method):
```typescript
export async function handleWhatsappListContacts(args: ListContactsArgs): Promise<ToolResult> {
  const acct = await resolveWhatsappAccount(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) return envelope({ items: [], count: 0, error: acct.error });

  // Iterate pages similar to linkedin-list-pending.ts:520-531
  const allAttendees: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  const limit = Math.min(args.limit ?? 100, 500);
  do {
    const resp = await withRetry(() =>
      getUnipileClient().messaging.getAllAttendees({
        account_id: acct.accountId,
        limit: Math.min(limit - allAttendees.length, 100),
        ...(cursor ? { cursor } : {}),
      })
    );
    allAttendees.push(...((resp as { items?: Array<Record<string, unknown>> }).items ?? []));
    cursor = (resp as { cursor?: string | null }).cursor ?? null;
  } while (cursor && allAttendees.length < limit);

  const items = allAttendees
    .filter(a => (a as { type?: string }).type === "WHATSAPP" || true) // WhatsApp-only filter if API mixes
    .map(a => {
      const specifics = (a as { specifics?: { phone_number?: string } }).specifics ?? {};
      const phone = specifics.phone_number === "hidden" ? null : (specifics.phone_number ?? null);
      return {
        contact_id: a.id ?? null,
        name: a.name ?? null,
        phone_e164: phone, // Pitfall 8: WhatsApp returns "hidden" for privacy — map to null
        has_chat: Boolean(a.chat_id),
      };
    })
    .filter(c => !args.query || (c.name && c.name.toLowerCase().includes(args.query.toLowerCase())));

  return envelope({ items, count: items.length });
}
```

**Deviation notes:**
- **D-73 envelope:** `{contact_id, name, phone_e164, has_chat}`.
- **Pitfall 8:** WhatsApp privacy — `phone_number === "hidden"` MUST map to `null` (don't leak the literal "hidden" string).
- `query` filter is client-side (substring, case-insensitive). Unipile API doesn't support server-side search.
- No rate-limit, no audit, no dedup.

---

### NEW: `scripts/setup-unipile-webhooks.ts` (script — one-shot subscription bootstrap)

**Analog:** `scripts/check-doc-counts.ts` (CLI shape — `npx tsx scripts/X.ts` entry point) + RESEARCH §1 lines 894-940 verbatim body (the 3 webhook creation calls)

**CLI scaffold pattern** (mirrors `check-doc-counts.ts` invocation style):
```typescript
#!/usr/bin/env tsx
/**
 * One-shot script to create the 3 Unipile webhook subscriptions per tenant.
 * Idempotent: skips creation if a webhook with the same name already exists.
 *
 * Usage: npx tsx scripts/setup-unipile-webhooks.ts [--dry-run]
 *
 * Reads:
 *  - UNIPILE_DSN, UNIPILE_TOKEN (current tenant credentials)
 *  - VERCEL_URL (or override with --url)
 *  - UNIPILE_WEBHOOK_SECRET (used as Unipile-Auth header value)
 */

import { UnipileClient } from "unipile-node-sdk";

async function main(): Promise<void> {
  const dsn = process.env.UNIPILE_DSN!;
  const token = process.env.UNIPILE_TOKEN!;
  const webhookSecret = process.env.UNIPILE_WEBHOOK_SECRET!;
  const baseUrl = process.env.VERCEL_URL ?? "http://localhost:3000";
  const requestUrl = `${baseUrl}/api/unipile/webhook`;
  const client = new UnipileClient(`https://${dsn}`, token);

  // List existing webhooks to detect duplicates
  const existing = await client.webhook.getAll();
  const existingNames = new Set(((existing as { items?: Array<{ name?: string }> }).items ?? []).map(w => w.name));

  // 1. messaging webhook (typed SDK path)
  if (!existingNames.has("kebab-messaging")) {
    await client.webhook.create({
      source: "messaging",
      request_url: requestUrl,
      name: "kebab-messaging",
      headers: [{ key: "Unipile-Auth", value: webhookSecret }],
    });
  }

  // 2. account_status webhook (typed SDK path)
  if (!existingNames.has("kebab-account-status")) {
    await client.webhook.create({
      source: "account_status",
      request_url: requestUrl,
      name: "kebab-account-status",
      headers: [{ key: "Unipile-Auth", value: webhookSecret }],
    });
  }

  // 3. new_relation webhook (D-79 ESCAPE HATCH — SDK schema rejects source: "users")
  if (!existingNames.has("kebab-new-relation")) {
    await client.request.send({
      path: ["webhooks"],
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        source: "users",
        request_url: requestUrl,
        name: "kebab-new-relation",
        headers: [{ key: "Unipile-Auth", value: webhookSecret }],
      },
    });
  }

  console.log(`Setup complete. 3 webhooks at ${requestUrl}.`);
}

main().catch(err => { console.error("setup failed:", err); process.exit(1); });
```

**Deviation notes:**
- **D-79 critical:** `new_relation` uses the SDK escape hatch (`client.request.send({path: ['webhooks'], ...})`) because `WebhookCreateBodySchema` doesn't include the `users` literal source. Verified by reading `node_modules/unipile-node-sdk/dist/types/webhooks/webhooks-create.types.d.ts`.
- **D-85 carve-out:** `POST /api/v1/webhooks/<id>/test` doesn't exist (returns 404). Bootstrap script does NOT call it; it just creates the 3 subscriptions and exits.
- **Idempotent:** uses `client.webhook.getAll()` + name match before creating. Safe to re-run.
- **`process.env` direct read is OK here** (it's a Node script, NOT the app code path subject to the `kebab/no-direct-process-env` lint rule). The lint rule excludes `scripts/`.
- **Per-tenant orchestration:** the script runs ONCE per tenant (operator sets env vars before invoking, OR adds a `--tenant <id>` flag and resolves tenant-specific credentials internally).

---

### REPLACED: `src/connectors/unipile/lib/crm-bridge.ts` (TwentyAdapterSkeleton → real TwentyAdapter)

**Analog:** the file itself (phase 68 — keep skeleton exports per D-67 backward compat) + RESEARCH §1 Pattern 4 verbatim implementation (lines 319-382)

**Imports pattern** (extend the existing file's imports):
```typescript
import { createHmac } from "node:crypto"; // NEW — for HMAC signing
import { getConfig } from "@/core/config-facade"; // NEW — for per-tenant URL/secret reads
import { getContextKVStore } from "@/core/request-context"; // existing
import { getLogger } from "@/core/logging"; // NEW
import { toMsg } from "@/core/error-utils"; // NEW

const log = getLogger("CONNECTOR:unipile");
```

**Interface extension** (extend `CrmAdapter` interface at line 90 with `notifyEvent`):
```typescript
export interface CrmAdapter {
  // Phase 68 — write the outbox row (unchanged signature)
  writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void>;
  // Phase 70 NEW — flush a specific event to the CRM webhook
  notifyEvent(args: {
    event_type: string;
    payload: Record<string, unknown>;
    tenant_id: string;
  }): Promise<{ ok: boolean; status?: number; error?: string }>;
}
```

**Full TwentyAdapter implementation** (RESEARCH §1 Pattern 4 verbatim, lines 330-382 — ship as-is):
```typescript
export class TwentyAdapter implements CrmAdapter {
  // Phase 68 — outbox write (same as skeleton)
  async writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void> {
    const row: CrmOutboxRow = {
      audit_id: auditId, status: "pending",
      crm_log: payload.crm_log, queued_at: new Date().toISOString(),
    };
    await getContextKVStore().set(`unipile:outbox:${auditId}`, JSON.stringify(row));
  }

  // Phase 70 NEW — real HTTP POST with HMAC (Twenty's signature scheme)
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
          "X-Kebab-Signature": signature, // also send Kebab-flavored header
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

**Backward-compat deprecation** (D-67 — keep `TwentyAdapterSkeleton` as alias):
```typescript
/**
 * @deprecated Phase 68 skeleton. Phase 70 replaced with real `TwentyAdapter`.
 * Kept exported for backward compat with any consumer that imported the name.
 * New code should use `TwentyAdapter` directly.
 */
export const TwentyAdapterSkeleton = TwentyAdapter;

// Singleton — re-point to the real adapter (transparent upgrade for crm-bridge.ts consumers)
export const crmBridge: CrmAdapter = new TwentyAdapter();
```

**Deviation notes:**
- **D-64 + D-67:** `TwentyAdapterSkeleton` is a NAMED export alias for `TwentyAdapter` — any phase 68/69 import like `import { TwentyAdapterSkeleton } from "..."` continues to resolve (now to the real adapter, transparently). Tests using the skeleton's source-code static check (crm-bridge.test.ts asserts NO `fetch(`, NO `createHmac`) MUST be updated/removed in this phase.
- **Phase 68 static guard test removal:** `crm-bridge.test.ts` (existing) has tests asserting NO `fetch(` and NO `createHmac` calls. Plan must REMOVE those assertions (they're inverted by D-64).
- **D-04 backoff lives in the cron** (route file above), NOT here. This adapter is a pure side-effect-on-call — caller decides retry semantics.
- **Twenty `X-Twenty-Webhook-Signature` + Kebab-flavored `X-Kebab-Signature` both sent** (RESEARCH A1 mitigation — Twenty install verifies one, non-Twenty CRMs can verify either way).
- **Twenty scheme is `${timestamp}:${body}`** (NOT just body) — distinct from Unipile's `body`-only HMAC. Source: docs.twenty.com per RESEARCH §Sources.

---

### MODIFIED: `src/connectors/unipile/lib/rate-limiter.ts` (extend tool union with `whatsapp_send`)

**Analog:** the file itself — surgical extend of `UnipileRateLimitedTool` (line 68) and `getCaps` switch (lines 87-105)

**Surgical change 1 — extend type union** (rate-limiter.ts:68):
```typescript
// BEFORE:
export type UnipileRateLimitedTool = "send_connection" | "send_message" | "send_inmail";

// AFTER (D-68):
export type UnipileRateLimitedTool = "send_connection" | "send_message" | "send_inmail" | "whatsapp_send";
```

**Surgical change 2 — add `whatsapp_send` case to `getCaps`** (rate-limiter.ts:87-105 — append after `send_inmail`):
```typescript
case "whatsapp_send":
  return {
    daily: getConfigInt("KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP", 200),
    weekly: null, // no weekly cap for WhatsApp (D-68)
  };
```

**Deviation notes:**
- D-68: default cap is 200/day (much higher than LinkedIn — WhatsApp is friend-to-friend; rate-limit risk is much lower than LinkedIn cold outreach). No weekly cap.
- Env var name: `KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP` (follows the `KEBAB_UNIPILE_LINKEDIN_*_CAP` convention).
- Read tools (`whatsapp_list_chats`, `whatsapp_get_conversation`, `whatsapp_list_contacts`) NOT rate-limited (idempotent reads).
- Tests: add 1 new describe block — `checkUnipileRateLimit({tool: "whatsapp_send"})` with default cap, env override, and blocked-at-201 cases.

---

### MODIFIED: `src/connectors/unipile/tools/linkedin-send-connection.ts` (and `linkedin-send-message.ts`, `linkedin-send-inmail.ts`, `linkedin-engage.ts`) — retrofit halt-check pre-flight

**Analog:** each file itself — surgical INSERT of Step 0 (halt-flag check) BEFORE Step 1 (dedup)

**Surgical change** (for `linkedin-send-message.ts`, insert before line 257 `// ═══════ Step 1: DEDUP`):
```typescript
// ═══════ Step 0 (NEW Phase 70 D-75): HALT-FLAG PRE-FLIGHT — highest priority ═══════
// Block writes against halted accounts (set by account_status webhook handler).
// MUST run BEFORE dedup, BEFORE rate-limit — halted account = 100% wasted call.
// Note: if account_id not in args, halt check is deferred to after step 2 (account resolve).
if (args.account_id) {
  const halt = await readHaltFlag(args.account_id);
  if (halt) {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_message",
      account_id: args.account_id,
      params_hash: "halted",
      result: "error_account_halted",
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: "error_account_halted",
      halt_reason: halt.reason,
      halted_at: halt.halted_at,
    });
  }
}
```

**Imports added** (top of each file):
```typescript
import { readHaltFlag } from "../webhook/halt-flag";
```

**Second halt-check after step 2 (account-resolve) — when account_id was inferred**:
```typescript
// After acct.accountId is resolved (post step 2):
if (!args.account_id) {
  const halt = await readHaltFlag(acct.accountId);
  if (halt) { /* same halt envelope */ }
}
```

**Audit enum extension** (`src/connectors/unipile/lib/audit.ts` — D-75 adds 1 new member):
```typescript
export type AuditResult =
  // ... phase 68/69 members ...
  | "error_account_halted"; // NEW Phase 70 D-75
```

**Deviation notes:**
- **D-75 ordering:** halt-check is HIGHEST priority — BEFORE D-49's dedup-first ordering. Tests must verify dedup is NOT called when halt fires.
- **Single halt-noted audit row** (per CONTEXT line 78): one row with `result: "error_account_halted"`, then early return. NOT a full audit row chain.
- **4 files retrofit:** send-connection, send-message, send-inmail, engage. The `engage` super-tool may delegate to one of the others — verify the inner handler ALSO has its own halt-check (it already will, post-retrofit). Acceptable to have 2 halt checks fire (idempotent KV read).
- **Halt-check ON READ tools (get-relationship-status, list-pending):** NOT required per D-75 (D-75 says "all write tools"). Read tools are safe regardless of halt state — but the read might fail at Unipile if the account is truly disconnected. Skipping the read-tool halt-check is intentional (D-75 scope).

---

### MODIFIED: `src/connectors/unipile/manifest.ts` (add 4 WhatsApp tools)

**Analog:** the file itself — `buildTools()` function (lines 157-228) — append 4 new `defineTool({})` entries

**Surgical change — extend imports** (lines 6-23, after the existing tool imports):
```typescript
import { whatsappSendMessageSchema, handleWhatsappSendMessage } from "./tools/whatsapp-send-message";
import { whatsappListChatsSchema, handleWhatsappListChats } from "./tools/whatsapp-list-chats";
import { whatsappGetConversationSchema, handleWhatsappGetConversation } from "./tools/whatsapp-get-conversation";
import { whatsappListContactsSchema, handleWhatsappListContacts } from "./tools/whatsapp-list-contacts";
```

**Surgical change — extend `buildTools()` return array** (after the existing 6 entries, before the closing `]` at line 227):
```typescript
defineTool({
  name: "whatsapp_send_message",
  description:
    "Send a WhatsApp message (1-to-1). Accepts E.164 phone (auto-resolved to attendee) " +
    "OR existing chat_id. Attachments supported (PDF/PNG/JPEG/GIF, ≤15MB, ≤5 files). " +
    "Default cap 200/day per account.",
  schema: whatsappSendMessageSchema,
  handler: async (args) =>
    handleWhatsappSendMessage(args as Parameters<typeof handleWhatsappSendMessage>[0]),
  destructive: true,
}),
defineTool({
  name: "whatsapp_list_chats",
  description:
    "List WhatsApp chats for the account, sorted by most-recent activity. " +
    "Default limit 20, max 100. Returns {items, count, cursor}.",
  schema: whatsappListChatsSchema,
  handler: async (args) =>
    handleWhatsappListChats(args as Parameters<typeof handleWhatsappListChats>[0]),
  destructive: false,
}),
defineTool({
  name: "whatsapp_get_conversation",
  description:
    "Read messages from a WhatsApp chat by chat_id. Default limit 50, max 200. " +
    "Returns full message text + attachments + timestamps.",
  schema: whatsappGetConversationSchema,
  handler: async (args) =>
    handleWhatsappGetConversation(args as Parameters<typeof handleWhatsappGetConversation>[0]),
  destructive: false,
}),
defineTool({
  name: "whatsapp_list_contacts",
  description:
    "List WhatsApp contacts. Phone number returned as null when WhatsApp hides it (privacy). " +
    "Optional query substring filter (case-insensitive). Returns {contact_id, name, phone_e164, has_chat}.",
  schema: whatsappListContactsSchema,
  handler: async (args) =>
    handleWhatsappListContacts(args as Parameters<typeof handleWhatsappListContacts>[0]),
  destructive: false,
}),
```

**Manifest doc update** (line 132 — phase 69 description "Phase 69 complete: 6 tools..."):
- Update to "Phase 70 complete: 10 tools (4 LinkedIn writes + 2 LinkedIn reads + 1 WhatsApp write + 3 WhatsApp reads)."

**Deviation notes:**
- 3 of 4 WhatsApp tools are `destructive: false` (reads). Only `whatsapp_send_message` is `destructive: true`.
- `manifest.test.ts` (existing) needs new assertions: 10 tools total, all 4 WhatsApp names present, exactly 1 WhatsApp tool destructive.

---

### MODIFIED: `src/core/registry.ts` (toolCount 6 → 10)

**Analog:** registry.ts:168 — one-line change

**Surgical change** (line 168):
```typescript
// BEFORE:
toolCount: 6,
// AFTER (Phase 70):
toolCount: 10, // Phase 70: +4 WhatsApp tools (send_message + 3 reads)
```

**Deviation notes:**
- `tests/contract/registry-metadata-consistency.test.ts` asserts `toolCount === manifest.tools.length`. The change above + the manifest change above must land in the same commit.

---

### MODIFIED: `tests/contract/kv-allowlist.test.ts` (add 2 root-scope route allowlist entries)

**Analog:** the file itself — `ALLOWLIST` Set at lines 34-105 (model existing entry at line 80 for `app/api/admin/unipile/cache/urn/route.ts`)

**Surgical change — add 2 new entries** (insert after the existing unipile DELETE entry on line 80, preserving alphabetical-ish grouping):
```typescript
  // Phase 70 / D-81 + Pitfall 1: webhook ingress has NO tenant context at
  // request time. Idempotency key `unipile:webhook:event:<id>` MUST be
  // root-scoped (cross-tenant unique by message_id), and the tenant routing
  // happens INSIDE the handler via the `unipile:account-tenant:<account_id>`
  // reverse index lookup. Mirrors the rationale of admin/unipile/cache/urn.
  "app/api/unipile/webhook/route.ts",

  // Phase 70 / D-80: cron route scans ALL tenants' outbox rows in one shot
  // via `kv.list("tenant:")` + suffix filter. Root-scope by necessity.
  "app/api/cron/unipile-crm-retry/route.ts",
```

**Deviation notes:**
- These are the SECOND and THIRD unipile-related root-scope exemptions (the first being `cache/urn` in phase 68). The pattern is: any code path that legitimately needs to act across tenants must be explicitly allowlisted here.
- The `dispatcher.ts` `resolveTenantFromAccountId` helper ALSO uses `getKVStore()` (root scope to read the account-tenant index). It's NOT under `src/` or `app/` actually — it IS under `src/connectors/unipile/webhook/dispatcher.ts`. **NEEDS an allowlist entry too:** add `"src/connectors/unipile/webhook/dispatcher.ts"` to the Set. Triple-check the path in the test file's scanner walk.

**REVISED — add a 3rd entry:**
```typescript
  // Phase 70 / D-81: dispatcher reads the root-scope reverse index
  // `unipile:account-tenant:<account_id>` to route webhook payloads to the
  // correct tenant context BEFORE invoking tenant-scoped handlers.
  "src/connectors/unipile/webhook/dispatcher.ts",
```

---

### MODIFIED: `vercel.json` (register cron schedule)

**Analog:** vercel.json itself — `crons` array

**Surgical change — append to `crons` array**:
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

**Deviation notes:**
- **D-66 schedule:** `*/2 * * * *` (every 2 minutes). Per A7 (Assumptions Log) — Vercel Hobby tier limits cron to once-per-day; Pro+ supports per-minute. Verify deployment plan tier in execute phase. Fallback to `*/5` or hourly is trivial.

---

### MODIFIED: `content/docs/connectors.md` + `README.md` (tool count 97 → 101)

**Analog:** these files themselves — text edits per `scripts/check-doc-counts.ts` drift gate

**Surgical change** — bump counts in:
- `README.md` — claims about "N tools" (search for `\d+ tools` strings)
- `content/docs/connectors.md` — unipile section, currently "Provides 6 tools" → "Provides 10 tools" + bullet list extension

**Deviation notes:**
- Run `npx tsx scripts/check-doc-counts.ts` after the manifest change to enumerate drift sites. Phase 69 PATTERNS documented the same approach (phase 69 went 93→97; phase 70 goes 97→101 because +4 WhatsApp tools, no removals).
- Update unipile bullet list in `connectors.md` to enumerate the 4 new WhatsApp tool names.

---

## Shared Patterns

### Halt-flag pre-flight (D-75)
**Source:** `src/connectors/unipile/webhook/halt-flag.ts` (NEW)
**Apply to:** ALL write tools — LinkedIn (4: send_connection, send_message, send_inmail, engage) + WhatsApp (1: send_message)
**Pattern:**
```typescript
import { readHaltFlag } from "../webhook/halt-flag";

// Step 0 — BEFORE dedup, BEFORE rate-limit:
if (args.account_id) {
  const halt = await readHaltFlag(args.account_id);
  if (halt) {
    await writeAuditRow({ /* result: "error_account_halted" */ });
    return envelope({ error: "error_account_halted", halt_reason: halt.reason, halted_at: halt.halted_at });
  }
}
```
**Tests for each retrofitted tool:** assert dedup + rate-limit are NOT called when halt fires (`vi.fn()` spies on `checkDedup`, `checkUnipileRateLimit`).

### Tenant routing from webhook payload (D-81)
**Source:** `src/connectors/unipile/webhook/dispatcher.ts` `resolveTenantFromAccountId` (NEW)
**Apply to:** Every webhook handler (`account-status.ts`, `new-relation.ts`, `new-message.ts`)
**Pattern:**
```typescript
const tenantId = await resolveTenantFromAccountId(payload.account_id);
if (!tenantId) { log.warn("no tenant mapping"); return; }
await runWithTenant(tenantId, async () => {
  // tenant-scoped KV writes inside this block
});
```
**Failure mode:** silent log + drop (NOT an error response — the webhook already returned 200 synchronously). Operator sees the warn in logs.

### Pipeline composition for webhook + cron (existing pattern, applied to NEW routes)
**Source:** `app/api/webhook/[name]/route.ts:139-146` + `app/api/cron/update-check/route.ts:99-107`
**Apply to:** `app/api/unipile/webhook/route.ts`, `app/api/cron/unipile-crm-retry/route.ts`
**Pattern:**
```typescript
export const POST = composeRequestPipeline(
  [rehydrateStep, bodyParseStep({ maxBytes: MAX_PAYLOAD_BYTES })],
  webhookHandler
);
// OR (cron):
export const GET = composeRequestPipeline(
  [rehydrateStep, authStep("cron"), rateLimitStep({...}), hydrateCredentialsStep],
  cronHandler
);
```

### KV-allowlist root-scope exemption documentation
**Source:** `tests/contract/kv-allowlist.test.ts:34-105` + the existing line 80 (`app/api/admin/unipile/cache/urn/route.ts`)
**Apply to:** every NEW file in this phase that calls `getKVStore()` directly:
- `app/api/unipile/webhook/route.ts` (idempotency keys)
- `app/api/cron/unipile-crm-retry/route.ts` (cross-tenant scan)
- `src/connectors/unipile/webhook/dispatcher.ts` (account-tenant reverse index)
**Pattern:** every entry must include a comment explaining WHY root scope is necessary (mirroring the existing entry's voice).

### Logger tags
**Source:** existing `getLogger("CONNECTOR:unipile")` for tool handlers + `cron.update-check` for cron handlers
**Apply to:**
- Tool handlers: `getLogger("CONNECTOR:unipile")` (same as phase 68/69)
- Webhook route + dispatcher + handlers: `getLogger("CONNECTOR:unipile-webhook")` (NEW sub-tag for log-filter cleanliness)
- Cron: `getLogger("cron.unipile-crm-retry")` (matches `cron.health`, `cron.update-check`)

### Credential reads (NEVER process.env)
**Source:** `src/core/config-facade.ts` (getConfig); enforced by ESLint rule `kebab/no-direct-process-env`
**Apply to:** All new env vars in this phase:
- `UNIPILE_WEBHOOK_SECRET`
- `UNIPILE_CRM_WEBHOOK_URL_<TENANT_ID>` (per-tenant)
- `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (per-tenant)
- `KEBAB_UNIPILE_NOTIFY_WEBHOOK_URL` (optional)
- `KEBAB_UNIPILE_INBOUND_NOTIFY` (optional, default false)
- `KEBAB_UNIPILE_WHATSAPP_DAILY_SEND_CAP` (optional, default 200)
**Pattern:** `import { getConfig } from "@/core/config-facade"; const secret = getConfig("UNIPILE_WEBHOOK_SECRET");`
**Script exception:** `scripts/setup-unipile-webhooks.ts` may use `process.env` directly (scripts/ is excluded from the lint rule).

### Fire-and-forget async dispatch (D-55)
**Source:** existing webhook receiver pattern at `src/connectors/webhook/route.ts:131-136` (returns 200 immediately after KV write)
**Apply to:** the NEW webhook route (`app/api/unipile/webhook/route.ts`) after the dedup write
**Pattern:**
```typescript
void asyncFn(payload).catch(err => log.error("dispatch failed", { error: toMsg(err) }));
return new Response(JSON.stringify({ ok: true }), { status: 200 });
```
**Anti-pattern (Pitfall):** `await asyncFn(payload)` blocks the response → 30s timeout risk + Unipile retries.

### Tenant-scoped KV access (carry-over from phase 68)
**Source:** `src/core/request-context.ts:72-74` `getContextKVStore()`
**Apply to:** ALL handler bodies (account-status, new-relation, new-message) wrapped in `runWithTenant(tenantId, async () => {...})`. All WhatsApp tool handlers (already follow phase 68/69 convention).
**Exception:** webhook idempotency keys + outbox scan in cron + tenant reverse index use `getKVStore()` (root scope, allowlisted).

---

## No Analog Found

| File | Role | Data Flow | Reason | Source to lift from |
|------|------|-----------|--------|---------------------|
| `src/connectors/unipile/webhook/dispatcher.ts` | event router | event-driven switch | No in-repo event-dispatcher exists — closest is the manifest's `defineTool` tools array which is a static registration, not a runtime router | RESEARCH.md §1 Code Example B (lines 647-677) — ship verbatim |
| `src/connectors/unipile/webhook/handlers/*` | per-event handlers | event-driven side-effects | No in-repo handler-with-side-effects pattern exists for webhook-arriving events (the existing `src/connectors/webhook/route.ts` is store-and-forward only, not typed handlers) | RESEARCH.md §1 + per-handler design notes above (build per D-56/D-59/D-61 spec) |
| The 3 webhook handlers all need a "find audit row by recipient_provider_id" lookup | secondary-index reverse lookup | KV scan + filter | No in-repo secondary-index-by-non-primary-field exists for the audit log (phase 68 only indexed by `params_hash`) | Recommend deferring: ship without lookup (Option 3 in `new-relation.ts` Deviation notes) — phase 71 add if CRM dashboard needs the audit_id correlation |

---

## Misalignments / Risks Flagged for Planner

| # | Misalignment | Affected Files | Resolution |
|---|--------------|----------------|------------|
| M1 | RESEARCH A2 (Vercel keeps lambda alive ~30s post-response) is ASSUMED, not verified. If wrong, fire-and-forget handlers die mid-CRM-POST | `app/api/unipile/webhook/route.ts` + handlers | D-84 safety net: outbox `sending` rows older than 5min get re-picked by cron. Plan must include the `sending` intermediate state. |
| M2 | RESEARCH A7 — Vercel cron `*/2 * * * *` requires Pro+ tier (Hobby = once/day) | `vercel.json` | Confirm tier during execute. Fallback `*/5` or hourly. |
| M3 | RESEARCH A8 — `kv.list("unipile:outbox:")` misses tenant-prefixed keys | `app/api/cron/unipile-crm-retry/route.ts` | D-80 fix: scan with `kv.list("tenant:")` + suffix filter. Tests MUST cover multi-tenant case. |
| M4 | RESEARCH A4 — `account_status` payload shape INFERRED, not live-verified | `handlers/account-status.ts` + dispatcher | Integration test with documented shape; live verification in execute phase by toggling LinkedIn account in Unipile dashboard. |
| M5 | Phase 68 `crm-bridge.test.ts` has static assertions `NO fetch(`, `NO createHmac` — inverted by D-64 | `crm-bridge.test.ts` (existing) | Plan must REMOVE those assertions. NEW tests verify the real adapter's HTTP path. |
| M6 | The "find audit row by recipient_provider_id" lookup (D-59 step 1) has NO existing secondary index | `handlers/new-relation.ts` | Recommend Option 3 (skip lookup, always D-60 fallback) for phase 70. Add secondary-index backlog ticket. |
| M7 | `scripts/setup-unipile-webhooks.ts` per-tenant orchestration ambiguous — runs once OR loops tenants | `scripts/setup-unipile-webhooks.ts` | Recommend once-per-invocation (operator sets env vars per tenant before invoking). `--tenant <id>` flag is phase 71. |
| M8 | `linkedin-engage` retrofit halt-check — engage delegates to send_message/send_connection/send_inmail which ALSO halt-check. Double-check fires (acceptable, but flag) | `tools/linkedin-engage.ts` | Inner halt-check is idempotent KV read. Acceptable double-fire. Tests should not assert single-call. |
| M9 | `bodyParseStep` behavior on Content-Type `application/x-www-form-urlencoded` with JSON body (Pitfall 6 / D-82) | `app/api/unipile/webhook/route.ts` | Verify in test using a captured live Unipile payload. If bodyParseStep URL-decodes ahead of JSON, override to read raw body via `ctx.request.text()`. |

---

## Metadata

**Analog search scope:**
- `src/connectors/webhook/route.ts` — HMAC + pipeline + KV write (primary analog for the new ingress route)
- `src/connectors/unipile/**` — phase 68/69 tools + libs (primary analog for WhatsApp tools, halt-flag, retrofit pattern)
- `src/connectors/unipile/lib/crm-bridge.ts` — phase 68 skeleton to replace (D-67 backward compat)
- `src/connectors/unipile/lib/rate-limiter.ts` — extend tool union
- `src/connectors/unipile/lib/account.ts` — extend with WhatsApp type filter
- `src/connectors/unipile/lib/audit.ts` + `lib/errors.ts` — extend enums with `error_account_halted`
- `app/api/cron/update-check/route.ts` — cron pipeline shape (analog for retry cron)
- `app/api/webhook/[name]/route.ts` — webhook pipeline shape + HMAC + body-reserialization idiom
- `app/api/admin/unipile/cache/urn/route.ts` — root-scope getKVStore() escape hatch (precedent for 3 new allowlist entries)
- `tests/contract/kv-allowlist.test.ts` — extend ALLOWLIST Set with 3 new entries (webhook route, cron route, dispatcher)
- `vercel.json` — cron registration (one-line extension)
- `src/core/registry.ts` — toolCount 6 → 10
- `scripts/check-doc-counts.ts` — drift gate scope (verify after manifest change)

**Files scanned:** 13 source files + 1 contract test + 2 config files + RESEARCH.md (verified all 8 code examples + 8 pitfalls + assumptions log)

**Pattern extraction date:** 2026-05-18

---

## PATTERN MAPPING COMPLETE
