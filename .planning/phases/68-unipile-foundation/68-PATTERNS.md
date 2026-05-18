# Phase 68: Unipile Foundation — Pattern Map

**Mapped:** 2026-05-18
**Files analyzed:** 14 (5 new connector files + 6 lib/tests + 1 admin route + 4 modifications)
**Analogs found:** 13 / 14 (URN cache resolver has no direct analogue)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/connectors/unipile/manifest.ts` | manifest (connector definition) | static | `src/connectors/apify/manifest.ts` | exact |
| `src/connectors/unipile/manifest.test.ts` | test (manifest sanity) | n/a | `src/connectors/apify/manifest.test.ts` | exact |
| `src/connectors/unipile/client.ts` (research recommends top-level, not `lib/`) | SDK singleton wrapper | request-response | `src/connectors/apify/lib/client.ts` | role-match (SDK vs fetch) |
| `src/connectors/unipile/lib/retry.ts` | utility (exp backoff) | transform | none (hand-rolled per research) | **no analog** |
| `src/connectors/unipile/lib/identifiers.ts` | library (URL→URN resolver + KV cache) | request-response + cache | `src/core/update-check.ts` (KV-cached fetch) + `app/api/webhook/[name]/route.ts` (createHash usage) | partial-match |
| `src/connectors/unipile/lib/audit.ts` | library (KV audit log writer + dedup) | event-driven write | `src/connectors/webhook` `webhook:last:*` KV storage pattern | role-match (KV write) |
| `src/connectors/unipile/lib/crm-bridge.ts` | library (adapter interface + outbox skeleton) | event-driven (skeleton) | none in `src/connectors`; outbox pattern lifts from `src/core/update-check.ts` cache-write semantic | **interface novel, KV-write analog only** |
| `src/connectors/unipile/lib/errors.ts` | utility (typed error classes) | n/a | `src/core/connector-errors.ts` (GoogleAuthError, VaultAuthError) | exact |
| `src/connectors/unipile/tools/linkedin-send-connection.ts` | tool handler (write, multi-step) | request-response + 3-poll verify | `src/connectors/apify/tools/linkedin-profile.ts` (handler shape) + `app/api/cron/update-check/route.ts` (lock + KV write idiom) | role-match (no two-step send analogue exists) |
| `src/connectors/unipile/tools/linkedin-get-relationship-status.ts` | tool handler (read) | request-response | `src/connectors/apify/tools/linkedin-profile.ts` | exact |
| `src/connectors/unipile/lib/__tests__/*.test.ts` | tests (unit, KV-mocked) | n/a | `src/connectors/apify/lib/__tests__/client.test.ts` | exact |
| `app/api/admin/unipile/cache/urn/route.ts` | admin route (DELETE eviction) | request-response | `app/api/admin/rate-limits/route.ts` (root-scope escape hatch) + `app/api/admin/custom-tools/[id]/route.ts` (DELETE pattern) | role-match |
| `src/core/registry.ts` (MOD) | registry (add lazy loader entry) | n/a | existing `ALL_CONNECTOR_LOADERS` entries (apify, github) | exact |
| `src/core/credential-store.ts` (MOD) | credential hydration (no schema change needed) | n/a | existing CRED_PREFIX hydration loop (no per-key add required — see deviation) | **deviation needed** |
| `tests/contract/kv-allowlist.test.ts` (MOD per CONTEXT.md) | contract test | n/a | n/a | **CONTEXT.md misalignment — see deviation** |
| `docs/CONNECTORS.md` (MOD per CONTEXT.md) | docs | n/a | n/a | **CONTEXT.md misalignment — see deviation** |

---

## Pattern Assignments

### `src/connectors/unipile/manifest.ts` (manifest)

**Analog:** `src/connectors/apify/manifest.ts`

**Imports + structure pattern** (apify/manifest.ts:1-36):
```typescript
import { defineTool, type ConnectorManifest, type ToolDefinition } from "@/core/types";
import {
  apifyLinkedinProfileSchema,
  handleApifyLinkedinProfile,
  APIFY_LINKEDIN_PROFILE_ACTOR,
} from "./tools/linkedin-profile";
// ... one import per tool
import { getConfig } from "@/core/config-facade";
```

**Manifest export shape** (apify/manifest.ts:166-232):
```typescript
export const apifyConnector: ConnectorManifest = {
  id: "apify",
  label: "Apify",
  description: "...",
  guide: `...markdown setup guide...`,
  requiredEnvVars: ["APIFY_TOKEN"],
  testConnection: async (credentials) => {
    const token = credentials.APIFY_TOKEN;
    if (!token) return { ok: false, message: "Missing Apify token" };
    const res = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { username?: string } };
      return { ok: true, message: `Connected as ${data?.data?.username || "user"}` };
    }
    return { ok: false, message: `Apify: ${res.status}`, detail: ... };
  },
  diagnose: async () => { /* same as testConnection but reads via getConfig */ },
  get tools() {
    return buildTools(); // lazy getter — env read at resolve time
  },
};
```

**defineTool wrapper pattern** (apify/manifest.ts:46-54):
```typescript
defineTool({
  name: "apify_linkedin_profile",
  description: "...",
  schema: apifyLinkedinProfileSchema,
  handler: async (args) => handleApifyLinkedinProfile(args),
  destructive: false,    // ← MUST be `true` for linkedin_send_connection (write tool)
})
```

**Deviation notes:**
- `testConnection()` must use the SDK, not raw fetch — per D-19, call `getUnipileClient().account.getAll()` and verify `≥1 LinkedIn account` (not `/account/me`, which the SDK doesn't expose).
- Two `requiredEnvVars`: `["UNIPILE_DSN", "UNIPILE_TOKEN"]` (apify has 1).
- `linkedin_send_connection` is `destructive: true`; `linkedin_get_relationship_status` is `destructive: false`.

---

### `src/connectors/unipile/manifest.test.ts` (test)

**Analog:** `src/connectors/apify/manifest.test.ts`

**Test shape** (apify/manifest.test.ts:1-30):
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { apifyConnector } from "./manifest";

describe("apify allowlist parsing", () => {
  beforeEach(() => { delete process.env.APIFY_ACTORS; });
  afterEach(() => { /* restore originalAllowlist */ });

  it("includes every wrapper when APIFY_ACTORS is unset", () => {
    const names = apifyConnector.tools.map((t) => t.name);
    expect(names).toContain("apify_linkedin_profile");
  });

  it("marks apify_run_actor as destructive", () => {
    const runActor = apifyConnector.tools.find((t) => t.name === "apify_run_actor");
    expect(runActor?.destructive).toBe(true);
  });
});
```

**Deviation notes:** Apify's tests are dominated by `APIFY_ACTORS` allowlist parsing — Unipile has no analogous allowlist env var (UNI-01 surface is fixed at 2 tools). Replace with: tool-count assertion, both tools present, `linkedin_send_connection.destructive === true`, `linkedin_get_relationship_status.destructive === false`, `requiredEnvVars` set to exactly `["UNIPILE_DSN","UNIPILE_TOKEN"]`.

---

### `src/connectors/unipile/client.ts` (SDK singleton)

**Analog:** `src/connectors/apify/lib/client.ts`

**Token-required guard pattern** (apify/lib/client.ts:16-20):
```typescript
function getToken(): string {
  const t = getConfig("APIFY_TOKEN");
  if (!t) throw new Error("APIFY_TOKEN is not set");
  return t;
}
```

**Singleton + lazy init pattern** (RESEARCH.md §Pattern 1 — no in-repo SDK singleton exists yet, but apify's `getToken()` + module-scope-but-no-cache style is the closest):
```typescript
// Build on apify's getConfig() + clear-error idiom, add module-scope cache:
let client: UnipileClient | null = null;

export function getUnipileClient(): UnipileClient {
  if (client) return client;
  const dsn = getConfig("UNIPILE_DSN");
  const token = getConfig("UNIPILE_TOKEN");
  if (!dsn || !token) {
    throw new Error("UNIPILE_DSN and UNIPILE_TOKEN must be set");
  }
  client = new UnipileClient(`https://${dsn}`, token);
  log.info("UnipileClient initialized");
  return client;
}

export function __resetUnipileClientForTests(): void { client = null; }
```

**Logger tag pattern** (per docs/CONNECTORS.md:11-17 + apify uses none explicitly):
```typescript
import { getLogger } from "@/core/logging";
const log = getLogger("CONNECTOR:unipile");
```

**Error sanitization pattern** (apify/lib/client.ts:23-27, applicable when surfacing SDK errors):
```typescript
function sanitize(text: string): string {
  const token = getConfig("UNIPILE_TOKEN");
  if (!token) return text;
  return text.split(token).join("<redacted>");
}
```

**Deviation notes:**
- Apify uses raw `fetch` with `fetchWithTimeout`; Unipile uses the SDK's own request layer — no `fetchWithTimeout` wrapping at this layer (retry lives in `lib/retry.ts` per research §Pattern 2).
- File path: research recommends `src/connectors/unipile/client.ts` (top-level), NOT `src/connectors/unipile/lib/client.ts` as the CONTEXT.md fragment implies. Pin this in the plan.
- Add `__resetUnipileClientForTests()` — apify's stateless function doesn't need one; the singleton does (test-isolation requirement, same pattern as `resetHydrationFlag()` in credential-store.ts:171).

---

### `src/connectors/unipile/lib/retry.ts` (utility — hand-rolled)

**Analog:** **none in repo** — research §Don't Hand-Roll explicitly confirms no `p-retry` / `async-retry` dep; SDK has no native retry middleware.

**Code to use verbatim** (RESEARCH.md §Pattern 2, lines 224-258):
```typescript
import { UnsuccessfulRequestError } from "unipile-node-sdk";

const RETRYABLE = new Set([429, 502, 503, 504]);
const DEFAULT_MAX = 3;
const BASE_MS = 200;

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { max?: number; baseMs?: number } = {}
): Promise<T> {
  const max = opts.max ?? DEFAULT_MAX;
  const baseMs = opts.baseMs ?? BASE_MS;
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      attempt++;
      if (attempt >= max ||
          !(err instanceof UnsuccessfulRequestError) ||
          !RETRYABLE.has((err.body as { status?: number })?.status ?? 0)) {
        throw err;
      }
      const delay = baseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
```

**Deviation notes:** None. Plan should ship this exact helper. Tests must use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` to verify backoff math without sleeping in CI.

---

### `src/connectors/unipile/lib/identifiers.ts` (library — URL→URN resolver + KV cache)

**Analogs:**
- KV-cached read-through: `app/api/cron/update-check/route.ts` (KV.get → fall back to fetch → KV.set with TTL)
- Crypto hash for KV key: `app/api/webhook/[name]/route.ts:1` (`createHash`)
- Tenant-scoped KV access: `src/core/request-context.ts:72-74` (`getContextKVStore`)

**KV read-through cache pattern** (cron/update-check/route.ts:84-86):
```typescript
await kv.set(UPDATE_CHECK_KV_KEY, JSON.stringify(result.payload), UPDATE_CHECK_TTL_SECONDS);
```

**Crypto pattern** (webhook/[name]/route.ts:1):
```typescript
import { createHmac, createHash, timingSafeEqual } from "crypto";
// Used as: createHash("sha256").update(...).digest("hex").slice(0, 16)
```

**Tenant-scoped KV access** (request-context.ts:72-74):
```typescript
export function getContextKVStore(): KVStore {
  return getTenantKVStore(getCurrentTenantId());
}
```

**Full module skeleton** (combine analogs + RESEARCH §Pattern 3 lines 263-319):
```typescript
import { createHash } from "node:crypto";
import { getContextKVStore } from "@/core/request-context";
import { getUnipileClient } from "../client";
import { withRetry } from "./retry";

const URN_TTL_SECONDS = 30 * 24 * 60 * 60;  // D-10: 30 days
const SLUG_RE = /^https?:\/\/(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-z0-9-_%]+)\/?$/i;

export function normalizeProfileUrl(input: string): string { /* D-12 rules */ }
function urlHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
export async function resolveProviderId(rawUrl: string, accountId: string)
  : Promise<{ provider_id: string; from_cache: boolean }> {
  const kv = getContextKVStore();
  const key = `unipile:urn:${urlHash(normalizeProfileUrl(rawUrl))}`;
  // ... cache check → SDK fallback → kv.set with TTL
}
```

**Deviation notes:**
- D-18 amendment: `unipile:urn:*` keys are **tenant-prefixed via `getContextKVStore()`**, not raw `getKVStore()`. The KV wrapper auto-prefixes `tenant:<id>:` so the in-code key is `unipile:urn:<hash>`. Same rule for `unipile:audit:*` and `unipile:outbox:*`.
- Pitfall 7 (RESEARCH.md): TTL is ignored by FilesystemKV — unit tests must assert that the TTL **value is passed** to `kv.set(...)` (mock + spy on args), not that the key actually expires. Production behavior is verified separately against Upstash.
- D-10 strict-mode: on 429 from Unipile, **throw** explicit error (do NOT serve stale). Surface a typed error from `lib/errors.ts`.

---

### `src/connectors/unipile/lib/audit.ts` (library — KV audit log + dedup)

**Analog:** `src/connectors/webhook` KV storage idiom (uses `getContextKVStore` + simple key/value writes; no in-repo dedup-by-hash pattern exists).

**KV write idiom** (webhook/[name]/route.ts:2 + similar `kv.set(key, JSON.stringify(payload))` calls throughout):
```typescript
import { getContextKVStore } from "@/core/request-context";
const kv = getContextKVStore();
await kv.set(`unipile:audit:${auditId}`, JSON.stringify(row), 90 * 24 * 60 * 60); // D-08: 90 days
```

**Hash pattern** (reuse from identifiers.ts):
```typescript
import { createHash } from "node:crypto";
function computeParamsHash(input: { tool: string; profile_url: string; note: string }): string {
  // D-05: SHA-256 over {tool_name, profile_url_normalized, note_text}
  const canonical = JSON.stringify(input);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
```

**Audit-id generation pattern** (no in-repo analogue; use `crypto.randomUUID()` — Node ≥18 built-in, used throughout the codebase per `getEnabledPacks` and `bootEnv` style):
```typescript
import { randomUUID } from "node:crypto";
export function generateAuditId(): string { return randomUUID(); }
```

**Dedup check via secondary index** (no in-repo analogue — invent based on D-05/D-06):
```typescript
// Write two keys per audit row:
//   unipile:audit:<audit_id>            → full row (90d TTL)
//   unipile:audit:hash:<params_hash>    → audit_id pointer (90d TTL)
// Dedup check: GET unipile:audit:hash:<hash> → if present, return existing row.
```

**Deviation notes:**
- D-07: `note_text` is NEVER stored in the row body — only `params_hash`. Audit row JSON fields: `{actor_user_id, tool, account_id, params_hash, result, verified, dedup_hit, timestamp, audit_id}`.
- D-08: `EX 7776000` (90 days). Pass `ttlSeconds: 7776000` to `kv.set()` — verified that UpstashKV honors this (kv-store.ts:408-415) and Filesystem ignores (kv-store.ts:212-224).
- D-06: NO `dedup_key` override on the tool schema — caller cannot bypass.

---

### `src/connectors/unipile/lib/crm-bridge.ts` (library — adapter interface + outbox skeleton)

**Analog:** **No in-repo adapter-interface pattern.** Closest: `src/connectors/custom-tools/store.ts` uses similar KV-write semantics but no interface abstraction.

**Outbox KV write idiom** (reuse audit.ts pattern):
```typescript
import { getContextKVStore } from "@/core/request-context";

export interface CrmAdapter {
  writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void>;
}

class TwentyAdapterSkeleton implements CrmAdapter {
  async writeOutbox(auditId: string, payload: { crm_log: unknown }): Promise<void> {
    const kv = getContextKVStore();
    // D-01: write 'pending' status, NO actual webhook POST in phase 68
    await kv.set(
      `unipile:outbox:${auditId}`,
      JSON.stringify({ status: "pending", crm_log: payload.crm_log, queued_at: new Date().toISOString() }),
      // No TTL — outbox is durable until phase 70 retry cron processes it
    );
  }
}

export const crmBridge: CrmAdapter = new TwentyAdapterSkeleton();
```

**Deviation notes:**
- D-01 hard constraint: phase 68 ships skeleton ONLY. The adapter must write the outbox row and stop — no `fetch()` to `UNIPILE_CRM_WEBHOOK_URL` (that's phase 70).
- D-02: locked to outbox webhook pattern at phase 70 — the interface signature must be compatible with that future implementation (don't expose Twenty-specific types in the interface).
- D-03: per-tenant secret env var name `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` — out of scope for phase 68 but the file should document the future env var contract in a comment.

---

### `src/connectors/unipile/lib/errors.ts` (utility — typed error classes)

**Analog:** `src/core/connector-errors.ts` (Google/Vault error classes)

**Class pattern** (connector-errors.ts:32-47):
```typescript
import { McpToolError, ErrorCode } from "./errors";

export class GoogleRateLimitError extends McpToolError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: ErrorCode.RATE_LIMITED,
      toolName: "google",
      message,
      userMessage: "Google API rate limit reached. Please try again in a moment.",
      retryable: true,
      cause: opts?.cause,
      recovery: "Wait 30-60 seconds before retrying...",
    });
    this.name = "GoogleRateLimitError";
  }
}
```

**Recovery taxonomy** (connector-errors.ts:13-30 has both `recovery` and `internalRecovery`):
```typescript
// Public recovery hint (LLM-safe) + private internalRecovery (env var names, logged server-side).
recovery: "Reconnect LinkedIn account in /config",
internalRecovery: "Check UNIPILE_TOKEN env var; account may need re-OAuth via Unipile dashboard.",
```

**Deviation notes:**
- Suggested taxonomy from CONTEXT.md "Claude's Discretion" + RESEARCH.md `classifyUnipileError`: `UnipileRateLimitError` (429/422 cannot_resend), `UnipileAccountRestrictedError` (401/403), `UnipileNotConnectedError` (404), `Unipile5xxError` (≥500), `UnipileUnverifiedTimeoutError` (audit-only — distinct from above per D-15).
- File path: research recommends `src/connectors/unipile/lib/errors.ts` (NOT extending `src/core/connector-errors.ts`) to keep core untouched. Plan should add a note that errors live colocated with the connector.

---

### `src/connectors/unipile/tools/linkedin-send-connection.ts` (tool handler — write, multi-step)

**Analog:** `src/connectors/apify/tools/linkedin-profile.ts` (tool handler shape) + `app/api/cron/update-check/route.ts` (KV lock + multi-step KV writes)

**Tool handler skeleton** (apify/tools/linkedin-profile.ts:1-18):
```typescript
import { z } from "zod";
import { runActor } from "../lib/client";

export const APIFY_LINKEDIN_PROFILE_ACTOR = "harvestapi/linkedin-profile-scraper";

export const apifyLinkedinProfileSchema = {
  url: z.string().url().describe("Public LinkedIn profile URL (...)"),
};

export async function handleApifyLinkedinProfile(params: { url: string }) {
  const items = await runActor(APIFY_LINKEDIN_PROFILE_ACTOR, { profileUrls: [params.url] });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
  };
}
```

**Full handler shape** (RESEARCH.md §Code Examples lines 399-484 — verbatim usable):
- Step 1: dedup check
- Step 2: resolve provider_id (cache + SDK)
- Step 3: write outbox row
- Step 4: SDK.users.sendInvitation (wrapped in withRetry)
- Step 5: pollForRelation (3 polls at 2s/5s/10s)
- Step 6: writeAuditRow
- Step 7: return envelope

**Verify-after-write polling** (RESEARCH.md lines 488-510 — verbatim usable; uses `getAllInvitationsSent`).

**Deviation notes:**
- **No analog for two-step send flow** (getProfile → sendInvitation) — invent per RESEARCH. The closest in-repo pattern is the cron update-check sequence of "lock → fetch → KV write" but the semantics differ.
- **No analog for 3-poll verify-after-write** — invent per D-13. Total budget ~17s (well under 30s `MYMCP_TOOL_TIMEOUT` default).
- D-14 envelope: hardcode `verified: boolean` (NEVER 'pending'). The return shape `{provider_ok, verified, crm_sync: 'pending', dedup_hit, audit_id, invitation_id?, error?}` is the contract.
- D-20 amendment: `account_id` is OPTIONAL. Resolution rules:
  - 0 LinkedIn accounts → throw `error_no_linkedin_account`
  - 1 LinkedIn account → use it silently
  - ≥2 LinkedIn accounts → throw `error_account_id_required` with available list
- Tool description must call out the dedup behavior (D-05/D-06) so LLM callers understand re-sends are blocked.

---

### `src/connectors/unipile/tools/linkedin-get-relationship-status.ts` (tool handler — read)

**Analog:** `src/connectors/apify/tools/linkedin-profile.ts` (same shape, simpler)

**Code excerpt:** same as `linkedin-send-connection` Step 2 (resolveProviderId), then call `getProfile`, map `network_distance` → `degree`:
```typescript
const { provider_id } = await resolveProviderId(args.profile_url, args.account_id);
const profile = await withRetry(() =>
  getUnipileClient().users.getProfile({ account_id, identifier: slug })
);
const networkDistance = (profile as { network_distance?: string }).network_distance;
const degree = networkDistance === "FIRST_DEGREE" ? 1
             : networkDistance === "SECOND_DEGREE" ? 2
             : networkDistance === "THIRD_DEGREE" ? 3
             : null;  // Pitfall 3: missing field ≠ third degree
return { content: [{ type: "text", text: JSON.stringify({ degree, connection_status: networkDistance ?? "unknown" }) }] };
```

**Deviation notes:**
- D-21 amendment: envelope is `{degree, connection_status}` ONLY. **DROP** `last_message_at` + `has_replied` (Unipile `getProfile` doesn't expose these).
- Pitfall 3: handle missing `network_distance` as `null`, not "third degree".
- No audit row (read-only tool, no PII transit).

---

### `src/connectors/unipile/lib/__tests__/*.test.ts` (tests)

**Analog:** `src/connectors/apify/lib/__tests__/client.test.ts`

**Test scaffold** (apify/lib/__tests__/client.test.ts:1-30):
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@/core/fetch-utils", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

async function loadModule() { return await import("../client"); }

describe("Phase 50 / COV-04 — apify/lib/client.ts", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.APIFY_TOKEN = "secret-apify-token";
    vi.resetModules();
  });
  afterEach(() => { delete process.env.APIFY_TOKEN; });
  // ... per-method describe blocks
});
```

**KV-mock pattern for identifiers.test.ts / audit.test.ts** (apify/lib/__tests__/client.test.ts:8-13 + adapt):
```typescript
const kvMock = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kvMock,
  getCurrentTenantId: () => null,
}));
```

**SDK-mock pattern for client.test.ts** (no in-repo analog — invent):
```typescript
vi.mock("unipile-node-sdk", () => ({
  UnipileClient: vi.fn().mockImplementation(() => ({
    users: { getProfile: vi.fn(), sendInvitation: vi.fn() },
    account: { getAll: vi.fn() },
  })),
  UnsuccessfulRequestError: class extends Error { body: unknown = {}; },
}));
```

**Required test files (per CONTEXT.md + research):**
- `identifiers.test.ts` — URL variants (4 from D-12), hashing determinism, cache hit/miss, 429 throws (D-10)
- `audit.test.ts` — dedup logic, params_hash determinism, TTL passed to kv.set (Pitfall 7)
- `crm-bridge.test.ts` — outbox row written with status='pending', no actual fetch made
- `retry.test.ts` — retries 429/502/503/504, does NOT retry 422 (non-cannot_resend) or 400, max 3 attempts, exp backoff with jitter
- `client.test.ts` — singleton (same instance returned twice), missing env throws, `__resetUnipileClientForTests` works

---

### `app/api/admin/unipile/cache/urn/route.ts` (admin route — DELETE eviction)

**Analogs:**
- DELETE method handler: `app/api/admin/custom-tools/[id]/route.ts:62-75`
- Query-param parsing + root-scope escape hatch: `app/api/admin/rate-limits/route.ts:42-49,72-76`
- `withAdminAuth` HOC: `src/core/with-admin-auth.ts`

**Handler structure** (custom-tools/[id]/route.ts:62-79):
```typescript
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";

async function deleteHandler(ctx: PipelineContext) {
  try {
    // ... delete logic ...
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}
export const DELETE = withAdminAuth(deleteHandler);
```

**Query param parsing** (rate-limits/route.ts:46-49):
```typescript
const request = ctx.request;
const url = new URL(request.url);
const profileUrl = url.searchParams.get("profile_url");
if (!profileUrl) return NextResponse.json({ ok: false, error: "profile_url required" }, { status: 400 });
```

**Root-scope escape hatch comment marker** (rate-limits/route.ts:42-45):
```typescript
// KV-ALLOWLIST-EXEMPT: cache eviction for unipile URN keys needs to bypass
// the tenant prefix because the admin operator may need to evict
// poisoned/stale entries across all tenants. See D-18 + .planning/phases/68.
async function deleteHandler(ctx: PipelineContext) {
  // ...
  // Use raw getKVStore() per D-18 escape hatch — admin tool, not LLM-visible.
}
```

**Deviation notes:**
- D-11: admin auth via `withAdminAuth` HOC (not raw `checkAdminAuth`).
- D-18: this is the documented exception that uses `getKVStore()` (root scope) rather than `getContextKVStore()`. **This means the route file must be added to the `ALLOWLIST` Set in `tests/contract/kv-allowlist.test.ts:34-98`** with a comment pointing to phase 68 INVENTORY. Without this addition, the contract test will fail.
- Hash computation: must re-hash the input `profile_url` with the same normalization+`createHash("sha256").digest("hex").slice(0,16)` that `lib/identifiers.ts` uses — extract the helper so both files use the same code (single source of truth for the hash → eviction works deterministically).

---

### `src/core/registry.ts` (MODIFICATION — add lazy loader entry)

**Analog:** existing entries in `ALL_CONNECTOR_LOADERS` (registry.ts:60-201) — pick `apify` as the closest shape (2 env vars, no `hasCustomActive`).

**Entry to add** (after apify entry, registry.ts:151-158):
```typescript
{
  id: "unipile",
  label: "Unipile (LinkedIn writes)",
  description: "Send LinkedIn connection requests and read relationship status via Unipile's managed-browser API.",
  requiredEnvVars: ["UNIPILE_DSN", "UNIPILE_TOKEN"],
  toolCount: 2,    // linkedin_send_connection + linkedin_get_relationship_status
  loader: () => import("@/connectors/unipile/manifest").then((m) => m.unipileConnector),
},
```

**Deviation notes:**
- `toolCount: 2` MUST match `manifest.tools.length` — the contract test `tests/contract/registry-metadata-consistency.test.ts` will fail otherwise.
- No `hasCustomActive` flag needed (gate by env vars, like apify).
- Position in the array: insert near apify (LinkedIn-adjacent) for readability — order is not functional.

---

### `src/core/credential-store.ts` (MODIFICATION — NO hydration list change needed)

**Analog:** existing `hydrateCredentialsFromKV` (credential-store.ts:131-166) iterates ALL `cred:*` keys generically — there is NO per-key allowlist.

**Code excerpt** (credential-store.ts:139-153):
```typescript
const keys = await kvScanAll(kv, `${CRED_PREFIX}*`);  // generic scan
if (keys.length === 0) return;
const values = kv.mget ? await kv.mget(keys) : await Promise.all(keys.map((k) => kv.get(k)));
for (let i = 0; i < keys.length; i++) {
  const k = keys[i]; if (!k) continue;
  const envKey = k.slice(CRED_PREFIX.length);
  const value = values[i];
  if (value && !getConfig(envKey)) {
    hydratedSnapshot[envKey] = value;
  }
}
```

**Deviation notes (IMPORTANT — CONTEXT.md misalignment):**
- The CONTEXT.md and RESEARCH.md repeatedly state "add `UNIPILE_*` env vars to the hydration list" — **but no such list exists**. The hydrator scans ALL `cred:*` keys and writes them to the snapshot. As long as the operator saves `UNIPILE_DSN` / `UNIPILE_TOKEN` via the dashboard (which writes `cred:UNIPILE_DSN` etc.), hydration works automatically.
- **What IS needed:** ensure the connector reads via `getConfig("UNIPILE_DSN")` (which consults the hydrated snapshot via the config-facade). The research code excerpts already do this.
- **What is NOT needed:** no edit to `credential-store.ts` for phase 68. Plan should call out this clarification in the requirements section. The phase-62 fix (`f623119`) for transient KV failures already protects the new credentials.
- Per-tenant secret env var pattern `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (D-03) is also covered automatically by the generic hydrator.

---

### `tests/contract/kv-allowlist.test.ts` (MODIFICATION per CONTEXT.md)

**Analog:** the file itself (tests/contract/kv-allowlist.test.ts:34-98 — the `ALLOWLIST` Set).

**Deviation notes (CONTEXT.md misalignment):**
- CONTEXT.md says "KV allowlist must be updated (`kv-allowlist` Rule 3 contract test) — add `unipile:audit:*`, `unipile:urn:*`, `unipile:outbox:*` patterns." This conflates two different things:
  1. The actual `tests/contract/kv-allowlist.test.ts` is a **callsite allowlist** for `getKVStore()` (the un-tenanted access function) — it has nothing to do with KV key prefixes.
  2. There is no in-repo KV-key-pattern allowlist.
- **Real change required:** the admin DELETE route (`app/api/admin/unipile/cache/urn/route.ts`) calls raw `getKVStore()` per D-18 escape hatch — that route file MUST be added to `ALLOWLIST` in tests/contract/kv-allowlist.test.ts:34-98, mirroring the pattern of `app/api/admin/rate-limits/route.ts` (line 73). All other unipile code paths use `getContextKVStore()` and do NOT need an allowlist entry.
- Plan should flag this misalignment for the implementer.

---

### `docs/CONNECTORS.md` (MODIFICATION per CONTEXT.md)

**Analog:** `docs/CONNECTORS.md` itself (conventions reference, not a count-claim doc).

**Deviation notes (CONTEXT.md misalignment):**
- CONTEXT.md says "update `docs/CONNECTORS.md` and any tool catalog tables as part of phase 68 commits (UNI-23 is phase 71, but the count drift gate fires earlier)."
- The actual count-drift gate (`scripts/check-doc-counts.ts:122-125`) scans `README.md` + `content/docs/*.md` — NOT `docs/CONNECTORS.md`.
- **Real change required:** check `README.md` and `content/docs/connectors.md` for any "N tools across M connectors" claims. After this phase: `expectedConnectors` goes 16→17 (new unipile dir) and `expectedTools` goes by +2 (per `defineTool(` count in manifest.ts).
- `docs/CONNECTORS.md` may also benefit from a new "Unipile" entry but it's not enforced — discretion.
- Plan should call out: run `npx tsx scripts/check-doc-counts.ts` after manifest landing to enumerate drift sites.

---

## Shared Patterns

### Logger tag
**Source:** `docs/CONNECTORS.md:21-24` + `src/core/logging`
**Apply to:** Every `.ts` file under `src/connectors/unipile/` that logs
```typescript
import { getLogger } from "@/core/logging";
const log = getLogger("CONNECTOR:unipile");
```

### Credential reads (NEVER process.env)
**Source:** `src/core/config-facade.ts` (getConfig); enforced by ESLint rule `kebab/no-direct-process-env`
**Apply to:** All UNIPILE_* env var reads
```typescript
import { getConfig } from "@/core/config-facade";
const dsn = getConfig("UNIPILE_DSN");
```

### Tenant-scoped KV access
**Source:** `src/core/request-context.ts:72-74`
**Apply to:** ALL `src/connectors/unipile/lib/*.ts` files (audit, identifiers, crm-bridge). Admin DELETE route is the documented exception.
```typescript
import { getContextKVStore } from "@/core/request-context";
const kv = getContextKVStore();
```

### Error stringification
**Source:** `src/core/error-utils.ts` (toMsg) — used in apify, github, custom-tools admin routes
**Apply to:** All catch blocks that build user-facing error strings
```typescript
import { toMsg } from "@/core/error-utils";
catch (err) { return NextResponse.json({ error: toMsg(err) }, { status: 500 }); }
```

### Test scaffolding (vi.mock + vi.resetModules)
**Source:** `src/connectors/apify/lib/__tests__/client.test.ts:7-29`
**Apply to:** Every `__tests__/*.test.ts` file in the unipile connector
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
beforeEach(() => { vi.resetModules(); /* set env */ });
afterEach(() => { /* unset env */ });
```

### Admin route auth
**Source:** `src/core/with-admin-auth.ts:49-53`
**Apply to:** `app/api/admin/unipile/cache/urn/route.ts`
```typescript
import { withAdminAuth } from "@/core/with-admin-auth";
export const DELETE = withAdminAuth(deleteHandler);
```

---

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md patterns or invent):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/connectors/unipile/lib/retry.ts` | retry helper | transform | No in-repo `withRetry` exists — fetch-utils has timeout, not backoff. Use RESEARCH.md §Pattern 2 verbatim. |
| `src/connectors/unipile/lib/identifiers.ts` (resolver part) | URL→URN resolver + KV cache | read-through cache | No connector has a slug-resolution + KV-cache pipeline. Use RESEARCH.md §Pattern 3 verbatim; the cron's lock+set pattern is the nearest KV-cache analog. |
| `src/connectors/unipile/lib/audit.ts` (dedup-by-hash part) | secondary-index dedup | event-driven | No in-repo audit ledger with hash-pointer dedup exists. Design per D-05/D-06 (write two keys: row + hash→audit_id pointer). |
| `src/connectors/unipile/lib/crm-bridge.ts` (interface part) | adapter pattern | n/a | No `interface` + concrete-implementation pattern exists in the connector tree — `custom-tools/store.ts` is the closest KV-write idiom. Invent per D-01/D-02. |
| `src/connectors/unipile/tools/linkedin-send-connection.ts` (two-step send + 3-poll verify) | multi-step write w/ verify | request-response + polling | No existing connector implements the "resolve → write → poll-to-verify" pipeline. Use RESEARCH.md §Code Examples lines 399-510 verbatim. |

---

## Metadata

**Analog search scope:**
- `src/connectors/apify/**` (primary analog — same domain, same SDK-wrapper shape)
- `src/connectors/webhook/**` + `app/api/webhook/[name]/route.ts` (HMAC + KV write patterns)
- `src/connectors/github/**` (manifest+tools shape secondary)
- `src/core/registry.ts` (lazy loader entry)
- `src/core/credential-store.ts` (hydration — verified NO change needed)
- `src/core/connector-errors.ts` (typed error classes)
- `src/core/request-context.ts` (getContextKVStore wrapper)
- `src/core/with-admin-auth.ts` (admin HOC)
- `app/api/admin/rate-limits/route.ts` (root-scope escape hatch idiom)
- `app/api/admin/custom-tools/[id]/route.ts` (DELETE handler shape)
- `app/api/cron/update-check/route.ts` (KV lock + set+TTL idiom)
- `tests/contract/kv-allowlist.test.ts` (allowlist scope verified — see deviations)
- `scripts/check-doc-counts.ts` (drift gate scope verified — see deviations)

**Files scanned:** 18 source files + 2 contract tests + 1 script
**Pattern extraction date:** 2026-05-18

---

## PATTERN MAPPING COMPLETE
