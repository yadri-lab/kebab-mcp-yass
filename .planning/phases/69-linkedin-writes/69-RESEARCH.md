# Phase 69: LinkedIn Writes Completion - Research

**Researched:** 2026-05-18
**Domain:** Unipile messaging/InMail/invitations endpoints + KV-backed rate-limiter
**Confidence:** HIGH (SDK surface verified by reading `node_modules/unipile-node-sdk/dist/types/`; live API verified via curl against tenant `api41.unipile.com:17153`)

## Summary

Phase 69 extends the Unipile connector with 4 LinkedIn write tools (`send_message`, `send_inmail`, `engage`, `list_pending`) + a KV-backed per-account rate-limiter. The SDK foundation (lazy singleton, retry, URN cache, audit log, dedup, CRM bridge skeleton) is already locked in 68-RESEARCH.md — **read that document first for all foundational patterns**. This research focuses on the 5 NEW capabilities, the regex fix (D-44), and the 8 new audit/error enum members (D-29, D-44, D-45).

**Three SDK shape surprises uncovered during live verification — each modifies a CONTEXT decision and is flagged as an Open Question for the planner:**

1. **InMail credits are NOT returned by the send call.** They live behind a separate `GET /api/v1/linkedin/inmail_balance?account_id=…` endpoint that the SDK does NOT expose (must use `client.request.send()` escape hatch). Live response shape: `{object: "LinkedinInmailBalance", premium: null, recruiter: null, sales_navigator: 150}`. D-28's "Unipile-returned credits_used + credits_remaining" assumption is wrong — we must call inmail_balance BEFORE and AFTER the send and derive `credits_used = before - after`.
2. **InMail send mechanism is `messaging.startNewChat`** with `options.linkedin = {api: "classic", inmail: true}` — NOT a `users.sendInmail` method (which does not exist in the SDK). The CONTEXT D-29 description is correct in spirit but the SDK call shape differs from what the CONTEXT suggests.
3. **Attachments are tuples `[filename: string, Buffer]`, not browser `File` objects.** D-23's `File[]` shape works in a browser but Vercel lambdas operate on `Buffer`. The MCP tool schema must accept base64 + filename + mimetype and decode to a `Buffer` server-side; size check stays at ≤15 MB.

**Primary recommendation:** Build `lib/rate-limiter.ts` modeled on the existing `src/core/rate-limit.ts` pattern (KV `incr` + bucket key) but with day/week windows. Build `tools/linkedin-send-message.ts` using a two-phase approach — try `sendMessage` against a known `chat_id` if cached, else `startNewChat`. For send_inmail, wrap `startNewChat` with the inmail option and bracket the call with two `inmail_balance` requests. For list_pending, paginate `getAllInvitationsSent` and apply `older_than_days` client-side.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**linkedin_send_message (UNI-07)**
- **D-22:** Tool refuses with `error: 'error_not_connected'` if recipient is NOT 1st-degree. Resolves via `getProfile.network_distance` BEFORE attempting send.
- **D-23:** Attachments support: PDF/image ≤15MB. Validated client-side via `File.size` check; rejected with `error_attachment_too_large` if oversize. SDK call: `client.messaging.sendNewMessage({account_id, recipient_id, text, attachments: File[]})`. **⚠️ See Open Question Q1 — the SDK method is `startNewChat` (not `sendNewMessage`) and attachments are `[filename, Buffer]` tuples, not `File[]`.**
- **D-24:** Verify-after-write: poll `getProfile.last_message_at` once at 5s mark, then once at 10s mark. **⚠️ See Open Question Q2 — `LinkedinUserProfileSchema` does NOT expose `last_message_at`. Alternative: poll `messaging.getAllMessagesFromChat` and check max `timestamp` where `is_sender===1`.**
- **D-25:** Audit row includes `recipient_degree`, `attachment_count`, `text_hash` (not raw text per D-07 GDPR pattern).

**linkedin_send_inmail (UNI-08)**
- **D-26:** Tool requires explicit `allow_inmail: true` param. Defaults to `false`. Refuses with `error_inmail_not_authorized` if missing.
- **D-27:** `max_inmail_credits` optional param caps the send (compares against `credits_remaining` from prior call, refuses if would exceed). Defaults to "no cap".
- **D-28:** Response envelope INCLUDES `credits_used` and `credits_remaining` (Unipile-returned). **⚠️ See Open Question Q3 — Unipile does NOT return credits on the send call; we must call `inmail_balance` before/after to derive these.**
- **D-29:** If account lacks Sales Nav / Premium → `error_inmail_requires_premium` (mapped from Unipile 403/422 with type `inmail_requires_premium`). NEW error enum member.

**linkedin_engage SUPER-TOOL (UNI-09)**
- **D-30:** Discriminated union return type with `action: 'sent_message'|'sent_connection'|'sent_inmail'|'skipped'`.
- **D-31:** Routing: degree=1 → send_message; degree=2|3 reachable → send_connection; out_of_network + allow_inmail → send_inmail; else skip.
- **D-32:** `dry_run: true` returns proposed action WITHOUT calling provider. Audit log records `result: 'dry_run'`.
- **D-33:** Dry-run skips rate-limit check but DOES write an audit row.

**linkedin_list_pending (UNI-10)**
- **D-34:** Returns `{invitation_id, recipient_profile_url, recipient_name, sent_at, age_days, has_note}` from `getAllInvitationsSent({account_id, since?})`. **⚠️ `since?` parameter does NOT exist in the SDK input type — see Section 3.**
- **D-35:** `older_than_days?` filter applied client-side after fetch.
- **D-36:** Default limit 100, max 500. Pagination via Unipile cursor.
- **D-37:** NOT destructive (read-only).

**Rate-limiter (UNI-11)**
- **D-38:** Per-account counters: `tenant:<id>:unipile:ratelimit:<account_id>:<tool>:<day>`. Format `{daily_used, weekly_used, last_reset_at}`. Daily reset at UTC midnight; weekly reset Monday UTC.
- **D-39:** Default caps: `LINKEDIN_DAILY_CONNECT_CAP=25`, `LINKEDIN_WEEKLY_CONNECT_CAP=100`, `LINKEDIN_DAILY_DM_CAP=50`, `LINKEDIN_DAILY_INMAIL_CAP=15`. Env-overridable via `KEBAB_UNIPILE_<METRIC>_CAP`.
- **D-40:** **Fail-closed by default**. Escape hatch: `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open`.
- **D-41:** Returns `{blocked, daily_used, daily_limit, retry_after?: ISO}` — never throws.
- **D-42/D-43:** Retrofit into `linkedin_send_connection` BEFORE dedup check. New audit result enum `error_rate_limit_kebab` (distinct from Unipile 429 `error_rate_limit`).

**Backlog from phase 68 live test**
- **D-44:** UNI-25 — extend `SLUG_RE` in `lib/identifiers.ts` to allow `\?[^/]*` suffix.
- **D-45:** UNI-26 — add `error_recipient_unreachable` (422 invalid_recipient) + `error_invalid_request` (400 invalid_parameters) to `lib/errors.ts`.

### Claude's Discretion
- Attachment validation: use native `Buffer.byteLength` (no new dep).
- `linkedin_engage` accepts `note?` param (recommend yes, passed only to send_connection branch).
- Error code naming: consistent `error_*` prefix across the 8 new enum members.

### Deferred Ideas (OUT OF SCOPE)
- Webhook ingress for `message.sent`/`new_message` — phase 70.
- WhatsApp tools — phase 70.
- Kill switches — phase 71.
- Metrics dashboard widgets — phase 71.
- `linkedin_warm_prospect` workflow — V2.
- Bulk operations — single-target only.
- InMail credit alerts — phase 71.
- Rate-limiter dashboard widget — phase 71.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UNI-07 | `linkedin_send_message` — 1st-degree DM only, attachments ≤15MB, verify-after-write 10s | §1 |
| UNI-08 | `linkedin_send_inmail` — explicit allow_inmail, credits tracking, Premium gating | §2 |
| UNI-09 | `linkedin_engage` super-tool with `dry_run` | §1 + §2 (routing reuses both) |
| UNI-10 | `linkedin_list_pending` — older_than_days filter, age_days computation | §3 |
| UNI-11 | Per-account rate-limiter, fail-closed | §4 |
| UNI-25 | URL query string normalization fix | §5 |
| UNI-26 | 4xx error mis-classification fix | §6/§7 |

---

## 1. Messaging API (send + verify)

**SDK methods [VERIFIED: `node_modules/unipile-node-sdk/dist/types/resources/messaging.resource.d.ts`]:**

```typescript
messaging.sendMessage(input: PostMessageInput): Promise<MessageSentResponse>
messaging.startNewChat(input: PostNewChatInput): Promise<ChatStartedApiResponse>
messaging.getAllMessagesFromChat(input: GetAllMessagesFromChatInput): Promise<MessageListApiResponse>
```

**Input shapes [VERIFIED: `dist/types/types/input/input-messaging.d.ts`]:**

```typescript
type PostMessageInput = {
  chat_id: string;           // REQUIRES existing chat
  text: string;
  thread_id?: string;
  attachments?: Array<[string, Buffer]>;  // tuple [filename, buffer]
};

type PostNewChatInput = {
  account_id: string;
  text: string;
  attendees_ids: string[];   // provider_ids of recipients
  subject?: string;
  attachments?: Array<[string, Buffer]>;
  options?: {
    linkedin?: { api?: 'classic'; inmail?: boolean }
             | { api: 'sales_navigator' }
             | { api: 'recruiter'; signature?: string; ... };
  };
};

type GetAllMessagesFromChatInput = {
  chat_id: string;
  cursor?: string;
  before?: string;
  after?: string;
  limit?: number;
  sender_id?: string;
};
```

**Response shapes:**
- `MessageSentResponse = { object: "MessageSent", message_id: string | null }`
- `ChatStartedApiResponse = { object: "ChatStarted", chat_id: string | null, message_id: string | null }`

**Key behavioral rules [CITED: developer.unipile.com/docs/send-messages]:**
- `sendMessage` requires a `chat_id` of an existing chat — fastest path, prefer when chat exists.
- `startNewChat` creates a new chat with one or more `attendees_ids`. **With LinkedIn (non-InMail), only 1st-degree relations are allowed** — server returns 422 if attempted on 2nd/3rd degree without inmail flag.
- If `chat_id` is unknown but you have a `provider_id`, use `startNewChat` — it will reuse the existing chat if one exists with that attendee, or create a new one.

**Recommended `linkedin_send_message` handler flow:**
1. Resolve `provider_id` via existing `resolveProviderId()` (KV cache + getProfile fallback).
2. Call `getProfile` to read `network_distance` — refuse with `error_not_connected` if not `FIRST_DEGREE` (D-22).
3. **Prefer `startNewChat`** (works whether or not a chat exists; the server returns the existing `chat_id` if one is present). Pass `attendees_ids: [provider_id]`, `text`, optional `attachments`.
4. Verify-after-write per §1.1 below.
5. Write audit row with `recipient_degree`, `attachment_count`, `text_hash` (D-25).

### 1.1 Verify-after-write for messages

**D-24 says poll `getProfile.last_message_at` — but [VERIFIED: `dist/types/users/ressource.types.d.ts` `LinkedinUserProfileSchema`] this field does NOT exist on the profile schema.** Available message-related fields on the profile: none. **Resolves to Open Question Q2.**

**Recommended alternative:** poll `messaging.getAllMessagesFromChat({chat_id, limit: 5})` at 5s and 10s. Each message item has `{is_sender: 0 | 1, timestamp: string (ISO)}` [VERIFIED: `MessageListApiResponseSchema`]. If `items[].some(m => m.is_sender === 1 && new Date(m.timestamp) >= requestStartAt)` → `verified: true`. Else `verified: false`.

**Edge case:** if `startNewChat` returned `chat_id: null` (rare race), skip polling and return `verified: false` with `error: 'unverified_timeout'`.

### 1.2 Attachment shape (D-23 correction)

**MCP tool schemas cannot transport `File` objects** (they're a Web/DOM type). The tool schema should accept:

```typescript
attachments?: z.array(z.object({
  filename: z.string().min(1).max(255),
  mimetype: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']),
  base64: z.string(),  // base64-encoded file bytes
})).max(5)
```

Decode and size-check server-side:
```typescript
const buffers = args.attachments?.map(a => {
  const buf = Buffer.from(a.base64, 'base64');
  if (buf.byteLength > 15 * 1024 * 1024) throw new Error('error_attachment_too_large');
  return [a.filename, buf] as [string, Buffer];
});
// Pass to SDK: { ..., attachments: buffers }
```

**Reasoning [VERIFIED]:** SDK's `PostMessageInput.attachments` and `PostNewChatInput.attachments` are typed as `Array<[string, Buffer]>` — Node Buffer, not Web File. Vercel lambda runtime is Node; there is no DOM.

---

## 2. InMail API (credits, premium gating)

**SDK does NOT expose a dedicated `sendInmail` method.** [VERIFIED: full `UsersResource` and `MessagingResource` class listings — no `sendInmail` member.] InMail is sent by **`messaging.startNewChat` with `options.linkedin.inmail = true`**:

```typescript
await client.messaging.startNewChat({
  account_id,
  text: bodyText,
  attendees_ids: [provider_id],
  subject: 'My subject',  // InMail benefits from a subject line
  options: { linkedin: { api: 'classic', inmail: true } },
});
```

### 2.1 Credit balance endpoint

**SDK does NOT expose a balance method either.** [VERIFIED: `grep -r inmail_balance dist/` returns nothing.] Use the SDK escape hatch:

```typescript
// Live-verified 2026-05-18 against api41.unipile.com:17153 for account eYRQtT4kTxq0Ns1XjP38MQ:
const balance = await client.request.send({
  path: '/linkedin/inmail_balance',
  method: 'GET',
  parameters: { account_id },
});
// Response:
// { object: "LinkedinInmailBalance", premium: null, recruiter: null, sales_navigator: 150 }
```

**Shape interpretation:**
- `premium: number | null` — InMail credits for LinkedIn Premium subscribers.
- `recruiter: number | null` — InMail credits for LinkedIn Recruiter accounts.
- `sales_navigator: number | null` — InMail credits for Sales Navigator accounts (live tenant shows 150).
- A `null` value means the account does NOT have that subscription tier active.

**Total balance** = sum of non-null values. **Account is InMail-eligible** if `premium || recruiter || sales_navigator` resolves to a non-null number > 0.

### 2.2 Recommended `linkedin_send_inmail` flow (D-26..D-29)

```text
1. Refuse if !args.allow_inmail → error_inmail_not_authorized
2. balanceBefore = GET inmail_balance(account_id)
   - if all three fields null → error_inmail_requires_premium (D-29)
3. totalAvailable = (balanceBefore.premium ?? 0) + (...recruiter) + (...sales_navigator)
   - if args.max_inmail_credits && totalAvailable < args.max_inmail_credits → error_inmail_cap_exceeded
   - (D-27 logic: cap is a "do not spend more than N credits this call" not "do not exceed N total")
4. Rate-limit check (LINKEDIN_DAILY_INMAIL_CAP, default 15)
5. Resolve provider_id, getProfile for can_send_inmail check
   - LinkedinUserProfileSchema exposes `can_send_inmail: boolean | undefined` [VERIFIED]
   - if can_send_inmail === false → error_inmail_recipient_not_eligible (recipient blocked Open Profile)
6. startNewChat with inmail:true
7. balanceAfter = GET inmail_balance(account_id)
   - credits_used = totalAvailable(before) - totalAvailable(after)
   - credits_remaining = totalAvailable(after)
   - If either call to balance fails post-send: log warning, return credits_used: null, credits_remaining: null (D-28 fallback)
8. Audit row with credits_used, credits_remaining, plus standard fields
9. Return envelope including credits_used and credits_remaining
```

### 2.3 Premium gating pre-flight

**Two pre-flight signals available, neither perfect:**
- **`client.account.getAll()`** returns each account's `connection_params.im.premiumFeatures` array. Live tenant for the LinkedIn account shows `premiumFeatures: ["sales_navigator"]`. Can short-circuit to `error_inmail_requires_premium` if array is empty/missing. [LIVE-VERIFIED 2026-05-18]
- **`inmail_balance` call** is the authoritative source — if all three fields are null, the account cannot send InMail.

Use `inmail_balance` as the gate (step 2 above). `premiumFeatures` is a cheaper hint but stale because it's cached at account-connect time.

---

## 3. List Pending Invitations (cursor, age_days)

**SDK method [VERIFIED: `users.resource.d.ts` line 28]:**
```typescript
users.getAllInvitationsSent(input: GetAllInvitationsSentInput): Promise<UserInvitationSentListApiResponse>
```

**Input [VERIFIED: `dist/types/users/user-invitation-sent-list.types.d.ts`]:**
```typescript
GetAllInvitationsSentInput = {
  account_id: string;
  limit?: number;    // int
  cursor?: string;
}
// ⚠️ NO `since`, `before`, `after`, or any date filter. D-34's `since?` parameter does NOT exist.
```

**Response shape [VERIFIED + LIVE-VERIFIED against api41.unipile.com:17153]:**
```typescript
{
  object: "InvitationList",
  items: Array<{
    object: "InvitationSent",
    id: string,                              // → invitation_id
    date: string,                            // "Sent yesterday" — HUMAN-READABLE, UNUSABLE for math
    parsed_datetime: string | null,          // ISO-8601 → USE THIS for age_days
    invitation_text: string | null,          // null when no note → has_note = (text !== null)
    invited_user: string | null,             // recipient name → recipient_name
    invited_user_id: string | null,          // recipient provider_id
    invited_user_public_id: string | null,   // slug → "https://linkedin.com/in/${slug}" → recipient_profile_url
    invited_user_description: string | null, // headline
    specifics?: { provider: "LINKEDIN", shared_secret: string },
    inviter?: { inviter_name, inviter_id, inviter_public_identifier, inviter_description }
  }>,
  cursor: string | null   // base64-encoded JSON {"limit": N, "cursor": N}; pass back for next page
}
```

**Live sample (5 invitations, account `eYRQtT4kTxq0Ns1XjP38MQ`, 2026-05-18):**
```json
{
  "items": [
    {
      "id": "7461918827820281856",
      "date": "Sent yesterday",
      "parsed_datetime": "2026-05-17T17:15:25.418Z",
      "invitation_text": null,
      "invited_user": "Guillaume Benoit",
      "invited_user_id": "ACoAAAPXf5MBn6HqZDmB8dmX3STpaKLcWFqW4yM",
      "invited_user_public_id": "guillaume-benoit-10370419"
    }
    // ... 4 more
  ],
  "cursor": "eyJsaW1pdCI6NSwiY3Vyc29yIjo1fQ=="  // base64({"limit":5,"cursor":5})
}
```

### 3.1 Recommended `linkedin_list_pending` flow

```typescript
async function handleLinkedinListPending(args: {
  account_id?: string;
  older_than_days?: number;  // CLIENT-side filter, D-35
  limit?: number;            // default 100, max 500
}) {
  const limit = Math.min(args.limit ?? 100, 500);
  const accountId = await resolveAccountId(args);  // reuse D-20 logic from phase 68
  const allItems: any[] = [];
  let cursor: string | null = null;
  do {
    const resp = await withRetry(() =>
      client.users.getAllInvitationsSent({
        account_id: accountId,
        limit: Math.min(limit - allItems.length, 100),  // Unipile per-page max ~100
        ...(cursor ? { cursor } : {}),
      })
    );
    allItems.push(...resp.items);
    cursor = resp.cursor;
  } while (cursor && allItems.length < limit);

  const now = Date.now();
  const filtered = allItems
    .filter(i => i.parsed_datetime !== null)  // can't compute age without ISO date
    .map(i => {
      const sentAt = i.parsed_datetime!;
      const ageDays = Math.floor((now - new Date(sentAt).getTime()) / 86_400_000);
      return {
        invitation_id: i.id,
        recipient_profile_url: i.invited_user_public_id
          ? `https://linkedin.com/in/${i.invited_user_public_id}`
          : null,
        recipient_name: i.invited_user,
        sent_at: sentAt,
        age_days: ageDays,
        has_note: i.invitation_text !== null && i.invitation_text.length > 0,
      };
    })
    .filter(i => args.older_than_days === undefined || i.age_days >= args.older_than_days);

  return { count: filtered.length, items: filtered };
}
```

**Notes:**
- Read-only — no audit row required (D-37). Optional: write a single `result: 'success'` audit row per call for observability, but it's not a strong design need.
- `parsed_datetime` can be `null` (rare — old/corrupt invitations). Filter these out rather than fail.
- Pagination: each page max 100 items per Unipile [VERIFIED LIVE]. Loop until `cursor === null` or `allItems.length >= limit`.

---

## 4. Rate-Limiter KV Pattern (fail-closed, reset windows)

**Existing analogue:** `src/core/rate-limit.ts` implements per-minute buckets with KV `incr`. Phase 69's needs are different (per-day, per-week, per-tool) but the pattern is reusable.

### 4.1 Key format (D-38)

```
unipile:ratelimit:<account_id>:<tool>:<day_bucket>:daily
unipile:ratelimit:<account_id>:<tool>:<week_bucket>:weekly
```

- `day_bucket` = `YYYY-MM-DD` (UTC) — derived from `new Date().toISOString().slice(0,10)`.
- `week_bucket` = `YYYY-W##` (ISO week, UTC) — Monday is week start per D-38.
- TenantKVStore auto-prefixes `tenant:<id>:` → full key e.g. `tenant:cadens_001:unipile:ratelimit:eYRQtT4kTxq0Ns1XjP38MQ:send_connection:2026-05-18:daily`.

**Why two keys per tool**: separate TTLs (daily key TTL = 36h to outlast UTC midnight rollover; weekly key TTL = 9 days). Atomic `incr` on each, no race window.

### 4.2 Cap configuration (D-39)

```typescript
const CAPS = {
  send_connection: {
    daily: getConfigInt('KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP', 25),
    weekly: getConfigInt('KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP', 100),
  },
  send_message: {
    daily: getConfigInt('KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP', 50),
    weekly: null,  // no weekly cap on DMs per ROADMAP UNI-11
  },
  send_inmail: {
    daily: getConfigInt('KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP', 15),
    weekly: null,
  },
};
```

### 4.3 API

```typescript
export interface RateLimitDecision {
  blocked: boolean;
  daily_used: number;
  daily_limit: number;
  weekly_used?: number;
  weekly_limit?: number;
  reason?: 'daily_cap' | 'weekly_cap' | 'kv_unavailable';
  retry_after?: string;  // ISO-8601 timestamp of next reset
}

export async function checkUnipileRateLimit(args: {
  account_id: string;
  tool: 'send_connection' | 'send_message' | 'send_inmail';
}): Promise<RateLimitDecision>;
```

**Never throws** (D-41). On KV failure → returns `{blocked: true, reason: 'kv_unavailable'}` unless `KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open` is set, in which case `{blocked: false, daily_used: 0, daily_limit, reason: 'kv_unavailable'}` with a logged warning.

### 4.4 Fail-closed semantics (D-40)

```typescript
try {
  const kv = getContextKVStore();
  const dailyCount = await kv.incr(dailyKey);  // atomic
  if (dailyCount === 1) await kv.expire(dailyKey, 36 * 3600);  // set TTL on first hit only
  // ... check against cap, also incr weekly key if applicable
} catch (err) {
  log.warn('Rate-limiter KV failure', { account_id, tool, err: toMsg(err) });
  const failMode = getConfig('KEBAB_UNIPILE_RATELIMIT_FAIL_MODE');
  if (failMode === 'open') {
    return { blocked: false, daily_used: 0, daily_limit, reason: 'kv_unavailable' };
  }
  return { blocked: true, daily_used: 0, daily_limit, reason: 'kv_unavailable',
           retry_after: new Date(Date.now() + 60_000).toISOString() };
}
```

### 4.5 retry_after computation

- Daily cap exceeded → next UTC midnight: `new Date(Date.UTC(y, m, d + 1, 0, 0, 0)).toISOString()`
- Weekly cap exceeded → next Monday UTC 00:00.

### 4.6 Critical integration ordering (D-43)

```text
linkedin_send_connection handler order (UPDATED FROM PHASE 68):
  1. Generate audit_id, compute params_hash
  2. → rateLimiter.check(account_id, 'send_connection')  [NEW]
     - if blocked: writeAuditRow(result: 'error_rate_limit_kebab'), return early
  3. Dedup check  [EXISTING]
  4. ResolveAccountId, resolveProviderId, sendInvitation, verify, audit
```

**Why rate-limit BEFORE dedup**: dedup is a KV read (1 RTT). Rate-limit is a KV `incr` (1 RTT). Both cheap, but rate-limit failures are operator-visible (they got caps hit) and dedup hits are LLM-visible (they were trying to spam). Block the spammer earliest. Also: a dedup hit should NOT consume rate-limit credit — so we need a way to either (a) decrement on dedup, or (b) check rate-limit then if dedup hits, decrement. Simpler design: **dedup BEFORE rate-limit** so a dedup hit doesn't burn quota.

**Decision required for planner**: order is dedup-first or rate-limit-first? CONTEXT says rate-limit first ("cheaper"), but I recommend **dedup first** because:
- Dedup is a cheap pure KV read
- Dedup hits should not consume daily quota (the LLM is retrying, not actually sending)
- If we incr the counter then dedup hits, we either have to decr (race-prone) or accept silent quota leak

Listed as Open Question Q4.

### 4.7 What counts toward the cap

- **Successful send** counts (1 invite/message/inmail = 1 unit).
- **Unipile error response** counts (we hit their API; LinkedIn may have started the action server-side).
- **`unverified_timeout`** counts (we sent but didn't confirm — pessimistic).
- **Dedup hit** does NOT count.
- **`dry_run` action in engage** does NOT count (D-33).
- **Pre-flight refusal** (`error_not_connected`, `error_inmail_not_authorized`, `error_attachment_too_large`) does NOT count — we never hit the provider.

---

## 5. SLUG_RE Update for D-44 (regex change + test cases)

**Current regex [VERIFIED: `src/connectors/unipile/lib/identifiers.ts:51`]:**
```typescript
const SLUG_RE =
  /^(?:https?:\/\/)?(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?$/;
```

**Bug:** Anchored `$` after optional `/` — rejects any URL with query string.

**Failing inputs from phase 68 live test (UNI-25):**
- `https://www.linkedin.com/in/john-doe?originalSubdomain=fr` → throws
- `https://linkedin.com/in/jane?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAA...` → throws
- `https://linkedin.com/in/bob?utm_source=newsletter&utm_campaign=q2` → throws

**Proposed regex (D-44):**
```typescript
const SLUG_RE =
  /^(?:https?:\/\/)?(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?(?:\?[^#/]*)?(?:#[^/]*)?$/;
```

**Changes:**
1. Add `(?:\?[^#/]*)?` — optional query string (anything except `#` and `/` until end or fragment).
2. Add `(?:#[^/]*)?` — optional URL fragment (rare but seen in some pasted URLs).
3. Both groups non-capturing so `match[1]` is still the slug.

**Required new test cases (D-44 says 3, recommend 5):**

| Input | Expected normalized output |
|-------|---------------------------|
| `https://www.linkedin.com/in/john-doe?originalSubdomain=fr` | `https://linkedin.com/in/john-doe` |
| `https://linkedin.com/in/jane?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAA` | `https://linkedin.com/in/jane` |
| `https://linkedin.com/in/bob?utm_source=newsletter&utm_campaign=q2` | `https://linkedin.com/in/bob` |
| `https://fr.linkedin.com/in/marie?originalSubdomain=fr` (locale + query) | `https://linkedin.com/in/marie` |
| `https://linkedin.com/in/alice/#contact-info` (fragment) | `https://linkedin.com/in/alice` |

**Implementation discipline (per phase 68 anti-ReDoS comment in identifiers.ts):**
- Verify the new groups don't enable catastrophic backtracking. `[^#/]*` is a simple char class, bounded by `$` or fragment marker — safe.
- Add a `it('rejects nested slashes in query')` test: `linkedin.com/in/foo?bar=/baz/qux` should still parse (the query value contains `/` — but our regex uses `[^#/]*` which forbids `/` in query). **Open Question Q5 — should query string be allowed to contain `/`?** LinkedIn's real URLs sometimes have URL-encoded slashes (`%2F`) which our regex accepts fine; raw `/` in query is unusual. Recommend keeping the strict `[^#/]*` for safety.

**Normalization function update:** `normalizeProfileUrl` strips query/fragment by design — the canonical form is `https://linkedin.com/in/<slug>` only. No change needed to the slug extraction logic.

---

## 6. New AuditResult Enum Members (D-23..D-45)

**Current [VERIFIED: `src/connectors/unipile/lib/audit.ts:42-48`]:**
```typescript
export type AuditResult =
  | "success"
  | "unverified_timeout"
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx";
```

**Net-new members for phase 69 (alphabetical):**

| New member | From decision | Used by tool(s) | Trigger |
|------------|--------------|-----------------|---------|
| `dry_run` | D-32 | linkedin_engage | `args.dry_run === true` — proposed action recorded without execution |
| `error_attachment_too_large` | D-23 | send_message, send_inmail (via engage) | Any attachment Buffer > 15 MB |
| `error_inmail_not_authorized` | D-26 | send_inmail | `allow_inmail !== true` |
| `error_inmail_requires_premium` | D-29 | send_inmail | `inmail_balance` returns all-null OR Unipile 403/422 `type: inmail_requires_premium` |
| `error_invalid_request` | D-45 (UNI-26) | classifyUnipileError | Unipile 400 with `type: invalid_parameters` |
| `error_rate_limit_kebab` | D-43 | ALL writes incl. retrofit | Kebab rate-limiter blocks (vs Unipile's own 429 → `error_rate_limit`) |
| `error_recipient_unreachable` | D-45 (UNI-26) | classifyUnipileError | Unipile 422 with `type: invalid_recipient` |

**Recommended bonus (Claude's discretion):**
- `error_inmail_recipient_not_eligible` — when `getProfile.can_send_inmail === false` (recipient blocked Open Profile / not InMail-eligible). Distinct from "no premium" (sender problem) vs "recipient blocked" (recipient problem).
- `error_inmail_cap_exceeded` — when `args.max_inmail_credits` is set and would be exceeded. Distinct from `error_rate_limit_kebab` (which is the per-day cap).

**Total new members: 7 (CONTEXT-mandated) + 2 (recommended) = 9.**

**Updated full enum:**
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
  // Phase 69 — Claude's discretion (recommended)
  | "error_inmail_recipient_not_eligible"
  | "error_inmail_cap_exceeded";
```

**Test verification:** `lib/__tests__/audit.test.ts` already has a test that asserts the enum does NOT contain `"pending"` (T-68-04-04). Add a parallel test that asserts the enum includes each new member.

---

## 7. New UnipileError Subclasses (D-29/D-44/D-45)

**Current [VERIFIED: `src/connectors/unipile/lib/errors.ts`]:**
- `UnipileRateLimitError`
- `UnipileAccountRestrictedError`
- `UnipileNotConnectedError`
- `Unipile5xxError`
- `classifyUnipileError(err) → UnipileErrorResult`

### 7.1 New error subclasses

```typescript
export class UnipileInmailNotAuthorizedError extends McpToolError {
  // D-26: allow_inmail !== true (operator-side gate, not Unipile)
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

export class UnipileInmailRequiresPremiumError extends McpToolError {
  // D-29: account lacks Premium / Sales Nav / Recruiter
  constructor(msg: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.AUTH_FAILED,
      toolName: "unipile",
      message: msg,
      userMessage: "This LinkedIn account does not have InMail credits. Upgrade to Premium, Sales Navigator, or Recruiter.",
      retryable: false,
      cause: opts?.cause,
      recovery: "Use linkedin_send_connection (free) or upgrade the LinkedIn account.",
    });
    this.name = "UnipileInmailRequiresPremiumError";
  }
}

export class UnipileRecipientUnreachableError extends McpToolError {
  // D-45 (UNI-26): 422 invalid_recipient
  constructor(msg: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.NOT_FOUND,
      toolName: "unipile",
      message: msg,
      userMessage: "Recipient is not reachable from this LinkedIn account (out of network, deleted, or privacy-blocked).",
      retryable: false,
      cause: opts?.cause,
      recovery: "Verify the profile URL or try a different account that may be connected.",
    });
    this.name = "UnipileRecipientUnreachableError";
  }
}

export class UnipileInvalidRequestError extends McpToolError {
  // D-45 (UNI-26): 400 invalid_parameters
  constructor(msg: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      toolName: "unipile",
      message: msg,
      userMessage: "Request to LinkedIn was malformed (invalid parameters).",
      retryable: false,
      cause: opts?.cause,
      recovery: "Check the profile URL format, note length (≤300 chars), and attachment count (≤5).",
    });
    this.name = "UnipileInvalidRequestError";
  }
}

export class UnipileAttachmentTooLargeError extends McpToolError {
  // D-23: attachment > 15 MB
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

### 7.2 Updated `classifyUnipileError`

```typescript
export function classifyUnipileError(err: unknown): UnipileErrorResult {
  if (!(err instanceof UnsuccessfulRequestError)) return "error_unipile_5xx";
  const body = (err.body ?? {}) as { status?: unknown; type?: unknown };
  const status = typeof body.status === "number" ? body.status : 0;
  const type = typeof body.type === "string" ? body.type : "";

  if (status === 429) return "error_rate_limit";
  if (status === 422 && type.includes("cannot_resend")) return "error_rate_limit";
  if (status === 422 && type.includes("invalid_recipient")) return "error_recipient_unreachable";  // D-45
  if (status === 422 && type.includes("inmail_requires_premium")) return "error_inmail_requires_premium";  // D-29
  if (status === 400 && type.includes("invalid_parameters")) return "error_invalid_request";  // D-45
  if (status === 401 || status === 403) {
    if (type.includes("inmail_requires_premium")) return "error_inmail_requires_premium";  // D-29 also 403
    return "error_account_restricted";
  }
  if (status === 404) return "error_not_connected";
  if (status >= 500) return "error_unipile_5xx";
  return "error_unipile_5xx";
}
```

**UnipileErrorResult union must extend to:**
```typescript
export type UnipileErrorResult =
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  | "error_recipient_unreachable"     // NEW D-45
  | "error_invalid_request"            // NEW D-45
  | "error_inmail_requires_premium";   // NEW D-29
```

**Test additions for `lib/__tests__/errors.test.ts`:**
- `400 invalid_parameters → error_invalid_request`
- `422 invalid_recipient → error_recipient_unreachable`
- `422 inmail_requires_premium → error_inmail_requires_premium`
- `403 inmail_requires_premium → error_inmail_requires_premium` (variant)
- Each new error class: name, retryable flag, recovery string present

---

## 8. Open Questions for Planner

**Q1 — Attachment shape conflict with D-23 [HIGH IMPACT].** D-23 specifies `attachments: File[]` (browser type). The SDK [VERIFIED] uses `Array<[string, Buffer]>` (Node type). MCP tool schemas can't transport `File` directly. **Recommendation: rewrite the schema to accept `{filename, mimetype, base64}` objects, decode to Buffer server-side. Risk to phase 69 plan: minor — adds ~10 lines of decode/validate, but the CONTEXT D-23 wording is incorrect and the planner should update it.**

**Q2 — `last_message_at` does not exist on `LinkedinUserProfileSchema` [HIGH IMPACT].** D-24's verify-after-write strategy is technically impossible. **Recommendation: use `messaging.getAllMessagesFromChat({chat_id, limit: 5})` and check max `timestamp` where `is_sender === 1 && timestamp >= request_start_at`. Edge case: if `startNewChat` returned `chat_id: null`, skip polling and return `verified: false`.**

**Q3 — InMail credits are NOT returned by the send call [HIGH IMPACT].** D-28's "Unipile-returned `credits_used` + `credits_remaining`" is wrong; the SDK call returns `ChatStartedApiResponse = {object, chat_id, message_id}` only. **Recommendation: call `inmail_balance` BEFORE and AFTER the send; derive `credits_used = totalBefore - totalAfter`, `credits_remaining = totalAfter`. Adds 2 extra HTTP calls per send (~200ms latency overhead). Acceptable: InMail sends are rare and high-stakes — accurate accounting matters.**

**Q4 — Rate-limit-then-dedup OR dedup-then-rate-limit ordering [MEDIUM IMPACT].** D-42 says "rate-limit check added BEFORE dedup check (cheaper)". I disagree: dedup hits should NOT consume daily quota, so dedup-first is safer (avoids the need to decrement on dedup hit, which is race-prone). **Recommendation: planner re-confirms with user, or pick dedup-first based on the "quota leak" argument above.**

**Q5 — SLUG_RE: should query string be allowed to contain raw `/`? [LOW IMPACT].** Proposed regex uses `[^#/]*` which forbids `/` in query. LinkedIn URLs in the wild are URL-encoded (`%2F`), so this is safe. **Recommendation: keep `[^#/]*` and ship 5 tests as listed in §5.**

**Q6 — Two recommended bonus enum members [LOW IMPACT].** `error_inmail_recipient_not_eligible` and `error_inmail_cap_exceeded` are NOT in CONTEXT but improve operator observability. **Recommendation: planner asks user, or accepts as Claude's discretion (it's listed there).**

**Q7 — Does phase 69 need a separate `inmail_balance` cache? [LOW IMPACT].** Two API calls per InMail send is fine at Cadens scale (~15 InMails/day). At higher scale, cache `inmail_balance` for 5 minutes per account. **Recommendation: phase 69 does NOT cache; revisit if metrics show >50 InMails/day per account in production.**

**Q8 — Retrofit testing of `linkedin_send_connection` [MEDIUM IMPACT].** Adding rate-limiter to the existing tool changes its envelope (new field `blocked_by_rate_limit: true`, new error `error_rate_limit_kebab`). Existing phase 68 integration tests will pass (rate-limiter returns `blocked: false` with default caps), but the planner must add a NEW test that exercises the blocked path. **Recommendation: include in the retrofit task.**

---

## Source Verification Summary

| Section | Source | Confidence |
|---------|--------|------------|
| §1 SDK messaging methods | `node_modules/unipile-node-sdk/dist/types/resources/messaging.resource.d.ts` + `dist/types/types/input/input-messaging.d.ts` | HIGH (file inspection) |
| §1.1 `last_message_at` absence | `dist/types/users/ressource.types.d.ts` `LinkedinUserProfileSchema` | HIGH (file inspection, full schema enumerated) |
| §1.1 Message `timestamp` + `is_sender` | `dist/types/messaging/messages/message-list.types.d.ts` | HIGH (file inspection) |
| §2 InMail mechanism (startNewChat + inmail) | `input-messaging.d.ts:49-65` `LinkedinClassicPostNewChatInputOptions` | HIGH (file inspection) |
| §2.1 `inmail_balance` endpoint + response shape | Live curl 2026-05-18 against `api41.unipile.com:17153` | HIGH (live API verified) |
| §2.3 `premiumFeatures` field on accounts | Live curl 2026-05-18 `/api/v1/accounts` | HIGH (live API verified) |
| §3 `getAllInvitationsSent` response shape | `dist/types/users/user-invitation-sent-list.types.d.ts` + live curl 2026-05-18 | HIGH (file + live) |
| §3 No `since` parameter | `GetAllInvitationsSentInput` type — only `account_id`, `limit`, `cursor` | HIGH (file inspection) |
| §3 Cursor format `{limit, cursor}` base64 | Live curl returned `eyJsaW1pdCI6NSwiY3Vyc29yIjo1fQ==` → decoded `{"limit":5,"cursor":5}` | HIGH (live verified) |
| §4 KV `incr` + `expire` pattern | `src/core/rate-limit.ts` lines 90-130 | HIGH (codebase pattern) |
| §5 Current SLUG_RE | `src/connectors/unipile/lib/identifiers.ts:51` | HIGH (file inspection) |
| §6/§7 New enums + classes | CONTEXT.md D-23..D-45 + existing audit.ts/errors.ts | HIGH (decisions explicit, code patterns established in phase 68) |
| Q1 attachment shape mismatch | SDK type vs CONTEXT D-23 | HIGH (SDK file verified, CONTEXT decision text quoted) |
| Q3 InMail credits not in response | `MessageSentResponseSchema` + `ChatStartedApiResponseSchema` have no credit fields | HIGH (file inspection) |

## Assumptions Log

All factual claims in this research are either **[VERIFIED]** (read from SDK source files I inspected) or **[LIVE-VERIFIED]** (curl against the provided live tenant). Two minor `[ASSUMED]` claims:

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Unipile 422 error `type` strings (`invalid_recipient`, `inmail_requires_premium`, etc.) match the documented patterns | §7.2 classifyUnipileError | If the actual `type` strings differ, the classifier falls through to `error_unipile_5xx` (fail-safe). Mitigation: phase 69 integration tests can mock the exact strings; live smoke test will surface real values. |
| A2 | `inmail_balance` endpoint is stable and the response shape is consistent across Premium/Recruiter/Sales Nav accounts | §2.1 | If the response shape varies by subscription tier (e.g., extra fields), our `(premium ?? 0) + (recruiter ?? 0) + (sales_navigator ?? 0)` sum still works — extra fields are ignored. Low risk. |

## RESEARCH COMPLETE
