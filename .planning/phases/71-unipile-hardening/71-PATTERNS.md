# Phase 71: Unipile Hardening — Pattern Map

**Mapped:** 2026-05-19
**Files analyzed:** 11 (3 new admin routes + 4 write-tool MODs + 2 lib MODs + 3 doc/test MODs + 1 new doc)
**Analogs found:** 10 / 11 (`docs/connectors/unipile.md` has no per-connector doc precedent — `docs/connectors/` dir does NOT exist yet)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `app/api/admin/metrics/unipile-quotas/route.ts` | admin route (GET, scoped) | request-response (KV read) | `app/api/admin/metrics/requests/route.ts` + `app/api/admin/metrics/ratelimit/route.ts` | exact |
| `app/api/admin/metrics/unipile-quotas/summary/route.ts` | admin route (GET, aggregate scan) | request-response (KV scan) | `app/api/admin/metrics/ratelimit/route.ts` | exact |
| `app/api/admin/audit/unipile/route.ts` | admin route (GET, scoped, cursor paginated) | request-response (KV scan) | `app/api/admin/metrics/ratelimit/route.ts` (scan) + `app/api/admin/unipile/cache/urn/route.ts` (auth + URL param) | role-match |
| `src/connectors/unipile/tools/linkedin-send-connection.ts` (MOD) | tool handler (write) — Step -1 insertion | request-response | self (existing Step 0a/0b pattern) | exact (in-place addition) |
| `src/connectors/unipile/tools/linkedin-send-message.ts` (MOD) | tool handler (write) — Step -1 insertion | request-response | `linkedin-send-connection.ts` (sibling) | exact |
| `src/connectors/unipile/tools/linkedin-send-inmail.ts` (MOD) | tool handler (write) — Step -1 insertion | request-response | `linkedin-send-connection.ts` (sibling) | exact |
| `src/connectors/unipile/tools/linkedin-engage.ts` (MOD) | tool handler (write super-tool) — Step -1 insertion | request-response | `linkedin-send-connection.ts` (sibling) | exact |
| `src/connectors/unipile/manifest.ts` (MOD) | manifest — extend `testConnection()` envelope | n/a | self (existing `probe()` shape) | exact (in-place addition) |
| `src/connectors/unipile/lib/audit.ts` (MOD) | enum extension — add `error_writes_disabled` member | n/a | self (Phase 70 D-78 precedent — 3 members added in identical shape) | exact |
| `tests/contract/kv-allowlist.test.ts` (MOD) | contract test — 2 NEW ALLOWLIST entries | n/a | self (Phase 70 entries lines 103-116) | exact |
| `.env.example` (MOD) | config doc | n/a | self (existing `MYMCP_DISABLE_*` block at lines 152-160 + Unipile block at lines 328-339) | exact |
| `docs/CONNECTORS.md` (MOD) | docs index (Conventions Reference — not a per-connector index) | n/a | self (conventions file, NOT a tool catalog) | **misalignment — see deviation** |
| `docs/connectors/unipile.md` (NEW) | per-connector doc | n/a | **NONE — `docs/connectors/` dir does not exist** | **no analog** |

---

## Pattern Assignments

### `app/api/admin/metrics/unipile-quotas/route.ts` (NEW — GET admin route, per-account/per-tool quota read)

**Analog:** `app/api/admin/metrics/requests/route.ts` (lines 16-42) for the **scoped-admin handler shape**, and `src/connectors/unipile/lib/rate-limiter.ts` (lines 87-127) for the **KV key format** the metrics endpoint reads.

**Imports + handler shape** (`requests/route.ts:16-42`):
```typescript
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { getCurrentTenantId } from "@/core/request-context";

async function handler(ctx: PipelineContext) {
  const url = new URL(ctx.request.url);
  const accountId = url.searchParams.get("account_id");
  const toolParam = url.searchParams.get("tool"); // e.g. "send_connection"
  if (!accountId) {
    return NextResponse.json({ error: "account_id required" }, { status: 400 });
  }
  // ... read KV counters, build response ...
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, max-age=30" }, // phase 53 cache pattern
  });
}
export const GET = withAdminAuth(handler);
```

**KV key reconstruction pattern** (mirror `rate-limiter.ts:163-164`, but use `getContextKVStore()` since this is tenant-scoped read):
```typescript
// In phase 71 metrics route — tenant-scoped read (NOT the root-scope ratelimit escape hatch).
// Reuse the bucket helpers from rate-limiter.ts (extract them or duplicate inline).
const dailyKey   = `unipile:ratelimit:${accountId}:${tool}:${dailyBucket()}:daily`;
const weeklyKey  = `unipile:ratelimit:${accountId}:${tool}:${isoWeekBucket()}:weekly`;
const kv = getContextKVStore();
const [dailyRaw, weeklyRaw] = await Promise.all([kv.get(dailyKey), kv.get(weeklyKey)]);
const daily_used  = dailyRaw  ? parseInt(dailyRaw, 10)  || 0 : 0;
const weekly_used = weeklyRaw ? parseInt(weeklyRaw, 10) || 0 : 0;
```

**Cap lookup** (call `getCaps(tool)` — already exported pattern in `rate-limiter.ts:87-105`; either re-export `getCaps()` from there or duplicate the env-var keys inline).

**Response shape (per D-90):**
```typescript
return NextResponse.json({
  account_id: accountId,
  tool,
  daily_used,
  daily_limit,
  weekly_used,                   // omit when caps.weekly === null (send_message, send_inmail)
  weekly_limit,                  // same
  reset_at: nextUtcMidnight(),   // weekly_cap → nextMondayUtc()
  percent_used: daily_limit > 0 ? Math.round((daily_used / daily_limit) * 100) : 0,
});
```

**Deviation notes:**
- This route is **tenant-scoped via `getContextKVStore()`** — does NOT need an ALLOWLIST entry. (`requests/route.ts` is the analog for scoped admin; the `ratelimit/route.ts` precedent uses raw `getKVStore()` because of `?scope=all` — phase 71 does NOT replicate that escape hatch per D-96.)
- The 30s `Cache-Control: private, max-age=30` per phase 53 is the documented pattern for admin metrics endpoints (CONTEXT.md "Established Patterns" line 132).
- Reuse `getCaps()`, `dailyBucket()`, `isoWeekBucket()`, `nextUtcMidnight()`, `nextMondayUtc()` from `src/connectors/unipile/lib/rate-limiter.ts` — DO NOT re-derive. The plan must either export those helpers (preferred — single source of truth) or import them as `export *` from rate-limiter.

---

### `app/api/admin/metrics/unipile-quotas/summary/route.ts` (NEW — GET admin route, aggregate matrix)

**Analog:** `app/api/admin/metrics/ratelimit/route.ts` (entire file — same scan pattern, same shape)

**KV scan pattern** (`ratelimit/route.ts:44-71`):
```typescript
const rawKV = getKVStore();      // OR getContextKVStore() per D-96 — see deviation
const rlKeys = await kvScanAll(rawKV, "unipile:ratelimit:*");

interface ActiveBucket {
  key: string;
  accountId: string;
  tool: string;
  window: "daily" | "weekly";
}
const active: ActiveBucket[] = [];
for (const key of rlKeys) {
  // key format: `unipile:ratelimit:<account_id>:<tool>:<bucket>:<window>`
  const parts = key.split(":");
  if (parts.length !== 6) continue;
  const [, , accountId, tool, bucket, window] = parts;
  if (window !== "daily") continue; // summary table = current-day view
  if (bucket !== dailyBucket()) continue;
  active.push({ key, accountId, tool, window });
}

const readKeys = active.map((a) => a.key);
const values: (string | null)[] =
  typeof rawKV.mget === "function"
    ? await rawKV.mget(readKeys)
    : await Promise.all(readKeys.map((k) => rawKV.get(k)));
```

**Response shape (per D-91):**
```typescript
const rows = active.map((a, i) => {
  const daily_used = values[i] ? parseInt(values[i]!, 10) || 0 : 0;
  const { daily: daily_limit } = getCaps(a.tool as UnipileRateLimitedTool);
  return {
    account_id: a.accountId,
    tool: a.tool,
    daily_used,
    daily_limit,
    percent_used: daily_limit > 0 ? Math.round((daily_used / daily_limit) * 100) : 0,
  };
}).sort((a, b) => b.percent_used - a.percent_used);

return NextResponse.json({ rows });
```

**Deviation notes:**
- Per D-96: this is **tenant-scoped** — use `getContextKVStore()` NOT raw `getKVStore()`. The on-disk keys are already prefixed `tenant:<id>:unipile:ratelimit:...`, so `kvScanAll(getContextKVStore(), "unipile:ratelimit:*")` returns ONLY the current tenant's buckets. No `?scope=all` escape hatch in phase 71. **This means NO kv-allowlist entry needed for this file.**
- The 30s cache header pattern applies here too (`Cache-Control: private, max-age=30`).

---

### `app/api/admin/audit/unipile/route.ts` (NEW — GET admin route, cursor-paginated audit query)

**Analogs:**
- KV scan + filter: `app/api/admin/metrics/ratelimit/route.ts:44-86`
- Admin auth + URL query parsing: `app/api/admin/unipile/cache/urn/route.ts:45-62`
- Existing audit shape + bounded-scan helper: `src/connectors/unipile/lib/audit.ts:231-262` (`findAuditByProviderId` — same scan-and-filter idiom you'll generalize)

**Handler skeleton (combine analogs):**
```typescript
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { getContextKVStore } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";
import type { AuditRow, AuditResult } from "@/connectors/unipile/lib/audit";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function handler(ctx: PipelineContext) {
  try {
    const url = new URL(ctx.request.url);
    const accountId = url.searchParams.get("account_id");
    const since = url.searchParams.get("since");         // ISO-8601
    const tool = url.searchParams.get("tool");
    const resultFilter = url.searchParams.get("result"); // AuditResult member
    const cursor = url.searchParams.get("cursor");
    const limitRaw = url.searchParams.get("limit");
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, limitRaw ? parseInt(limitRaw, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT)
    );

    const startAfterId = cursor ? Buffer.from(cursor, "base64").toString("utf-8") : null;

    const kv = getContextKVStore();
    const keys = await kv.list("unipile:audit:");
    // Skip dedup pointers (mirror findAuditByProviderId pattern)
    const rowKeys = keys.filter((k) => !k.includes(":hash:"));
    // Cursor: skip until we pass startAfterId. Keys themselves aren't sorted —
    // we must load + sort by row.timestamp DESC. For O(n) at Cadens scale this
    // is fine (~12k rows/year/tenant, D-97).

    const items: AuditRow[] = [];
    for (const key of rowKeys) {
      const raw = await kv.get(key);
      if (!raw) continue;
      let row: AuditRow;
      try { row = JSON.parse(raw) as AuditRow; } catch { continue; }
      // Filters (all ANDed, all optional)
      if (accountId && row.account_id !== accountId) continue;
      if (tool && row.tool !== tool) continue;
      if (resultFilter && row.result !== resultFilter) continue;
      if (since && row.timestamp < since) continue;
      items.push(row);
    }
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Cursor slice
    let startIdx = 0;
    if (startAfterId) {
      const found = items.findIndex((r) => r.audit_id === startAfterId);
      startIdx = found >= 0 ? found + 1 : 0;
    }
    const page = items.slice(startIdx, startIdx + limit);
    const nextCursor = items.length > startIdx + limit && page.length > 0
      ? Buffer.from(page[page.length - 1]!.audit_id, "utf-8").toString("base64")
      : null;

    return NextResponse.json(
      { items: page, cursor: nextCursor, total_estimate: items.length },
      { headers: { "Cache-Control": "private, max-age=10" } }
    );
  } catch (err) {
    return NextResponse.json({ error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(handler);
```

**Deviation notes:**
- Per D-96: **tenant-scoped via `getContextKVStore()`** — does NOT need an ALLOWLIST entry. (The `account_id` filter param scopes WITHIN the tenant's rows, not across tenants.)
- The cursor is a base64-encoded `audit_id` (D-95). Decoded server-side, used to find the next page boundary. Simple — no offset, no inclusive/exclusive ambiguity issues since `audit_id` is a UUID v4 (unique within tenant).
- The "skip dedup pointers" line (`if (k.includes(":hash:")) continue`) mirrors `findAuditByProviderId` (audit.ts:243) — same defensive pattern; otherwise the result page double-counts every audit row.
- `total_estimate` is the unfiltered match count BEFORE pagination — useful for dashboards to show "Page X of N". Marked optional in D-93 because at very large scales this would be expensive (not the case at Cadens scale per D-97).
- Use `Cache-Control: private, max-age=10` (shorter than the 30s on metrics because audit data is operator-debug-relevant and freshness matters more).

---

### `src/connectors/unipile/tools/linkedin-send-connection.ts` (MOD — add Step -1 kill-switch check)

**Analog:** the same file's existing Step 0a/0b pattern (lines 206-273) is the exact shape Step -1 follows.

**Where to insert** (immediately AFTER `auditId`/`profileUrlNormalized`/`paramsHash` setup at lines 187-204, BEFORE the `Step 0a: ACCOUNT-RESOLVE` block at line 206):

```typescript
import { getConfig } from "@/core/config-facade";
// ... existing imports ...

export async function handleLinkedinSendConnection(args: SendArgs): Promise<ToolResult> {
  const auditId = generateAuditId();
  const profileUrlNormalized = /* ... existing block ... */;
  const paramsHash = computeParamsHash({ /* ... existing ... */ });

  // ═══════ Step -1: KILL-SWITCH (D-86/D-87/D-88/D-89 — highest priority) ═══════
  // Global kill switch — set by operator to halt ALL LinkedIn writes at once.
  // Checked via getConfig() (NOT process.env direct) so per-request hydration
  // picks up runtime env changes on the next call (D-89).
  // Reads BEFORE account-resolve so we don't waste a Unipile API call enumerating
  // accounts when writes are globally disabled. NO accountId is known yet — the
  // audit row's account_id field stays "" (matches the D-20 account-resolve error
  // path's existing pattern at line 221).
  const killSwitch = getConfig("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED")
                  ?? getConfig("LINKEDIN_TOOLS_DISABLED"); // legacy alias per D-86
  if (killSwitch === "true" || killSwitch === "1") {
    await writeAuditRow({
      audit_id: auditId,
      actor_user_id: args.actor_user_id,
      tool: "linkedin_send_connection",
      account_id: args.account_id ?? "",
      params_hash: paramsHash,
      result: "error_writes_disabled",  // NEW enum member added in audit.ts MOD
      verified: false,
      dedup_hit: false,
      timestamp: new Date().toISOString(),
    });
    log.warn("[CONNECTOR:unipile] send_connection refused — writes disabled by kill switch", {
      env_var: "KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED",
    });
    return envelope({
      provider_ok: false,
      verified: false,
      crm_sync: "pending",
      dedup_hit: false,
      audit_id: auditId,
      error: "error_writes_disabled",
    });
  }

  // ═══════ Step 0a: ACCOUNT-RESOLVE ═══════
  // ... existing code unchanged ...
}
```

**Deviation notes:**
- Use `getConfig()` from `@/core/config-facade` — never `process.env` direct (D-89 + ESLint rule `kebab/no-direct-process-env`).
- Legacy alias `LINKEDIN_TOOLS_DISABLED` accepted per D-86 (operator backward-compat). If both are set, `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` wins (??-coalesce order).
- Truthy values: `"true"` and `"1"` only — explicit list, no `Boolean(killSwitch)` coercion (an empty string is "set but disabled" in many ops conventions).
- Audit row's `account_id` is `""` (empty) because Step -1 runs BEFORE Step 0a account-resolve. Same handling as the D-20 error-path at line 221 — already-precedented in the codebase.
- `result: "error_writes_disabled"` — NEW enum member that gets added in the `lib/audit.ts` MOD (see below). The contract test in `manifest.test.ts` may need a small update too if it enumerates AuditResult.
- Envelope SHAPE matches existing halt-flag envelope — `provider_ok: false`, `crm_sync: "pending"` literal, no `reason`/`halted_at` (those are halt-flag specific).
- The `log.warn` mirrors the halt-flag log style at line 257.

---

### `src/connectors/unipile/tools/linkedin-send-message.ts` / `-send-inmail.ts` / `-engage.ts` (MOD — same Step -1)

**Analog:** the `linkedin-send-connection.ts` Step -1 block above is the canonical pattern. Each of the 3 sibling files inserts the **same** Step -1 block at the same logical position (immediately before Step 0a account-resolve, after `auditId`/`paramsHash` setup).

**Where to insert per file:**
- `linkedin-send-message.ts` → before line 262 (`Step 0a: ACCOUNT-RESOLVE`)
- `linkedin-send-inmail.ts` → before the existing Step 0a block (search for `Step 0a:` or `resolveAccountId(` call)
- `linkedin-engage.ts` → before the existing Step 0a block (line precedes `readHaltFlag(accountId)` at line 279)

**Per-file differences:**
- `tool` literal in the audit row + log message changes per file (`"linkedin_send_message"`, `"linkedin_send_inmail"`, `"linkedin_engage"`).
- `engage` may need additional envelope fields populated (e.g., `routed_to`, `dry_run`) — match the existing halt-flag envelope shape in each file rather than copy-pasting from `send-connection`.

**Deviation notes:**
- DRY consideration: a `checkKillSwitch()` helper in `src/connectors/unipile/lib/kill-switch.ts` would eliminate 4× duplication. Recommended structure:
  ```typescript
  // src/connectors/unipile/lib/kill-switch.ts (NEW — Claude's discretion)
  import { getConfig } from "@/core/config-facade";
  export function isWritesDisabled(): boolean {
    const v = getConfig("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED")
           ?? getConfig("LINKEDIN_TOOLS_DISABLED");
    return v === "true" || v === "1";
  }
  ```
  Each tool then does `if (isWritesDisabled()) { /* write audit + return envelope */ }`. Planner should weigh: 4 identical 25-line blocks (copy-paste, easier diff review) vs. 1 helper + 4 callsites (DRY). Phase 70's `readHaltFlag` precedent is "helper in lib/", suggesting the same here.
- The `manifest.ts` MOD (below) will ALSO call `isWritesDisabled()` from `testConnection()` — so the helper is justified even at 1 callsite.

---

### `src/connectors/unipile/manifest.ts` (MOD — extend `testConnection()` to surface `writes_disabled`)

**Analog:** the existing `probe()` function inside the same file (lines 78-112) is the structure to extend.

**Code to extend** (manifest.ts:78-112 — modify `probe()` return shape):
```typescript
import { isWritesDisabled } from "./lib/kill-switch"; // see Claude's discretion above

async function probe(
  dsn: string,
  token: string
): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
  writes_disabled?: boolean; // NEW — surfaced in /config → Connectors tile
}> {
  const writes_disabled = isWritesDisabled();
  // ... existing client.account.getAll() probe unchanged ...
  if (linkedinCount >= 1) {
    return {
      ok: true,
      message: writes_disabled
        ? `Connected — ${linkedinCount} LinkedIn account(s) — ⚠ writes disabled`
        : `Connected — ${linkedinCount} LinkedIn account(s)`,
      writes_disabled,
    };
  }
  // ... existing failure paths add `writes_disabled` to their return shapes too ...
}
```

**TestConnectionResult type extension** (`src/core/types.ts:112-118`):
```typescript
// MOD — add optional writes_disabled field per D-88 + Claude's discretion ("writes_disabled" naming)
export interface TestConnectionResult {
  ok: boolean;
  message: string;
  detail?: string;
  writes_disabled?: boolean; // NEW — connector-specific health-state extension
}
```

**Deviation notes:**
- Per D-88: the kill-switch state is part of the connector aggregate health — visible in `/config → Connectors` tile.
- Per D-89: read via `getConfig()` (NOT `process.env`).
- The `writes_disabled` field is OPTIONAL on `TestConnectionResult` so other connectors (apify, slack, etc.) are not forced to populate it — backward-compatible extension.
- Dashboard UI rendering of the `⚠ Writes globally disabled (KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true)` warning per CONTEXT.md "Specifics" line 141 is OUT OF SCOPE for phase 71 (UI work). Phase 71 ships the DATA only — the field's presence in the response is the deliverable.
- Update `manifest.test.ts` if probe-result tests assert exact shape — add a `writes_disabled` assertion (defaults to `false` when env unset).

---

### `src/connectors/unipile/lib/audit.ts` (MOD — add `error_writes_disabled` to `AuditResult`)

**Analog:** the file itself — the Phase 70 D-78 precedent (lines 71-74) added 3 new members in the exact shape phase 71 will use for 1 member.

**Code to add** (extend the `AuditResult` union at lines 52-74):
```typescript
export type AuditResult =
  // Phase 68 (locked — DO NOT reorder)
  | "success"
  | "unverified_timeout"
  | "error_rate_limit"
  | "error_account_restricted"
  | "error_not_connected"
  | "error_unipile_5xx"
  // Phase 69 (existing)
  | "dry_run"
  | "error_attachment_too_large"
  | "error_inmail_not_authorized"
  | "error_inmail_requires_premium"
  | "error_invalid_request"
  | "error_rate_limit_kebab"
  | "error_recipient_unreachable"
  | "error_inmail_recipient_not_eligible"
  | "error_inmail_cap_exceeded"
  // Phase 70 — Plan 02 (D-78)
  | "error_account_halted"
  | "inbound_accept_unknown_origin"
  | "inbound_message_unknown_origin"
  // Phase 71 — Plan 71-01 (D-88) — NEW
  | "error_writes_disabled"; // global kill switch tripped (KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true)
```

**Deviation notes:**
- The phase-71 member appends at the END of the union to preserve declaration order for dashboards / audit-log queries that depend on it (same rationale as the phase-69/70 comment block at lines 51-74).
- NO new optional field on `AuditRow` is needed — `error_writes_disabled` rows have the existing minimal shape (account_id may be "" because Step -1 fires before account-resolve — already handled by phase 68 D-20 precedent at line 221).
- Tests in `src/connectors/unipile/lib/__tests__/audit.test.ts` enumerating `AuditResult` may need an update — search for `error_account_halted` (the phase 70 analog) to find every assertion site.

---

### `tests/contract/kv-allowlist.test.ts` (MOD — verify NO new entries needed)

**Analog:** the file itself (lines 34-119 ALLOWLIST set) + the Phase 70 additions at lines 103-116.

**Deviation notes (CONTEXT.md misalignment — DO NOT add entries):**
- CONTEXT.md "Integration Points" line 128 states: "*tests/contract/kv-allowlist.test.ts — 2 NEW entries for the new admin routes (root-scope getKVStore allowed for admin tools)*". **This is incorrect.** Per D-96, all three new admin routes (`metrics/unipile-quotas/route.ts`, `metrics/unipile-quotas/summary/route.ts`, `audit/unipile/route.ts`) operate in **tenant context** via `getContextKVStore()` — explicitly NOT cross-tenant. The `?scope=all` escape hatch from `app/api/admin/rate-limits/route.ts` is NOT replicated in phase 71.
- **Real change required:** ZERO ALLOWLIST entries. The contract test will pass as-is provided the new routes use `getContextKVStore()` (NOT `getKVStore()`). The planner MUST call this out so the implementer doesn't reflexively copy-paste `rate-limits/route.ts`'s root-scope idiom.
- If a future per-operator cross-tenant audit view is added (deferred to phase 72+ per CONTEXT "Deferred Ideas" line 152), THAT phase adds an ALLOWLIST entry. Not phase 71.

**If the planner disagrees and decides to use root-scope `getKVStore()` for the summary route** (e.g., operator dashboard requires multi-tenant aggregate), the entries would follow this Phase 70 shape (lines 103-110):
```typescript
// Phase 71 / Plan 71-XX / UNI-22 / D-96-override: <RATIONALE>
"app/api/admin/metrics/unipile-quotas/summary/route.ts",
"app/api/admin/audit/unipile/route.ts",
```
But this requires a written deviation from D-96 with operator sign-off. Default path: no ALLOWLIST change.

---

### `.env.example` (MOD — document new env vars)

**Analog:** the existing Unipile block at lines 328-339 (extend it) + the `MYMCP_DISABLE_*` block at lines 152-160 (precedent for kill-switch documentation).

**Code to add** (extend lines 328-339):
```bash
# --- Unipile Connector (v0.17, phase 68+) ---
# ... existing UNIPILE_DSN / UNIPILE_TOKEN / UNIPILE_CRM_WEBHOOK_* unchanged ...

# Kill switch (v0.17 phase 71 / D-86): refuses ALL 4 LinkedIn write tools
# (send_connection, send_message, send_inmail, engage). Reads
# (get_relationship_status, list_pending) still work. Set to "true" to halt
# globally; legacy alias LINKEDIN_TOOLS_DISABLED also accepted.
# KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true

# Webhook secret (phase 70+): HMAC signing for inbound Unipile webhooks.
# UNIPILE_WEBHOOK_SECRET=your-webhook-secret-here

# Rate-limit overrides (v0.17 phase 69 D-39): per-account daily/weekly caps.
# Defaults: 25/day + 100/week for connects, 50/day for DMs, 15/day for InMail.
# KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP=25
# KEBAB_UNIPILE_LINKEDIN_WEEKLY_CONNECT_CAP=100
# KEBAB_UNIPILE_LINKEDIN_DAILY_DM_CAP=50
# KEBAB_UNIPILE_LINKEDIN_DAILY_INMAIL_CAP=15
# Rate-limiter fail-mode (D-40): default "closed" (block on KV failure).
# KEBAB_UNIPILE_RATELIMIT_FAIL_MODE=open
```

**Deviation notes:**
- Convention check: existing kill switches use `MYMCP_DISABLE_GOOGLE`-style names (lines 152-156). Phase 71 uses `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` per D-86 — slightly different (more verbose, scope-specific). This is **intentional**: `MYMCP_DISABLE_*` disables the entire connector (no `tools[]` exposed), whereas `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` keeps reads working (per D-86). Different semantics → different name.
- The `KEBAB_UNIPILE_RATELIMIT_*` block was technically added in phase 69 — verify the existing `.env.example` doesn't already document them (Grep confirms only DSN/TOKEN/CRM_* are present at lines 333-339). Phase 71 doc deliverable adds them.

---

### `docs/CONNECTORS.md` (MOD — CONTEXT.md misalignment, see deviation)

**Analog:** `docs/CONNECTORS.md` itself (entire file is a **conventions reference**, NOT a tool catalog or per-connector index).

**Deviation notes (CONTEXT.md misalignment):**
- CONTEXT.md D-99 says "Update `docs/CONNECTORS.md` index to add Unipile row". **There IS NO connector index/table in `docs/CONNECTORS.md`.** Re-reading lines 1-300, the file documents conventions (error handling, tool timeouts, credential resolution, tenant isolation, tool definitions, etc.) — there is no "List of connectors" section to add a row to.
- The actual "catalog" docs are:
  - `content/docs/connectors.md` — count-claim doc (already updated in phase 69-06 per CONTEXT line 22)
  - `docs/CONNECTOR-AUTHORING.md` — step-by-step authoring guide (no connector index either)
  - `README.md` — has an "External integrations" section per D-100 (verify before edit)
- **Recommended real change:** add a new section at the bottom of `docs/CONNECTORS.md` titled `## Reference: per-connector docs` linking to the new `docs/connectors/unipile.md`. This is the closest match to "index update" given the file's actual structure.
- Alternative: the line drift may refer to a future `## Connectors index` section the operator wants to add. Plan should call out the misalignment and present both options to the user.

---

### `docs/connectors/unipile.md` (NEW — per-connector doc) — **NO ANALOG**

**Analogs:**
- `docs/connectors/` directory **does NOT exist** (verified — `ls docs/` shows no `connectors/` subdir).
- Closest existing structural analogs in the repo:
  1. The `guide:` markdown field inside `src/connectors/unipile/manifest.ts:119-134` — already documents prerequisites, env vars, account connection, and tool notes for the operator. The new doc EXTENDS this with full tools catalog, troubleshooting, multi-tenant test procedure.
  2. `docs/CONNECTOR-AUTHORING.md` — for the **doc structure style** (sections, code blocks, env var documentation patterns).
  3. ADR `docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md` — for the **decision rationale** section + cross-link target.
  4. The 6 tool descriptions in `src/connectors/unipile/manifest.ts:159-227` `defineTool({description})` blocks — copy these per CONTEXT.md "Claude's Discretion" line 81.

**Recommended doc structure (combining D-98 + RESEARCH "Quick Start" pattern from CONTEXT.md "Specifics" line 143):**
```markdown
# Unipile Connector

## Overview
Managed-browser API for LinkedIn writes + (future) WhatsApp. See ADR 0001 for the decision rationale (Browserbase failed silently 2026-05-18 → Unipile chosen).
→ docs/adr/0001-unipile-as-linkedin-whatsapp-write-provider.md

## Quick Start (60 seconds)
1. Set env vars: UNIPILE_DSN, UNIPILE_TOKEN, UNIPILE_WEBHOOK_SECRET
2. Run scripts/setup-unipile-webhooks.ts to register webhook subscriptions
3. Send a test connect via linkedin_send_connection
   See {ENV_LIST}, {WEBHOOK_SETUP_DETAILS}, {TEST_PROCEDURE} below.

## Setup
### Environment variables
- UNIPILE_DSN — e.g. api41.unipile.com:17153 (from dashboard Settings → API)
- UNIPILE_TOKEN — API token (from dashboard Settings → API)
- UNIPILE_WEBHOOK_SECRET — HMAC secret for inbound webhook verification (phase 70+)
- UNIPILE_CRM_WEBHOOK_URL — outbound CRM POST URL (deferred to phase 72+)
- UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID> — per-tenant outbound HMAC

### Unipile dashboard account connection
1. Sign in to dashboard.unipile.com
2. Settings → API → copy DSN + Token
3. Accounts → Add account → connect LinkedIn (Sales Navigator-tier recommended for higher quotas)

### Webhook subscription
Run `npx tsx scripts/setup-unipile-webhooks.ts` to register the 3 subscriptions (account_status, new_relation, message_received). Idempotent — safe to re-run.

## Tools catalog (6 tools)
### linkedin_send_connection (destructive write)
{COPY DESCRIPTION FROM manifest.ts:161-165}
**Example invocation:** {SHELL/MCP CALL}
**Expected response:** {ENVELOPE SHAPE}

### linkedin_send_message (destructive write)
{COPY FROM manifest.ts:184-189}
... (repeat for the 4 remaining tools — see manifest.ts:159-227)

## Rate limits
Defaults (per-account daily/weekly caps, enforced kebab-side BEFORE Unipile's own limiter):
- send_connection: 25/day, 100/week
- send_message: 50/day (no weekly cap)
- send_inmail: 15/day (no weekly cap)
Override pattern: KEBAB_UNIPILE_LINKEDIN_DAILY_CONNECT_CAP=N (see .env.example).
Reference: https://developer.unipile.com/docs/provider-limits-and-restrictions

## Kill switches
KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED=true → refuses ALL 4 write tools (reads still work).
Legacy alias: LINKEDIN_TOOLS_DISABLED.
Status visible in /config → Connectors → Unipile tile (writes_disabled: boolean).

## Halt flag (per-account, automatic)
Webhook-driven: account.status transitions to restricted/credentials_expired
automatically set tenant:<id>:unipile:halt:<account_id>, which then refuses writes
on the affected account until status recovers (OK / RECONNECTED / etc).
Reference: src/connectors/unipile/webhook/halt-flag.ts

## Troubleshooting
| Error | Cause | Fix |
|-------|-------|-----|
| error_unipile_5xx | Unipile upstream issue | Check status.unipile.com; retry after backoff |
| error_not_connected | Recipient not 1st-degree | Use linkedin_send_connection first |
| error_rate_limit_kebab | Daily/weekly cap hit kebab-side | Wait until next UTC midnight (daily) or Monday UTC (weekly) |
| error_account_restricted | LinkedIn restricted the account | Reconnect via Unipile dashboard; halt flag will auto-clear |
| error_account_halted | Webhook-set halt flag still active | Wait for account_status recovery webhook; verify via halt-flag KV row |
| error_writes_disabled | Kill switch enabled | Unset KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED |

## Appendix: Multi-tenant smoke test (D-101)
{COPY THE 6-STEP D-101 PROCEDURE VERBATIM FROM 71-CONTEXT.md LINES 68-74}
```

**Deviation notes:**
- The `docs/connectors/` directory does NOT exist — `mkdir docs/connectors/` is part of the plan.
- This is the FIRST per-connector doc in the project; phase 71 establishes the precedent. Future connectors should follow this structure (planner may want to update `docs/CONNECTOR-AUTHORING.md` with a "create a docs/connectors/<id>.md" step — out of scope for phase 71 but worth flagging).
- The manifest's existing `guide:` markdown (lines 119-134) overlaps with the Setup section — the per-connector doc is the canonical home; the manifest guide can be trimmed to a 1-sentence pointer at the doc, or left as-is for the dashboard wizard (the guide is rendered in /config → Packs per `docs/CONNECTORS.md:172-185`).
- The "Multi-tenant smoke test" appendix doubles as UNI-24's deliverable — the procedure document IS the deliverable per D-102.

---

## Shared Patterns

### Admin route auth
**Source:** `src/core/with-admin-auth.ts` + every existing `app/api/admin/**/route.ts`
**Apply to:** All 3 new admin routes (`metrics/unipile-quotas/route.ts`, `metrics/unipile-quotas/summary/route.ts`, `audit/unipile/route.ts`)
```typescript
import { withAdminAuth } from "@/core/with-admin-auth";
async function handler(ctx: PipelineContext) { /* ... */ }
export const GET = withAdminAuth(handler);
```

### Cache-Control for admin metrics
**Source:** CONTEXT.md "Established Patterns" line 132 (phase 53 convention)
**Apply to:** 3 new admin routes
```typescript
return NextResponse.json(payload, {
  headers: { "Cache-Control": "private, max-age=30" }, // 10s for audit query
});
```

### Tenant-scoped KV access
**Source:** `src/core/request-context.ts:getContextKVStore` (Phase 42 / TEN-04)
**Apply to:** ALL 3 new admin routes (per D-96 — no `?scope=all` escape hatch)
```typescript
import { getContextKVStore } from "@/core/request-context";
const kv = getContextKVStore(); // auto-prefixes tenant:<id>:
```

### Kill-switch lookup (NEW shared helper recommended)
**Source:** Claude's discretion — see DRY note in `linkedin-send-message` MOD section above
**Apply to:** All 4 write tools + manifest.ts `testConnection()`
```typescript
// src/connectors/unipile/lib/kill-switch.ts (NEW)
import { getConfig } from "@/core/config-facade";
export function isWritesDisabled(): boolean {
  const v = getConfig("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED")
         ?? getConfig("LINKEDIN_TOOLS_DISABLED");
  return v === "true" || v === "1";
}
```

### Credential reads (NEVER process.env)
**Source:** `src/core/config-facade.ts:getConfig` (D-89 + ESLint rule `kebab/no-direct-process-env`)
**Apply to:** Kill-switch reads, rate-limit override reads, anywhere env vars are consulted
```typescript
import { getConfig } from "@/core/config-facade";
const val = getConfig("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED");
```

### Error stringification + 500 envelope
**Source:** `src/core/error-utils.ts:toMsg` + every existing admin route
**Apply to:** All 3 new admin routes' catch blocks
```typescript
import { toMsg } from "@/core/error-utils";
} catch (err) {
  return NextResponse.json({ error: toMsg(err) }, { status: 500 });
}
```

### Audit row append (existing helper)
**Source:** `src/connectors/unipile/lib/audit.ts:writeAuditRow` (Phase 68 / Plan 04)
**Apply to:** Step -1 in all 4 write tool MODs
```typescript
import { writeAuditRow, generateAuditId } from "../lib/audit";
await writeAuditRow({ /* row including result: "error_writes_disabled" */ });
```

### Logger tag
**Source:** `docs/CONNECTORS.md:21-24` convention
**Apply to:** All 3 new admin routes (use `[API:admin/metrics/unipile-quotas]` style) + the 4 tool MODs (already use `[CONNECTOR:unipile]`)

---

## No Analog Found

Files with no close match in the codebase (planner uses RESEARCH/CONTEXT patterns directly):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `docs/connectors/unipile.md` | per-connector doc | n/a | `docs/connectors/` directory does NOT exist; phase 71 establishes the precedent. Use the manifest's `guide:` markdown + `docs/CONNECTOR-AUTHORING.md` style + ADR 0001 cross-link as composite reference. |
| `src/connectors/unipile/lib/kill-switch.ts` (RECOMMENDED helper) | utility | n/a | New abstraction — no kill-switch helper exists in any connector. Phase 70's `halt-flag.ts` is the closest *pattern* (helper module exporting a boolean check) but the semantics are per-account vs phase 71's global. |

---

## CONTEXT.md misalignments flagged for planner

These are CONTEXT.md statements the planner MUST treat with care because they conflict with the codebase reality:

1. **"`tests/contract/kv-allowlist.test.ts` — 2 NEW entries (metrics quota route + audit query route)"** (CONTEXT line 128 + the orchestrator's prompt item 10): **WRONG.** D-96 mandates tenant-scoping for all 3 new routes → `getContextKVStore()` → NO allowlist entries. Only if a future deviation chooses root-scope for the summary route would entries be needed. Plan should EXPLICITLY note this misalignment so the implementer doesn't reflexively add ALLOWLIST entries.

2. **"Update `docs/CONNECTORS.md` index to add Unipile row"** (D-99): **No connector index exists in the file.** It's a conventions reference. Recommended interpretation: add a `## Reference: per-connector docs` section at the bottom with a link to `docs/connectors/unipile.md`. Alternative: ask user to confirm intent.

3. **"`docs/connectors/apify.md` OR similar existing connector doc (template for unipile.md)"** (CONTEXT line 103): **`docs/connectors/` directory does NOT exist.** No per-connector doc has been written before. Phase 71 establishes the precedent.

4. **Kill-switch env var naming inconsistency**: existing `MYMCP_DISABLE_*` pattern (lines 152-156) vs phase 71's `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED` (D-86). The difference is intentional (read/write distinction) but the .env.example MOD should call this out in a comment.

---

## Metadata

**Analog search scope:**
- `app/api/admin/metrics/**` (3 files — primary analogs for new admin routes)
- `app/api/admin/unipile/cache/urn/route.ts` (admin-auth + URL param pattern)
- `src/connectors/unipile/tools/*.ts` (4 write tools — Step 0a/0b precedent)
- `src/connectors/unipile/lib/{rate-limiter,audit,kill-switch placeholder}.ts` (helper patterns)
- `src/connectors/unipile/webhook/halt-flag.ts` (helper-module structure analog)
- `src/connectors/unipile/manifest.ts` (testConnection extension target)
- `src/core/types.ts` (TestConnectionResult interface)
- `tests/contract/kv-allowlist.test.ts` (allowlist file — NO change needed)
- `.env.example` (existing Unipile block at lines 328-339)
- `docs/CONNECTORS.md` (verified: conventions ref, no index)
- `docs/CONNECTOR-AUTHORING.md` (style ref for new per-connector doc)
- `docs/adr/0001-*.md` (cross-link target for new doc)

**Files scanned:** 14 source + 1 contract test + 1 config + 4 doc files
**Pattern extraction date:** 2026-05-19

---

## PATTERN MAPPING COMPLETE
