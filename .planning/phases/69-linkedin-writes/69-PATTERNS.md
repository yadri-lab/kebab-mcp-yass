# Phase 69: LinkedIn Writes Completion — Pattern Map

**Mapped:** 2026-05-18
**Files analyzed:** 14 (5 NEW + 9 MODIFIED, including 2 doc files)
**Analogs found:** 14 / 14 — ALL files have a strong phase 68 analogue (rate-limiter has a partial analogue in `src/core/rate-limit.ts`)

**Key insight:** Phase 69 is overwhelmingly an EXTENSION of phase 68. Every NEW tool handler can lift the 8-step structure from `linkedin-send-connection.ts`. Every MODIFIED file is a surgical add (new enum member, new regex group, new defineTool entry). The only fully novel design is the **per-account day/week rate-limiter** — and even that lifts the atomic KV `incr` pattern from `src/core/rate-limit.ts`.

---

## File Classification

| New/Modified | File | Role | Data Flow | Closest Analog | Match Quality |
|--------------|------|------|-----------|----------------|---------------|
| NEW | `src/connectors/unipile/lib/rate-limiter.ts` | utility (per-account caps, fail-closed) | KV transform | `src/core/rate-limit.ts` (per-IP atomic incr) | partial — different windowing, similar KV idiom |
| NEW | `src/connectors/unipile/tools/linkedin-send-message.ts` | tool handler (destructive write) | request-response + 2-poll verify | `tools/linkedin-send-connection.ts` (8-step handler) | exact |
| NEW | `src/connectors/unipile/tools/linkedin-send-inmail.ts` | tool handler (destructive write) | request-response + bracket-call (balance before/after) | `tools/linkedin-send-connection.ts` + escape hatch `client.request.send()` | exact-on-handler-shape |
| NEW | `src/connectors/unipile/tools/linkedin-engage.ts` | tool handler (super-tool, dispatcher) | branched-dispatch with dry_run | `tools/linkedin-send-connection.ts` (envelope shape) + `linkedin-get-relationship-status.ts` (degree mapping) | composite |
| NEW | `src/connectors/unipile/tools/linkedin-list-pending.ts` | tool handler (read, paginated) | request-response | `tools/linkedin-get-relationship-status.ts` (read tool envelope) | exact |
| MOD | `src/connectors/unipile/lib/errors.ts` | utility (typed errors + classifier) | n/a | the file itself (phase 68) — add 5 new classes + 3 new enum members | exact (surgical extend) |
| MOD | `src/connectors/unipile/lib/audit.ts` | library (audit log + dedup) | n/a | the file itself (phase 68) — extend `AuditResult` enum with 7 new members | exact (surgical extend) |
| MOD | `src/connectors/unipile/lib/identifiers.ts` | library (URL → URN resolver) | n/a | the file itself (phase 68) — extend SLUG_RE regex per D-44 | exact (surgical extend) |
| MOD | `src/connectors/unipile/tools/linkedin-send-connection.ts` | tool handler (retrofit) | request-response | the file itself (phase 68) — insert `rateLimiter.check()` after dedup, before account resolve | exact (surgical insert) |
| MOD | `src/connectors/unipile/manifest.ts` | manifest | static | the file itself — add 4 new `defineTool({})` entries to `buildTools()` | exact (surgical extend) |
| MOD | `src/core/registry.ts` | registry (lazy loader catalog) | n/a | line 168 unipile entry — change `toolCount: 2 → 6` | exact (one-line change) |
| MOD | `content/docs/connectors.md` | docs (connector catalog) | n/a | lines 64-67 unipile section — update "Provides 2 tools" → "Provides 6 tools" + bullet list | exact (text edit) |
| MOD | `README.md` | docs | n/a | lines 3, 52, 65, 72 — bump "93+" tool count claim (drift-gate scope) | exact (text edit) |
| NEW | `src/connectors/unipile/lib/__tests__/rate-limiter.test.ts` + 4 tool test files | tests (vitest, KV-mocked) | n/a | `lib/__tests__/identifiers.test.ts` + `tools/__tests__/linkedin-send-connection.test.ts` | exact |

---

## Pattern Assignments

### NEW: `src/connectors/unipile/lib/rate-limiter.ts` (utility — per-account caps, fail-closed)

**Analog:** `src/core/rate-limit.ts` (partial — per-IP per-minute; phase 69 needs per-account per-day + per-week)

**Imports pattern** (rate-limit.ts:1-6 — adapt for connector colocation):
```typescript
import { getContextKVStore } from "@/core/request-context";
import { getConfigInt, getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");
```

**Atomic KV incr pattern** (rate-limit.ts:131-146 — lift verbatim, swap windowing):
```typescript
if (typeof kv.incr === "function") {
  const count = await kv.incr(key, { ttlSeconds: 36 * 3600 }); // 36h for daily; 9d for weekly
  if (count > limit) {
    return { blocked: true, daily_used: count, daily_limit: limit, retry_after: nextResetIso };
  }
  return { blocked: false, daily_used: count, daily_limit: limit };
}
```

**Fail-closed pattern** (D-40 + research §4.4 — INVERSE of rate-limit.ts:167-171 which fails OPEN):
```typescript
} catch (err) {
  log.warn("Rate-limiter KV failure", { account_id, tool, err: toMsg(err) });
  const failMode = getConfig("KEBAB_UNIPILE_RATELIMIT_FAIL_MODE");
  if (failMode === "open") {
    return { blocked: false, daily_used: 0, daily_limit, reason: "kv_unavailable" };
  }
  // Default: fail CLOSED (D-40 — security-critical cap)
  return {
    blocked: true,
    daily_used: 0,
    daily_limit,
    reason: "kv_unavailable",
    retry_after: new Date(Date.now() + 60_000).toISOString(),
  };
}
```

**Key shape** (D-38; mirrors `unipile:audit:*` / `unipile:urn:*` tenant-prefixed convention):
```typescript
// Daily: unipile:ratelimit:<account_id>:<tool>:<YYYY-MM-DD>:daily
// Weekly: unipile:ratelimit:<account_id>:<tool>:<YYYY-Www>:weekly
// TenantKVStore auto-prefixes to: tenant:<id>:unipile:ratelimit:...
const dailyBucket = new Date().toISOString().slice(0, 10);
const dailyKey = `unipile:ratelimit:${account_id}:${tool}:${dailyBucket}:daily`;
```

**Caps config** (D-39 — use `getConfigInt` with defaults per research §4.2):
```typescript
const CAPS: Record<string, { daily: number; weekly: number | null }> = {
  send_connection: {
    daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP", 25),
    weekly: getConfigInt("KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP", 100),
  },
  send_message: {
    daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP", 50),
    weekly: null,
  },
  send_inmail: {
    daily: getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP", 15),
    weekly: null,
  },
};
```

**API signature** (D-41 — never throws):
```typescript
export interface RateLimitDecision {
  blocked: boolean;
  daily_used: number;
  daily_limit: number;
  weekly_used?: number;
  weekly_limit?: number;
  reason?: "daily_cap" | "weekly_cap" | "kv_unavailable";
  retry_after?: string;  // ISO-8601 timestamp of next reset
}

export async function checkUnipileRateLimit(args: {
  account_id: string;
  tool: "send_connection" | "send_message" | "send_inmail";
}): Promise<RateLimitDecision>;
```

**retry_after computation** (research §4.5):
```typescript
// Daily cap exceeded → next UTC midnight
function nextUtcMidnight(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}
// Weekly cap exceeded → next Monday 00:00 UTC
```

**Deviation notes:**
- DO NOT inherit `src/core/rate-limit.ts`'s `KEBAB_RATE_LIMIT_INMEMORY` opt-in path — phase 69's rate-limiter is per-account/per-tool, not per-IP, and the in-memory escape hatch doesn't make sense for production-only quotas.
- DO NOT inherit the legacy `dualReadKV` migration shim — this is greenfield, no v0.11 keys to read.
- DO NOT inherit `sweepOldBuckets()` — daily/weekly keys have natural TTL (36h / 9d) which Upstash respects natively.
- Logger tag: `CONNECTOR:unipile` (mirrors `lib/client.ts`, `lib/identifiers.ts`).
- DO NOT use raw `getKVStore()` — always `getContextKVStore()` (D-18, same as audit/identifiers).

---

### NEW: `src/connectors/unipile/tools/linkedin-send-message.ts` (tool handler — destructive write)

**Analog:** `src/connectors/unipile/tools/linkedin-send-connection.ts` (exact handler shape, swap SDK call + verify mechanism)

**Imports pattern** (send-connection.ts:42-55 — same set, add new errors):
```typescript
import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveProviderId, normalizeProfileUrl } from "../lib/identifiers";
import {
  computeParamsHash,
  checkDedup,
  writeAuditRow,
  generateAuditId,
  type AuditResult,
} from "../lib/audit";
import { crmBridge } from "../lib/crm-bridge";
import { classifyUnipileError } from "../lib/errors";
import { checkUnipileRateLimit } from "../lib/rate-limiter";  // NEW
```

**Schema pattern** (send-connection.ts:57-86 — adapt for message + attachments per D-46):
```typescript
export const linkedinSendMessageSchema = {
  profile_url: z.string().url().describe("Public LinkedIn profile URL of a 1st-degree connection."),
  text: z.string().min(1).max(8000).describe("Message body."),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        mimetype: z.enum(["application/pdf", "image/png", "image/jpeg", "image/gif"]),
        base64: z.string(),
      })
    )
    .max(5)
    .optional()
    .describe("Optional attachments (≤15MB each, ≤5 files). Decoded server-side from base64."),
  account_id: z.string().optional(),
  actor_user_id: z.string(),
  crm_log: z.record(z.string(), z.unknown()).optional(),
};
```

**Handler skeleton — 9-step flow** (lift send-connection.ts:167-334 structure; insert rate-limit + degree-check + attachment-decode):
```typescript
export async function handleLinkedinSendMessage(args: SendMessageArgs): Promise<ToolResult> {
  const auditId = generateAuditId();
  const profileUrlNormalized = (() => {
    try { return normalizeProfileUrl(args.profile_url); }
    catch { return args.profile_url; }
  })();

  // Hash text content (D-25 — text_hash, not raw text)
  const paramsHash = computeParamsHash({
    tool: "linkedin_send_message",
    profile_url_normalized: profileUrlNormalized,
    note: args.text,  // re-use note slot for message body
  });

  // 1. Dedup check FIRST (D-49 — dedup hits don't burn quota)
  const dup = await checkDedup(paramsHash);
  if (dup) { /* same as send-connection.ts:189-209 */ }

  // 2. Account resolution (same as send-connection.ts:212-238)
  const acct = await resolveAccountId(args);
  if ("error" in acct) { /* identical error envelope */ }

  // 3. Rate-limit check (NEW per D-49)
  const rl = await checkUnipileRateLimit({ account_id: acct.accountId, tool: "send_message" });
  if (rl.blocked) {
    await writeAuditRow({
      audit_id: auditId, actor_user_id: args.actor_user_id, tool: "linkedin_send_message",
      account_id: acct.accountId, params_hash: paramsHash,
      result: "error_rate_limit_kebab", verified: false, dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    return envelope({
      provider_ok: false, verified: false, crm_sync: "pending", dedup_hit: false,
      audit_id: auditId, error: "error_rate_limit_kebab",
      blocked_by_rate_limit: true, daily_used: rl.daily_used, daily_limit: rl.daily_limit,
      retry_after: rl.retry_after,
    });
  }

  // 4. Validate attachments (D-23 — 15MB cap server-side)
  let attachmentTuples: Array<[string, Buffer]> | undefined;
  if (args.attachments?.length) {
    attachmentTuples = args.attachments.map(a => {
      const buf = Buffer.from(a.base64, "base64");
      if (buf.byteLength > 15 * 1024 * 1024) {
        throw new UnipileAttachmentTooLargeError(`Attachment ${a.filename} exceeds 15MB`, buf.byteLength);
      }
      return [a.filename, buf] as [string, Buffer];
    });
  }

  // 5. Resolve provider_id + check degree (D-22)
  const { provider_id } = await resolveProviderId(args.profile_url, acct.accountId);
  const profile = await withRetry(() =>
    getUnipileClient().users.getProfile({ account_id: acct.accountId, identifier: slug })
  );
  const degree = (profile as { network_distance?: string }).network_distance;
  if (degree !== "FIRST_DEGREE") {
    // Pre-flight refusal — does NOT count toward rate limit (research §4.7)
    // Write audit row with result: "error_not_connected", return early
  }

  // 6. CRM outbox + send
  await crmBridge.writeOutbox(auditId, { crm_log: args.crm_log ?? null });
  const resp = await withRetry(() =>
    getUnipileClient().messaging.startNewChat({
      account_id: acct.accountId,
      text: args.text,
      attendees_ids: [provider_id],
      ...(attachmentTuples ? { attachments: attachmentTuples } : {}),
    })
  );
  const chatId = (resp as { chat_id?: string | null }).chat_id;

  // 7. Verify-after-write per D-47 (poll getAllMessagesFromChat at 5s + 10s)
  const requestStartAt = Date.now();
  const verified = chatId ? await pollForMessage(chatId, requestStartAt, [5000, 5000]) : false;

  // 8. Audit row + envelope (D-25: include recipient_degree, attachment_count, text_hash via params_hash)
  // ... same as send-connection.ts:311-333
}
```

**Verify-after-write pattern** (D-47 — REPLACES send-connection.ts pollForRelation; uses messaging.getAllMessagesFromChat):
```typescript
async function pollForMessage(chatId: string, requestStartAt: number, delaysMs: number[]): Promise<boolean> {
  const client = getUnipileClient();
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const resp = await client.messaging.getAllMessagesFromChat({ chat_id: chatId, limit: 5 });
      const items = (resp as { items?: Array<{ is_sender?: number; timestamp?: string }> }).items ?? [];
      if (items.some(m => m.is_sender === 1 && new Date(m.timestamp ?? 0).getTime() >= requestStartAt)) {
        return true;
      }
    } catch { /* D-16 transient — continue */ }
  }
  return false;
}
```

**Deviation notes:**
- D-46 attachment shape: `{filename, mimetype, base64}[]` → decode to `[string, Buffer][]` server-side. CONTEXT D-23 said `File[]` — that was wrong (browser-only type).
- D-47 verify mechanism: use `messaging.getAllMessagesFromChat` (NOT `getProfile.last_message_at` which doesn't exist on the SDK schema).
- D-49 order: **dedup → account → rate-limit → attachment-validate → degree-check → send → verify → audit**. Different from CONTEXT D-42 which said rate-limit first; research corrected per Q4.
- Pre-flight refusals (`error_not_connected`, `error_attachment_too_large`) MUST NOT increment the rate-limit counter (research §4.7).

---

### NEW: `src/connectors/unipile/tools/linkedin-send-inmail.ts` (tool handler — destructive write with credit bracketing)

**Analog:** `linkedin-send-connection.ts` (handler shape) + escape-hatch pattern via `client.request.send()` (no existing analog in repo)

**Imports pattern** — same as send-message above, ADD the new error classes:
```typescript
import {
  UnipileInmailNotAuthorizedError,
  UnipileInmailRequiresPremiumError,
  // ... + classifyUnipileError, all the audit/crm/rate-limiter imports from send-connection
} from "../lib/errors";
```

**Schema pattern** (D-26/D-27):
```typescript
export const linkedinSendInmailSchema = {
  profile_url: z.string().url(),
  text: z.string().min(1).max(8000),
  subject: z.string().min(1).max(200).describe("InMail subject line."),
  allow_inmail: z
    .literal(true)
    .describe("Required: must be true to confirm credit usage (D-26 safety gate)."),
  max_inmail_credits: z.number().int().positive().optional(),
  account_id: z.string().optional(),
  actor_user_id: z.string(),
  crm_log: z.record(z.string(), z.unknown()).optional(),
};
```

**Handler-specific pattern — bracket the send with balance calls** (research §2.2 + D-48):
```typescript
// Step 1: refuse if !allow_inmail (D-26)
if (args.allow_inmail !== true) {
  // write audit with result: 'error_inmail_not_authorized', return
  throw new UnipileInmailNotAuthorizedError("allow_inmail must be true");
}

// Step 2: balanceBefore via escape hatch (D-48)
const client = getUnipileClient();
type InmailBalance = { premium: number | null; recruiter: number | null; sales_navigator: number | null };
const balanceBefore = (await withRetry(() =>
  client.request.send({
    path: "/linkedin/inmail_balance",
    method: "GET",
    parameters: { account_id: acct.accountId },
  })
)) as InmailBalance;

const totalBefore = (balanceBefore.premium ?? 0) +
                    (balanceBefore.recruiter ?? 0) +
                    (balanceBefore.sales_navigator ?? 0);

// Step 3: pre-flight gate — D-29 (NEW error class)
if (totalBefore === 0) {
  // write audit with result: 'error_inmail_requires_premium', return early — NO COUNTER INCREMENT
  throw new UnipileInmailRequiresPremiumError("Account has no InMail credits");
}

// Step 4: D-27 cap check
if (args.max_inmail_credits && totalBefore < args.max_inmail_credits) {
  // write audit with result: 'error_inmail_cap_exceeded'  (bonus enum from research §6)
}

// Step 5: rate-limit (same pattern as send-message)
// Step 6: provider resolve + can_send_inmail check (research §2.2 step 5)
// Step 7: send via startNewChat (D-50 — not a separate sendInmail method)
await withRetry(() =>
  client.messaging.startNewChat({
    account_id: acct.accountId,
    attendees_ids: [provider_id],
    subject: args.subject,
    text: args.text,
    options: { linkedin: { api: "classic", inmail: true } },
  })
);

// Step 8: balanceAfter (try/catch — log warning + return null credits on failure per D-28)
let creditsUsed: number | null = null;
let creditsRemaining: number | null = null;
try {
  const balanceAfter = (await withRetry(() =>
    client.request.send({ path: "/linkedin/inmail_balance", method: "GET",
                         parameters: { account_id: acct.accountId } })
  )) as InmailBalance;
  const totalAfter = (balanceAfter.premium ?? 0) +
                     (balanceAfter.recruiter ?? 0) +
                     (balanceAfter.sales_navigator ?? 0);
  creditsUsed = totalBefore - totalAfter;
  creditsRemaining = totalAfter;
} catch (err) {
  log.warn("inmail_balance post-send failed", { err: toMsg(err) });
}

// Step 9: audit + envelope (envelope includes credits_used, credits_remaining)
```

**Envelope shape** (D-28 corrected per D-48):
```typescript
interface InmailEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: "pending";
  dedup_hit: boolean;
  audit_id: string;
  credits_used: number | null;     // null when post-send balance fetch fails
  credits_remaining: number | null;
  message_id?: string;
  chat_id?: string;
  error?: string;
}
```

**Deviation notes:**
- D-48: SDK has NO `inmail_balance` method — use `client.request.send({path, method, parameters})` escape hatch. NO new dep.
- D-50: NO separate `users.sendInmail` SDK method exists. Use `messaging.startNewChat` with `options.linkedin.inmail = true`.
- D-28 fallback: if EITHER balance call fails, `credits_used = null` and `credits_remaining = null` (log warning, do NOT throw — the send succeeded).
- Phase 69 does NOT cache `inmail_balance` (research Q7 — Cadens scale is <15/day).
- Verify-after-write for InMail: ambiguous (InMail also writes to the chat). RECOMMENDATION: re-use the same `pollForMessage(chat_id)` pattern from send-message if `startNewChat` returns a `chat_id`. Planner should confirm whether to verify InMails identically — research is silent on this.

---

### NEW: `src/connectors/unipile/tools/linkedin-engage.ts` (super-tool — branched dispatcher)

**Analog:** Composite — uses envelope shape from `linkedin-send-connection.ts` + degree mapping from `linkedin-get-relationship-status.ts:104-117`

**Imports pattern** — re-export the 3 handler functions + degree mapper:
```typescript
import { handleLinkedinSendMessage } from "./linkedin-send-message";
import { handleLinkedinSendConnection } from "./linkedin-send-connection";
import { handleLinkedinSendInmail } from "./linkedin-send-inmail";
// Re-use private resolveAccountId + getProfile call from one of those tools, or
// extract to lib/account.ts (planner discretion — research §1.2 doesn't decide)
```

**Schema pattern** (D-30/D-31):
```typescript
export const linkedinEngageSchema = {
  profile_url: z.string().url(),
  message: z.string().optional().describe("Message body (used for send_message branch)."),
  note: z.string().max(300).optional().describe("Connection note (used for send_connection branch)."),
  allow_inmail: z.boolean().default(false),
  fallback_if_unreachable: z.enum(["inmail", "skip"]).default("skip"),
  dry_run: z.boolean().default(false),
  account_id: z.string().optional(),
  actor_user_id: z.string(),
  crm_log: z.record(z.string(), z.unknown()).optional(),
};
```

**Discriminated union return** (D-30):
```typescript
type EngageResult =
  | { action: "sent_message"; /* ...send-message envelope */ }
  | { action: "sent_connection"; /* ...send-connection envelope */ }
  | { action: "sent_inmail"; /* ...send-inmail envelope */ }
  | { action: "skipped"; reason: string; degree: 1 | 2 | 3 | null };
```

**Dispatcher pattern** (D-31 — degree-based routing; lift `mapDegree` from `linkedin-get-relationship-status.ts:104-117`):
```typescript
export async function handleLinkedinEngage(args: EngageArgs): Promise<ToolResult> {
  // Step 1: dry-run early-return per D-32/D-33 (BEFORE rate-limit, BEFORE provider calls)
  if (args.dry_run) {
    // Resolve degree only (no send). Write audit row with result: 'dry_run' (D-32)
    const degree = await getDegreeOnly(args);
    const proposedAction = routeFromDegree(degree, args);
    await writeAuditRow({ /* ... */ result: "dry_run", /* ... */ });
    return envelope({ action: proposedAction, dry_run: true, degree, /* ... */ });
  }

  // Step 2: resolve degree
  const degree = await getDegreeOnly(args);

  // Step 3: dispatch per D-31
  switch (degree) {
    case 1:
      if (!args.message) return envelope({ action: "skipped", reason: "no_message_provided", degree });
      return handleLinkedinSendMessage({ ...args, text: args.message });
    case 2:
    case 3:
      return handleLinkedinSendConnection({ ...args, note: args.note });
    default: // null / out_of_network
      if (args.fallback_if_unreachable === "inmail" && args.allow_inmail) {
        return handleLinkedinSendInmail({ ...args, allow_inmail: true });
      }
      return envelope({ action: "skipped", reason: "unreachable_no_inmail_fallback", degree });
  }
}
```

**Deviation notes:**
- D-33: dry_run SKIPS rate-limit check (it's not a real action) but DOES write an audit row with `result: 'dry_run'` (new enum member).
- D-32 audit row format: same as other tools, but `result: 'dry_run'`, `verified: false`, and an extra log field documenting what action WOULD have been taken (planner: store in params_hash payload? Or extend audit row schema? — likely the latter, but minimal: a single `proposed_action` field at audit-write time).
- `note?` param is Claude's discretion (CONTEXT line 89) — pass-through to send_connection branch ONLY.
- Engage MUST be marked `destructive: true` in manifest (it's a write super-tool).
- Pre-flight refusals from engage (e.g., dry_run, no_message_provided, unreachable_no_inmail_fallback) MUST NOT count toward any rate-limit cap.

---

### NEW: `src/connectors/unipile/tools/linkedin-list-pending.ts` (tool handler — read, paginated)

**Analog:** `tools/linkedin-get-relationship-status.ts` (read-only envelope shape) + research §3.1 (full implementation)

**Schema pattern** (D-34/D-35/D-36):
```typescript
export const linkedinListPendingSchema = {
  account_id: z.string().optional(),
  older_than_days: z.number().int().positive().optional()
    .describe("Client-side filter — only return invitations older than N days."),
  limit: z.number().int().positive().max(500).default(100)
    .describe("Max items to return (default 100, cap 500)."),
};
```

**Handler pattern** (research §3.1 — verbatim usable; ~40 lines):
```typescript
export async function handleLinkedinListPending(args: ListPendingArgs): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 100, 500);
  const acct = await resolveAccountId(args);
  if ("error" in acct) return envelope({ count: 0, items: [], error: acct.error });

  const allItems: InvitationItem[] = [];
  let cursor: string | null = null;
  do {
    const resp = await withRetry(() =>
      getUnipileClient().users.getAllInvitationsSent({
        account_id: acct.accountId,
        limit: Math.min(limit - allItems.length, 100),  // Unipile per-page max 100
        ...(cursor ? { cursor } : {}),
      })
    );
    allItems.push(...((resp as { items?: InvitationItem[] }).items ?? []));
    cursor = (resp as { cursor?: string | null }).cursor ?? null;
  } while (cursor && allItems.length < limit);

  const now = Date.now();
  const filtered = allItems
    .filter(i => i.parsed_datetime !== null)  // can't compute age without ISO date
    .map(i => ({
      invitation_id: i.id,
      recipient_profile_url: i.invited_user_public_id
        ? `https://linkedin.com/in/${i.invited_user_public_id}`
        : null,
      recipient_name: i.invited_user,
      sent_at: i.parsed_datetime!,
      age_days: Math.floor((now - new Date(i.parsed_datetime!).getTime()) / 86_400_000),
      has_note: i.invitation_text !== null && (i.invitation_text?.length ?? 0) > 0,
    }))
    .filter(i => args.older_than_days === undefined || i.age_days >= args.older_than_days);

  return envelope({ count: filtered.length, items: filtered });
}
```

**Deviation notes:**
- D-37: NOT destructive. NO rate-limit check (it's a read). NO audit row (research §3.1 says optional — recommend skip for simplicity).
- D-35: `older_than_days` is a CLIENT-side filter — applied after Unipile fetch. The SDK input type has NO `since` param (research §3 verified).
- D-36: default 100, max 500. Paginate via Unipile's `cursor` field (base64-encoded `{limit, cursor}` per research §3 live sample).
- `parsed_datetime` can be `null` (rare — old/corrupt). Filter these out rather than fail.
- DO NOT call `resolveProviderId` or `getProfile` — this tool only reads invitation list.

---

### MOD: `src/connectors/unipile/lib/errors.ts` (extend with 5 new error classes + 3 new enum members)

**Analog:** the file itself — pattern of `class XxxError extends McpToolError` is locked in phase 68 (errors.ts:33-97)

**Surgical changes** (research §7.1 — add 5 new classes after `Unipile5xxError` at line 97):
```typescript
// NEW class — for D-26 (allow_inmail !== true)
export class UnipileInmailNotAuthorizedError extends McpToolError {
  constructor(msg: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      toolName: "unipile",
      message: msg,
      userMessage: "InMail not authorized — set allow_inmail: true to confirm credit usage.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Re-call the tool with allow_inmail: true if you want to spend an InMail credit.",
    });
    this.name = "UnipileInmailNotAuthorizedError";
  }
}

// NEW class — for D-29 (account lacks Premium / Sales Nav / Recruiter)
export class UnipileInmailRequiresPremiumError extends McpToolError {
  constructor(msg: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.AUTH_FAILED,
      toolName: "unipile",
      message: msg,
      userMessage: "This LinkedIn account does not have InMail credits.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Use linkedin_send_connection (free) or upgrade the LinkedIn account.",
    });
    this.name = "UnipileInmailRequiresPremiumError";
  }
}

// NEW class — for D-45 UNI-26 (422 invalid_recipient)
export class UnipileRecipientUnreachableError extends McpToolError { /* ... */ }

// NEW class — for D-45 UNI-26 (400 invalid_parameters)
export class UnipileInvalidRequestError extends McpToolError { /* ... */ }

// NEW class — for D-23 (attachment > 15 MB)
export class UnipileAttachmentTooLargeError extends McpToolError {
  constructor(msg: string, sizeBytes: number) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      toolName: "unipile",
      message: `${msg} (size: ${sizeBytes} bytes, limit: 15728640)`,
      userMessage: `Attachment exceeds the 15 MB LinkedIn limit.`,
      retryable: false,
      recovery: "Compress the file or remove it.",
    });
    this.name = "UnipileAttachmentTooLargeError";
  }
}
```

**Extend `UnipileErrorResult` enum** (errors.ts:99-103 — add 3 new members per D-29/D-45):
```typescript
export type UnipileErrorResult =
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  | "error_recipient_unreachable"      // NEW D-45
  | "error_invalid_request"             // NEW D-45
  | "error_inmail_requires_premium";    // NEW D-29
```

**Extend `classifyUnipileError`** (errors.ts:115-127 — add 3 new branches per research §7.2):
```typescript
export function classifyUnipileError(err: unknown): UnipileErrorResult {
  if (!(err instanceof UnsuccessfulRequestError)) return "error_unipile_5xx";
  const body = (err.body ?? {}) as { status?: unknown; type?: unknown };
  const status = typeof body.status === "number" ? body.status : 0;
  const type = typeof body.type === "string" ? body.type : "";

  if (status === 429) return "error_rate_limit";
  if (status === 422 && type.includes("cannot_resend")) return "error_rate_limit";
  if (status === 422 && type.includes("invalid_recipient")) return "error_recipient_unreachable";  // NEW
  if (status === 422 && type.includes("inmail_requires_premium")) return "error_inmail_requires_premium";  // NEW
  if (status === 400 && type.includes("invalid_parameters")) return "error_invalid_request";  // NEW
  if (status === 401 || status === 403) {
    if (type.includes("inmail_requires_premium")) return "error_inmail_requires_premium";  // NEW variant
    return "error_account_restricted";
  }
  if (status === 404) return "error_not_connected";
  if (status >= 500) return "error_unipile_5xx";
  return "error_unipile_5xx";
}
```

**Deviation notes:**
- Order matters in `classifyUnipileError`: more-specific 422/400 type checks MUST come before the catchall 401/403 branch.
- Test additions (mirrors phase 68 `errors.test.ts` table-driven pattern):
  - `[400, "invalid_parameters", "error_invalid_request"]`
  - `[422, "invalid_recipient", "error_recipient_unreachable"]`
  - `[422, "inmail_requires_premium", "error_inmail_requires_premium"]`
  - `[403, "inmail_requires_premium", "error_inmail_requires_premium"]` (variant)
- Each new error class also needs a per-class test for: `name`, `retryable` flag, `recovery` string presence.

---

### MOD: `src/connectors/unipile/lib/audit.ts` (extend `AuditResult` enum with 7 new members)

**Analog:** the file itself — `AuditResult` union at audit.ts:42-48 is locked-style, surgical extend

**Surgical change** (audit.ts:42-48 — add 7 new union members; preserve order from phase 68):
```typescript
export type AuditResult =
  // Phase 68 (locked — DO NOT reorder)
  | "success"
  | "unverified_timeout"
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  // Phase 69 — CONTEXT-mandated (7 new)
  | "dry_run"                              // D-32 — engage dry_run audit row
  | "error_attachment_too_large"           // D-23 — send_message/inmail attachment validation
  | "error_inmail_not_authorized"          // D-26 — allow_inmail !== true
  | "error_inmail_requires_premium"        // D-29 — account lacks Premium/SalesNav
  | "error_invalid_request"                // D-45 — Unipile 400 invalid_parameters
  | "error_rate_limit_kebab"               // D-43 — Kebab cap hit (distinct from Unipile 429)
  | "error_recipient_unreachable"          // D-45 — Unipile 422 invalid_recipient
  // Phase 69 — Claude's discretion (2 bonus, research §6 recommended)
  | "error_inmail_recipient_not_eligible"  // recipient blocked Open Profile
  | "error_inmail_cap_exceeded";           // args.max_inmail_credits would be exceeded
```

**Deviation notes:**
- NO change to `AUDIT_TTL_SECONDS`, `AuditRow` schema, `writeAuditRow`, `checkDedup`, `computeParamsHash`, or `generateAuditId` — only the enum extends.
- `audit.test.ts` already has a test asserting the enum does NOT contain `"pending"` (T-68-04-04). Add a parallel test asserting the 9 new members are present.
- The 2 bonus members (`error_inmail_recipient_not_eligible`, `error_inmail_cap_exceeded`) come from research §6 — planner can drop them if user prefers strict CONTEXT alignment, but they improve operator observability for distinct failure modes.

---

### MOD: `src/connectors/unipile/lib/identifiers.ts` (extend SLUG_RE per D-44)

**Analog:** the file itself — SLUG_RE regex at identifiers.ts:50-51

**Surgical change** (identifiers.ts:50-51 — extend regex with optional query/fragment groups; both NON-capturing so `match[1]` still extracts the slug):
```typescript
// BEFORE (phase 68):
const SLUG_RE =
  /^(?:https?:\/\/)?(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?$/;

// AFTER (phase 69 — D-44):
const SLUG_RE =
  /^(?:https?:\/\/)?(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?(?:\?[^#/]*)?(?:#[^/]*)?$/;
```

**Changes:**
1. Add `(?:\?[^#/]*)?` — optional query string (anything except `#` and `/` until end or fragment).
2. Add `(?:#[^/]*)?` — optional URL fragment.
3. Both groups are non-capturing — `match[1]` is still the slug (no change to `normalizeProfileUrl` body).

**Required new test cases** (research §5 — 5 tests recommended, D-44 said 3):
```typescript
it.each([
  ["https://www.linkedin.com/in/john-doe?originalSubdomain=fr", "https://linkedin.com/in/john-doe"],
  ["https://linkedin.com/in/jane?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAA", "https://linkedin.com/in/jane"],
  ["https://linkedin.com/in/bob?utm_source=newsletter&utm_campaign=q2", "https://linkedin.com/in/bob"],
  ["https://fr.linkedin.com/in/marie?originalSubdomain=fr", "https://linkedin.com/in/marie"],
  ["https://linkedin.com/in/alice/#contact-info", "https://linkedin.com/in/alice"],
])("normalizes %s -> %s (D-44 query/fragment support)", (input, expected) => {
  expect(normalizeProfileUrl(input)).toBe(expected);
});
```

**Deviation notes:**
- NO change to `normalizeProfileUrl` body — slug extraction logic still uses `m[1].toLowerCase()`. The output is already canonical `https://linkedin.com/in/<slug>` (query/fragment stripped naturally).
- ReDoS safety: `[^#/]*` is a simple char class bounded by `$` or fragment marker — not vulnerable to catastrophic backtracking (preserves T-68-03-04 invariant).
- Research Q5: query string MAY NOT contain raw `/` (forbidden by `[^#/]*`). LinkedIn real-world URLs URL-encode slashes (`%2F`) which the regex accepts — safe to ship.

---

### MOD: `src/connectors/unipile/tools/linkedin-send-connection.ts` (retrofit with rate-limiter per D-43)

**Analog:** the file itself — D-49 reverses CONTEXT D-42's ordering, so the surgical insert is BETWEEN existing steps 2 (account resolve) and 3 (provider resolve)

**Surgical change** (insert after send-connection.ts:239 `const accountId = acct.accountId;`):
```typescript
const accountId = acct.accountId;

// 2b. NEW Phase 69: Rate-limit check (D-43 + D-49 — dedup ran FIRST already at step 1).
const rl = await checkUnipileRateLimit({ account_id: accountId, tool: "send_connection" });
if (rl.blocked) {
  await writeAuditRow({
    audit_id: auditId,
    actor_user_id: args.actor_user_id,
    tool: "linkedin_send_connection",
    account_id: accountId,
    params_hash: paramsHash,
    result: "error_rate_limit_kebab",  // NEW enum (distinct from Unipile 429)
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
    error: "error_rate_limit_kebab",
    blocked_by_rate_limit: true,
    daily_used: rl.daily_used,
    daily_limit: rl.daily_limit,
    weekly_used: rl.weekly_used,
    weekly_limit: rl.weekly_limit,
    retry_after: rl.retry_after,
  });
}

// 3. Resolve provider_id (existing — unchanged)
```

**Envelope shape extension** — extend `SendEnvelope` interface (send-connection.ts:96-105) with the 4 optional rate-limit fields:
```typescript
interface SendEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: "pending";
  dedup_hit: boolean;
  audit_id: string;
  invitation_id?: string;
  error?: string;
  available_accounts?: string[];
  // NEW (Phase 69 — D-43)
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  weekly_used?: number;
  weekly_limit?: number;
  retry_after?: string;
}
```

**Deviation notes:**
- D-49 overrides CONTEXT D-42: order is **dedup-FIRST → account-resolve → rate-limit → provider-resolve → send → verify → audit**. NEVER rate-limit before dedup (would burn quota on no-op retries).
- Existing phase 68 integration tests will pass (rate-limiter returns `blocked: false` with default caps), BUT planner MUST add a NEW test that exercises the blocked path (research Q8).
- DO NOT touch existing steps 1, 2, 3-7 — only insert step 2b.
- Add `checkUnipileRateLimit` import to the import block.

---

### MOD: `src/connectors/unipile/manifest.ts` (add 4 new defineTool entries)

**Analog:** the file itself — `buildTools()` at manifest.ts:132-158 has the exact extension point

**Imports pattern** (manifest.ts:6-13 — add 4 new schema+handler import blocks):
```typescript
import {
  linkedinSendMessageSchema,
  handleLinkedinSendMessage,
} from "./tools/linkedin-send-message";
import {
  linkedinSendInmailSchema,
  handleLinkedinSendInmail,
} from "./tools/linkedin-send-inmail";
import {
  linkedinEngageSchema,
  handleLinkedinEngage,
} from "./tools/linkedin-engage";
import {
  linkedinListPendingSchema,
  handleLinkedinListPending,
} from "./tools/linkedin-list-pending";
```

**`buildTools()` extension** (manifest.ts:132-158 — append 4 new `defineTool({})` entries after `linkedin_get_relationship_status`):
```typescript
function buildTools(): ToolDefinition[] {
  return [
    // Existing — Phase 68
    defineTool({ name: "linkedin_send_connection", /* ... */ destructive: true }),
    defineTool({ name: "linkedin_get_relationship_status", /* ... */ destructive: false }),
    // NEW — Phase 69
    defineTool({
      name: "linkedin_send_message",
      description: "Send a LinkedIn DM to a 1st-degree connection. " +
        "Attachments supported (PDF/image ≤15MB, ≤5 files). " +
        "Verified-after-write (polls at 5s+10s). Refuses if recipient is not 1st-degree.",
      schema: linkedinSendMessageSchema,
      handler: async (args) => handleLinkedinSendMessage(args as Parameters<typeof handleLinkedinSendMessage>[0]),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_send_inmail",
      description: "Send a LinkedIn InMail (paid). REQUIRES allow_inmail: true to confirm credit usage. " +
        "Tracks credits_used / credits_remaining via inmail_balance bracketing.",
      schema: linkedinSendInmailSchema,
      handler: async (args) => handleLinkedinSendInmail(args as Parameters<typeof handleLinkedinSendInmail>[0]),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_engage",
      description: "Super-tool: routes to send_message (1st-degree), send_connection (2nd/3rd), " +
        "send_inmail (out-of-network with allow_inmail:true), or skip. " +
        "Supports dry_run: true to preview the action without executing.",
      schema: linkedinEngageSchema,
      handler: async (args) => handleLinkedinEngage(args as Parameters<typeof handleLinkedinEngage>[0]),
      destructive: true,
    }),
    defineTool({
      name: "linkedin_list_pending",
      description: "List pending LinkedIn invitations sent from the account, with age_days. " +
        "Optional older_than_days filter (client-side).",
      schema: linkedinListPendingSchema,
      handler: async (args) => handleLinkedinListPending(args as Parameters<typeof handleLinkedinListPending>[0]),
      destructive: false,
    }),
  ];
}
```

**Test updates** (manifest.test.ts:44-57 — bump from 2 to 6 tools, add destructive assertions for 3 new write tools):
```typescript
it("exposes exactly 6 tools (Phase 69 complete)", () => {
  const names = unipileConnector.tools.map((t) => t.name);
  expect(names).toEqual([
    "linkedin_send_connection",
    "linkedin_get_relationship_status",
    "linkedin_send_message",
    "linkedin_send_inmail",
    "linkedin_engage",
    "linkedin_list_pending",
  ]);
});

it.each([
  ["linkedin_send_connection", true],
  ["linkedin_send_message", true],
  ["linkedin_send_inmail", true],
  ["linkedin_engage", true],
  ["linkedin_get_relationship_status", false],
  ["linkedin_list_pending", false],
])("%s destructive flag = %s", (name, destructive) => {
  const t = unipileConnector.tools.find((t) => t.name === name);
  expect(t?.destructive).toBe(destructive);
});
```

**Deviation notes:**
- 3 of 4 new tools are `destructive: true` (send_message, send_inmail, engage). Only `linkedin_list_pending` is `destructive: false`.
- DO NOT change `testConnection` / `diagnose` / `requiredEnvVars` / `guide` / `description` / `label` / `id` — all still locked at phase 68 values.
- Preserve the lazy `get tools()` getter so any future env-driven filtering works at resolve time (mirrors apify pattern).

---

### MOD: `src/core/registry.ts` (bump toolCount 2 → 6)

**Analog:** the file itself — registry.ts:168

**Surgical change** (registry.ts:165-168 — one-line bump, update preceding comment):
```typescript
// BEFORE (phase 68):
// Plan 06 (Wave 3): 2 tools wired — linkedin_send_connection (destructive)
// + linkedin_get_relationship_status (read). registry-metadata-consistency
// contract test asserts toolCount === manifest.tools.length.
toolCount: 2,

// AFTER (phase 69):
// Phase 69 (UNI-07..10): 6 tools total — send_connection, get_relationship_status,
// send_message, send_inmail, engage, list_pending. registry-metadata-consistency
// contract test asserts toolCount === manifest.tools.length.
toolCount: 6,
```

**Deviation notes:**
- `toolCount` MUST equal `manifest.tools.length` — `tests/contract/registry-metadata-consistency.test.ts` enforces this. If you forget to update either side, the contract test fails.
- DO NOT change other fields (`id`, `label`, `description`, `requiredEnvVars`, `loader`).

---

### MOD: `content/docs/connectors.md` (update tool count + bullet list)

**Analog:** the file itself — lines 64-67 (unipile section)

**Surgical change** (lines 64-67):
```markdown
<!-- BEFORE (phase 68): -->
Provides 2 tools:

- `linkedin_send_connection` — send a connection request and verify it actually went through ...
- `linkedin_get_relationship_status` — read the network distance (1/2/3/null) ...

<!-- AFTER (phase 69): -->
Provides 6 tools:

- `linkedin_send_connection` — send a connection request and verify it actually went through (3-poll verify-after-write at 2s/5s/10s). Returns `verified: true|false` — never silent ambiguity. Same `(profile_url, note)` combination is deduped for 90 days; change the note to retry. Per-account daily/weekly caps enforced (25/day, 100/week by default).
- `linkedin_get_relationship_status` — read the network distance (1/2/3/null) of a profile relative to your connected account.
- `linkedin_send_message` — send a LinkedIn DM to a 1st-degree connection. Attachments supported (PDF/image ≤15MB, ≤5 files). Verified-after-write (polls at 5s + 10s).
- `linkedin_send_inmail` — send a paid LinkedIn InMail. REQUIRES `allow_inmail: true` to confirm credit usage. Tracks `credits_used` / `credits_remaining`.
- `linkedin_engage` — super-tool: routes to send_message (1st-degree), send_connection (2nd/3rd), send_inmail (out-of-network with `allow_inmail: true`), or skip. Supports `dry_run: true` to preview the action.
- `linkedin_list_pending` — list pending LinkedIn invitations sent from the account, with age_days. Optional `older_than_days` filter.
```

**Deviation notes:**
- This file IS scanned by `scripts/check-doc-counts.ts` (the doc-count drift gate — research note in phase 68 PATTERNS.md). The script counts per-connector tool numbers.
- Run `npx tsx scripts/check-doc-counts.ts` AFTER updating manifest.ts AND this file to verify no drift.

---

### MOD: `README.md` (bump tool count claim)

**Analog:** the file itself — 4 distinct claim sites on lines 3, 52, 65, 72

**Surgical change** — locate the 4 sites and bump the "93+" claim. The doc-counts script counts `defineTool(` across all manifests; with the 4 new entries, the total goes from 93 to 97:
```markdown
# Line 3: <p align="center"><strong>Your personal AI backend. One endpoint. 93+ tools. Deploy in 5 minutes.</strong></p>
# Line 52:    │   /api/mcp  →  registry  →  93+ tools across 17 connectors         │
# Line 65: **What it is.** ... 93+ pre-built tools across 17 connectors. ...
# Line 72: - ✅ **93+ tools, no code** — ... Unipile (LinkedIn writes), ...

# AFTER (Phase 69): replace each "93+" with "97+" (or whatever scripts/check-doc-counts.ts reports as the new expectedTools value)
```

**Deviation notes:**
- DO NOT count manually — run `npx tsx scripts/check-doc-counts.ts` AFTER manifest landing; it logs `[check-doc-counts] registry truth: <N> tools across <M> connectors` (script line 119). Use THAT number for the README update.
- `expectedConnectors` stays 17 (Unipile already existed as a connector — only tool count grows).
- The `93+` claim uses the `+` operator suffix (lenient `<=` check per check-doc-counts.ts:82), so the gate enforces "claimed ≤ actual" — claiming 93+ when actual is 97 would PASS but undersell. Best practice: update to the new ceiling.

---

### NEW: Test files

**Analog patterns by test category:**

| Test file | Analog | Pattern source |
|-----------|--------|----------------|
| `lib/__tests__/rate-limiter.test.ts` | `lib/__tests__/identifiers.test.ts` (KV-mock pattern) | vi.hoisted() + getContextKVStore mock |
| `tools/__tests__/linkedin-send-message.test.ts` | `tools/__tests__/linkedin-send-connection.test.ts` | SDK + KV + UnsuccessfulRequestError mock; fake timers for poll budget |
| `tools/__tests__/linkedin-send-inmail.test.ts` | `tools/__tests__/linkedin-send-connection.test.ts` + ADD `client.request.send` mock for balance calls | same scaffold, extra mock |
| `tools/__tests__/linkedin-engage.test.ts` | `tools/__tests__/linkedin-send-connection.test.ts` + mocks for the 3 delegate handlers | dispatcher pattern — test each branch |
| `tools/__tests__/linkedin-list-pending.test.ts` | `tools/__tests__/linkedin-get-relationship-status.test.ts` (read tool) | simpler — no audit row, no rate-limit |

**vi.hoisted SDK mock pattern** (lift from `linkedin-send-connection.test.ts:6-77`):
```typescript
const { sendMock, kvMock, FakeUnsuccessful } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const kvMock = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), incr: vi.fn() };
  class FakeUnsuccessful extends Error {
    body: { status?: number; type?: string };
    constructor(body: { status?: number; type?: string }) {
      super(`unipile ${JSON.stringify(body)}`);
      this.body = body;
    }
  }
  return { sendMock, kvMock, FakeUnsuccessful };
});

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    messaging: { startNewChat: sendMock, getAllMessagesFromChat: vi.fn() },
    users: { getProfile: vi.fn(), getAllInvitationsSent: vi.fn() },
    account: { getAll: vi.fn() },
    request: { send: vi.fn() },  // NEW — for inmail_balance escape hatch
  }),
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: FakeUnsuccessful,
}));
```

**Rate-limiter test scaffold** (mirrors identifiers.test.ts:21-66 — KV-mock with `incr`):
```typescript
const hoist = vi.hoisted(() => {
  const kvMock = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    incr: vi.fn<(k: string, opts?: { ttlSeconds?: number }) => Promise<number>>(),
  };
  return { kvMock };
});

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

import { checkUnipileRateLimit } from "../rate-limiter";

describe("checkUnipileRateLimit (D-38..D-41)", () => {
  it("allows when count <= daily_limit", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(1);
    const r = await checkUnipileRateLimit({ account_id: "acct1", tool: "send_connection" });
    expect(r.blocked).toBe(false);
    expect(r.daily_used).toBe(1);
  });

  it("blocks when count > daily_limit (D-39: default 25)", async () => {
    hoist.kvMock.incr.mockResolvedValueOnce(26);
    const r = await checkUnipileRateLimit({ account_id: "acct1", tool: "send_connection" });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("daily_cap");
    expect(r.retry_after).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00/);  // next UTC midnight
  });

  it("fails closed when KV throws (D-40 default)", async () => {
    hoist.kvMock.incr.mockRejectedValueOnce(new Error("KV down"));
    const r = await checkUnipileRateLimit({ account_id: "acct1", tool: "send_connection" });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("kv_unavailable");
  });

  it("fails open when KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open", async () => {
    process.env.KEBAB_UNIPILE_RATELIMIT_FAIL_MODE = "open";
    hoist.kvMock.incr.mockRejectedValueOnce(new Error("KV down"));
    const r = await checkUnipileRateLimit({ account_id: "acct1", tool: "send_connection" });
    expect(r.blocked).toBe(false);
    delete process.env.KEBAB_UNIPILE_RATELIMIT_FAIL_MODE;
  });
});
```

**Deviation notes:**
- Use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` for poll-budget tests (mirrors phase 68 send-connection.test.ts:80+ pattern).
- For rate-limit retrofit test on `linkedin-send-connection.ts`: ADD a `vi.mock("../../lib/rate-limiter", () => ({ checkUnipileRateLimit: vi.fn() }))` block and exercise both `blocked: true` and `blocked: false` paths.
- For `linkedin-engage.test.ts`: mock the 3 delegate handlers (`vi.mock("./linkedin-send-message", () => ({ handleLinkedinSendMessage: vi.fn() }))` etc.) and assert routing per degree.

---

## Shared Patterns

### Logger tag
**Source:** `src/connectors/unipile/lib/client.ts:25`
**Apply to:** ALL new `.ts` files in `src/connectors/unipile/lib/` and `src/connectors/unipile/tools/`
```typescript
import { getLogger } from "@/core/logging";
const log = getLogger("CONNECTOR:unipile");
```

### Credential reads (NEVER process.env)
**Source:** `src/core/config-facade.ts` (`getConfig`, `getConfigInt`); enforced by ESLint rule `kebab/no-direct-process-env`
**Apply to:** ALL UNIPILE_* + KEBAB_UNIPILE_* env var reads (rate-limiter caps, fail-mode)
```typescript
import { getConfig, getConfigInt } from "@/core/config-facade";
const cap = getConfigInt("KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP", 25);
const mode = getConfig("KEBAB_UNIPILE_RATELIMIT_FAIL_MODE");
```

### Tenant-scoped KV access
**Source:** `src/core/request-context.ts:72-74`
**Apply to:** ALL `src/connectors/unipile/lib/*.ts` (rate-limiter + existing audit/identifiers/crm-bridge). The admin DELETE route from phase 68 remains the ONLY documented exception.
```typescript
import { getContextKVStore } from "@/core/request-context";
const kv = getContextKVStore();
```

### Error stringification
**Source:** `src/core/error-utils.ts` (`toMsg`)
**Apply to:** All catch blocks in rate-limiter + tool handlers that log error details
```typescript
import { toMsg } from "@/core/error-utils";
catch (err) { log.warn("..."), { err: toMsg(err) }); }
```

### Tool handler envelope return
**Source:** `tools/linkedin-send-connection.ts:107-111`
**Apply to:** All 4 new tools — wrap the envelope in `{content: [{type: "text", text: JSON.stringify(e, null, 2)}]}`
```typescript
function envelope(e: SomeEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}
```

### withRetry wrapping
**Source:** `src/connectors/unipile/lib/retry.ts:29-53`
**Apply to:** EVERY SDK call in EVERY new tool — `client.users.getProfile`, `client.messaging.startNewChat`, `client.messaging.getAllMessagesFromChat`, `client.users.getAllInvitationsSent`, `client.request.send` (for inmail_balance), `client.account.getAll`
```typescript
import { withRetry } from "../lib/retry";
const resp = await withRetry(() => client.users.getAllInvitationsSent({ /* ... */ }));
```

### Account resolution (D-20 pattern)
**Source:** `tools/linkedin-send-connection.ts:117-133` (and duplicate in `linkedin-get-relationship-status.ts:75-91`)
**Apply to:** send_message, send_inmail, engage, list_pending — copy verbatim or extract to a shared `lib/account.ts` helper
```typescript
async function resolveAccountId(args: SomeArgs)
  : Promise<{ accountId: string }
            | { error: "error_no_linkedin_account" }
            | { error: "error_account_id_required"; available_accounts: string[] }> {
  if (args.account_id) return { accountId: args.account_id };
  const resp = await getUnipileClient().account.getAll();
  const items = (resp as { items?: Array<{ id: string; type: string }> }).items ?? [];
  const linkedinAccounts = items.filter((i) => i.type === "LINKEDIN").map((i) => i.id);
  if (linkedinAccounts.length === 0) return { error: "error_no_linkedin_account" };
  if (linkedinAccounts.length > 1) {
    return { error: "error_account_id_required", available_accounts: linkedinAccounts };
  }
  return { accountId: linkedinAccounts[0]! };
}
```
**Planner note:** Phase 68 PATTERNS.md mentioned that the read tool kept this local rather than extracting to a shared lib. With 4 new tools all needing it, **strong recommendation: extract to `src/connectors/unipile/lib/account.ts`** to avoid 4-way drift. Discretionary.

### Audit row write (D-07/D-08 — no PII)
**Source:** `lib/audit.ts:117-124` (`writeAuditRow`)
**Apply to:** All 4 new write tools — every code path writes an audit row (success, dedup, rate-limit-block, attachment-too-large, dry_run, error_inmail_*)
```typescript
await writeAuditRow({
  audit_id: auditId, actor_user_id: args.actor_user_id, tool: "linkedin_send_message",
  account_id: accountId, params_hash: paramsHash,
  result: <AuditResult>, verified: <boolean>, dedup_hit: false,
  timestamp: new Date().toISOString(),
});
```
**Critical:** `params_hash` is the ONLY hash of `{tool, profile_url_normalized, note_or_text}`. NEVER persist raw `note`, `text`, `subject` strings.

### Dedup-first ordering (D-49)
**Source:** `tools/linkedin-send-connection.ts:189-209`
**Apply to:** send_message, send_inmail, send_connection (retrofit). Dedup BEFORE account resolve, BEFORE rate-limit, BEFORE any SDK call.
**Reason:** Dedup hits MUST NOT consume rate-limit quota. Pre-flight refusals (degree mismatch, attachment too large, allow_inmail missing) also MUST NOT consume quota — only actual SDK invocations or terminal failures past the rate-limit check do.

### Vi.hoisted mock factory pattern (vitest 4.x)
**Source:** `tools/__tests__/linkedin-send-connection.test.ts:6-52` (canonical pattern)
**Apply to:** EVERY new test file in `lib/__tests__/` and `tools/__tests__/`
**Reason:** `vi.mock` is hoisted above top-level `const` declarations. To close over locally-declared spies, use `vi.hoisted()` to move them into the same hoist tier.

---

## No Analog Found

Files with no close in-repo match (planner uses RESEARCH.md patterns or invents):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/connectors/unipile/lib/rate-limiter.ts` (windowing + fail-closed) | utility | KV transform | `src/core/rate-limit.ts` provides the atomic-incr KV pattern but uses per-minute windows and FAILS OPEN. Phase 69 needs per-day/per-week windows and FAILS CLOSED. Lift the incr idiom from rate-limit.ts:131-146, invent the windowing + fail-mode logic per research §4. |
| `linkedin-send-inmail.ts` (balance bracketing via `client.request.send`) | tool handler | request-response with escape hatch | No connector uses the SDK escape-hatch `request.send()` pattern. Invent per research §2.1 — call `client.request.send({path: "/linkedin/inmail_balance", method: "GET", parameters: {account_id}})` before AND after the send. |
| `linkedin-engage.ts` (super-tool dispatcher) | super-tool | branched dispatch | No connector has a degree-routed dispatcher that conditionally delegates to other tools in the same connector. Compose per D-30/D-31; lift mapDegree from `linkedin-get-relationship-status.ts:104-117` for the degree decision. |

**Mitigation:** All 3 novel patterns are explicitly designed in RESEARCH.md (sections §4, §2, §1 respectively). Planner can lift the code verbatim.

---

## Metadata

**Analog search scope:**
- `src/connectors/unipile/**` (all 18 phase 68 files — primary analogs)
- `src/core/rate-limit.ts` (closest pattern for the new rate-limiter)
- `src/core/registry.ts` (toolCount line)
- `src/core/kv-store.ts` (verified `incr` + `ttlSeconds` API for fail-closed rate-limiter)
- `src/core/config-facade.ts` (`getConfig` / `getConfigInt` for caps)
- `src/core/request-context.ts` (tenant-scoped KV — re-used unchanged)
- `content/docs/connectors.md` (lines 58-67 — unipile section)
- `README.md` (lines 3, 52, 65, 72 — tool count claims)
- `scripts/check-doc-counts.ts` (drift gate — runs against manifest defineTool count)
- `tests/contract/kv-allowlist.test.ts` (verified NO new entry needed — all new code uses `getContextKVStore`)

**Files scanned:** 18 (unipile) + 7 (core/config/scripts/tests/docs) = 25 source artifacts

**Pattern extraction date:** 2026-05-18

---

## PATTERN MAPPING COMPLETE
