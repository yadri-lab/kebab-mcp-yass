# Phase 68: Unipile Foundation - Research

**Researched:** 2026-05-18
**Domain:** Unipile Node SDK integration into Kebab MCP connector framework
**Confidence:** HIGH (SDK surface verified from upstream source; LinkedIn endpoint shapes verified from Unipile docs; webhook signing details partially verified, flagged as MEDIUM)

## Summary

Phase 68 wires the **Unipile Node SDK v1.9.3** (`unipile-node-sdk` on npm, ISC licensed, published 12 months ago — only version on dist-tag `latest`) into a new `src/connectors/unipile/` connector. The SDK exposes a thin, hand-written client over Unipile's REST API authenticated via the `X-API-KEY` header. **There is no native retry middleware, no built-in webhook signature verifier, and no `posts` resource on the client object** (despite README mentioning posts — they live under `client.users.*`). The connector wraps the SDK behind a Kebab-conventional lazy singleton + retry layer, exactly mirroring the `src/connectors/apify/lib/client.ts` pattern but using the SDK rather than raw fetch.

The phase-defining technical insight is the **two-step send flow**: (1) call `client.users.getProfile({ account_id, identifier: <slug> })` to resolve a `linkedin.com/in/<slug>` URL to a Unipile `provider_id`, then (2) call `client.users.sendInvitation({ account_id, provider_id, message })` to fire the connection request. Step 1's result also yields `network_distance` (FIRST_DEGREE / SECOND_DEGREE / THIRD_DEGREE / OUT_OF_NETWORK), which directly powers the `linkedin_get_relationship_status` read tool — no separate "relationship status" endpoint exists. This makes the URN cache (D-09..D-11) a meaningful latency optimization: caching `slug → provider_id` avoids one extra `getProfile` call per send.

**Primary recommendation:** Build `src/connectors/unipile/lib/client.ts` as a lazy singleton wrapping `UnipileClient` (axios is not exposed by the SDK, so retry is a custom `withRetry()` wrapper that catches `UnsuccessfulRequestError` and inspects `.body.status`). Use the existing `getCredential()` indirection (NOT `process.env` directly, per the Phase 48 facade rule). Map error taxonomy directly from `UnsuccessfulRequestError.body.status` to the audit `result` enum.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**CRM Bridge V1 — Twenty**
- **D-01:** Phase 68 ships the CRM bridge **interface and skeleton only** — no actual Twenty integration. `crm-bridge.ts` writes the outbox entry to KV with `status: 'pending'` and stops there. Twenty propagation lands in phase 70.
- **D-02:** When Twenty integration lands (phase 70), it WILL use the **outbox webhook pattern** (POST to `UNIPILE_CRM_WEBHOOK_URL` per-tenant, HMAC-signed) — not direct Twenty REST API calls. Locked now to anchor the interface design.
- **D-03:** HMAC secret for outbound CRM webhooks is **per-tenant**, via env var `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (e.g. `UNIPILE_CRM_WEBHOOK_SECRET_CADENS_001`).
- **D-04:** Retry strategy for failed CRM webhook deliveries (phase 70): **exponential cron** at 1min, 5min, 30min. After 3 failures, status = `dead`. For phase 68: just write `status: 'pending'`, no actual send, no retry.

**Audit Log**
- **D-05:** `params_hash` is **strict** — SHA-256 of `{tool_name, profile_url_normalized, note_text}`. Same profile + same note text = dedup hit.
- **D-06:** **No `dedup_key` override** — the caller cannot bypass dedup logic.
- **D-07:** Note text is **never stored in KV** — only the hash. Audit row contains: `{actor_user_id, tool, account_id, params_hash, result, verified, dedup_hit, timestamp, audit_id}`.
- **D-08:** Audit log TTL: **90 days** in KV (Upstash native `EX 7776000`). No env var override in phase 68.

**Identifiers Cache**
- **D-09:** Cache lives in **KV Upstash only** (no in-memory LRU). Key format: `unipile:urn:<sha256(normalized_url)>`. Value: `{urn, resolved_at, ttl}`.
- **D-10:** TTL **30 days**. On Unipile 429 rate limit → return **explicit error** to caller (no stale-while-revalidate).
- **D-11:** Manual invalidation via **admin REST endpoint** `DELETE /api/admin/unipile/cache/urn?profile_url=...`. No MCP tool exposure.
- **D-12:** URL normalization rules: lowercase the slug, strip trailing slash, strip locale prefix (`fr.linkedin.com` → `linkedin.com`), accept `linkedin.com/in/<slug>`, `https://linkedin.com/in/<slug>`, `www.linkedin.com/in/<slug>`.

**Verify-After-Write — Strict Mode**
- **D-13:** After 3 polls at 2s/5s/10s (~17s total), if Unipile API doesn't confirm, return **`verified: false`** — strict mode.
- **D-14:** Tool return envelope: `{provider_ok: bool, verified: bool, crm_sync: 'pending', dedup_hit: bool, audit_id: string, invitation_id?: string, error?: string}`. **No `'pending'` enum value anywhere.**
- **D-15:** When `verified: false` due to 3-poll timeout, audit log records `result: 'unverified_timeout'`.
- **D-16:** **No auto re-poll** in phase 68.
- **D-17:** CRM display semantics (phase 70): `verified: false` → CRM shows "Erreur d'envoi - retry" (red icon).

### Claude's Discretion
- Choice of hashing function for `params_hash` (SHA-256 truncated to 16 hex chars recommended for KV key efficiency).
- Internal structure of `client.ts` retry middleware (axios interceptor, fetch wrapper, SDK middleware — whatever the SDK supports natively).
- Error code taxonomy for `result` field (suggested: `success`, `unverified_timeout`, `error_rate_limit`, `error_not_connected`, `error_account_restricted`, `error_unipile_5xx`).
- Test strategy split between unit and integration.

### Deferred Ideas (OUT OF SCOPE)
- Twenty CRM actual integration — phase 70 owns it.
- In-memory LRU tier for URN cache — rejected (Vercel serverless).
- `unipile_audit_today` tool — phase 71 (UNI-22).
- Auto re-poll of `pending` verifications — N/A since we eliminated `pending`.
- Configurable `UNIPILE_AUDIT_TTL_DAYS` env var — defaults-only in phase 68.
- `dedup_key` override — explicitly rejected (D-06).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UNI-01 | `manifest.ts` with `unipile` id, required env vars `UNIPILE_DSN` + `UNIPILE_TOKEN`, `testConnection()` hits `/account/me`, registered in lazy loader; toolCount updated | Section 5 (manifest pattern) + Section 1 (SDK constructor) |
| UNI-02 | `client.ts` — SDK singleton, lazy-init, retry middleware (exp backoff on 5xx/429, max 3), `[CONNECTOR:unipile]` logger tag | Section 1 (no native retry) + Section 7 (logger pattern) |
| UNI-03 | `lib/identifiers.ts` — resolves `linkedin.com/in/<slug>` → Unipile `provider_id` URN with 30-day KV cache, URL variant tests | Section 3 (resolver flow: getProfile then provider_id) |
| UNI-04 | `lib/audit.ts` — writes audit row to KV `audit:unipile:<audit_id>`, PII excluded, returns audit_id | Section 4 (KV patterns) + D-05..D-08 |
| UNI-05 | `lib/crm-bridge.ts` — abstract `CrmAdapter`, Twenty adapter skeleton, outbox pattern (write `crm_log: 'pending'`, no actual send) | Section 4 (outbox KV key) + D-01..D-04 |
| UNI-06 | `linkedin_send_connection` tool + `linkedin_get_relationship_status` tool, 3-poll verify-after-write at 2s/5s/10s, integration test | Sections 1, 2, 3 (full flow) + D-13..D-16 |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Unipile SDK calls (auth, HTTP, retry) | API/Backend | — | All Unipile traffic flows server-side; SDK is Node-only. Vercel lambda. |
| URN cache reads/writes | API/Backend (KV) | — | Upstash KV; per D-09 no in-memory layer. |
| Audit log writes | API/Backend (KV) | — | KV-backed audit ledger; per D-08 90-day Upstash TTL. |
| CRM bridge skeleton (outbox write) | API/Backend (KV) | — | Outbox row to KV under `unipile:outbox:<audit_id>`; actual webhook POST is phase 70. |
| Tool handler (LLM-facing entry) | API/Backend (MCP transport) | — | Tool handlers run inside the `app/api/[transport]/route.ts` lambda. |
| Connector tile rendering | Frontend Server (RSC) | Browser | Tile appears automatically once manifest registers + `isActive(env)` returns true. No new UI work in phase 68. |
| Verify-after-write polling (3 polls 2s/5s/10s) | API/Backend (lambda) | — | Inside the tool handler; total ~17s well under Vercel 60s lambda. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `unipile-node-sdk` | **1.9.3** [VERIFIED: `npm view unipile-node-sdk version` → 1.9.3, 2026-05-18] | Official Unipile Node SDK — wraps REST API for LinkedIn/WhatsApp/Email | Only published `latest` tag; maintained by Unipile employees (gregory-unipile, paulunipile, nico_unipile); 36 total versions; ISC license [VERIFIED: npm registry] |

**Direct dependencies of unipile-node-sdk (3 total):**
- `@sinclair/typebox ^0.31.8` — runtime validation (TypeBox schemas, NOT zod)
- `@types/qrcode ^1.5.2`
- `qrcode ^1.5.3` — for hosted-auth QR codes

[VERIFIED: `npm view unipile-node-sdk`, 2026-05-18]

### Supporting (already in Kebab stack — reuse)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^4.3.6 | Tool schema validation | All `defineTool({ schema })` calls (matches existing convention) |
| Node `crypto` (built-in) | — | SHA-256 for `params_hash` + URL hash | `createHash('sha256').update(...).digest('hex').slice(0, 16)` for KV-key brevity |
| `@/core/kv-store` | — | KV abstraction (Upstash + filesystem) | Audit log, URN cache, outbox |
| `@/core/credential-store` | — | Hydrate `UNIPILE_*` env vars from KV | Modify hydration list (see Section 6) |
| `@/core/config-facade` `getConfig()` | — | Read env vars (NOT `process.env` directly) | Phase 48 lint rule `kebab/no-direct-process-env` enforces this |
| `@/core/error-utils` `toMsg()` | — | Stringify unknown errors | Phase 49 codemod migrated 65 sites to this |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `unipile-node-sdk` | Raw fetch against `https://<dsn>/api/v1/*` with `X-API-KEY` header | SDK gives typed errors (`UnsuccessfulRequestError`) and parameter validation via TypeBox. Raw fetch matches the `apify/lib/client.ts` pattern more closely but loses the type safety. **Verdict: use SDK** — it's the documented path and gives runtime input validation that catches caller mistakes (e.g., missing `account_id`) before the round-trip. |
| Custom retry wrapper | `axios-retry` + adapter | SDK uses raw `fetch` (verified in `src/request-sender.ts`), not axios. A 30-line `withRetry()` helper is simpler than wedging in a different HTTP client. **Verdict: hand-roll retry** modeled on standard exponential-backoff (200ms · 2^n + jitter, max 3 attempts, retry on `body.status ∈ {429, 502, 503, 504}` only). |

**Installation:**
```bash
npm install unipile-node-sdk
```

**Bundle impact check:** SDK unpacked size is 4.2 MB [VERIFIED: `npm view unipile-node-sdk unpackedSize`]. Most of that is `dist/` types + qrcode (qrcode is hosted-auth wizard only — likely tree-shakable if Next 16 / Webpack doesn't pull it in unused). Add a bundle-budget check to the plan: after install, run `npm run size:check` and confirm the `/config` first-load JS doesn't regress beyond the 620 KB ceiling.

### Version verification
```bash
npm view unipile-node-sdk version
# → 1.9.3 (published 12 months ago, 2025-05)
```
**Caveat — staleness:** The SDK has not shipped a new version in 12 months despite Unipile's API surface evolving (the developer.unipile.com docs reference endpoints not yet packaged in the SDK — README explicitly documents this with the `client.request.send()` escape hatch for "Endpoint Not Packaged in SDK"). For phase 68's surface (sendInvitation, getProfile) the SDK is sufficient. Flag for re-check if phase 70 webhooks need newer SDK helpers. [VERIFIED: GitHub repo last commit dates + README escape-hatch section]

## Architecture Patterns

### System Architecture Diagram

```
                  ┌──────────────────────────────────────┐
   MCP Client ──▶ │  app/api/[transport]/route.ts        │  ← Vercel lambda entry
   (Claude)       │  (runs hydrateCredentialsFromKV,     │
                  │   resolveRegistryAsync, withLogging) │
                  └─────────────┬────────────────────────┘
                                │  tool call: linkedin_send_connection
                                ▼
                  ┌──────────────────────────────────────┐
                  │  src/connectors/unipile/             │
                  │  tools/linkedin-send-connection.ts   │
                  │  ┌────────────────────────────────┐  │
                  │  │ 1. normalize URL (lib/ids)     │──┼──▶ unit-tested pure fn
                  │  │ 2. compute params_hash         │  │
                  │  │ 3. CHECK dedup (KV audit)      │──┼──▶ KV: unipile:audit:hash:*
                  │  │ 4. RESOLVE provider_id         │──┼──▶ KV: unipile:urn:<hash>
                  │  │    (cache HIT or SDK.getProfile)│  │  └─ MISS → Unipile API
                  │  │ 5. WRITE outbox row 'pending'  │──┼──▶ KV: unipile:outbox:<id>
                  │  │ 6. SDK.users.sendInvitation()  │──┼──▶ Unipile API (X-API-KEY)
                  │  │ 7. POLL getProfile×3 (2/5/10s) │──┼──▶ verify network_distance
                  │  │ 8. WRITE audit row (result+ver) │──┼──▶ KV: unipile:audit:<id>
                  │  │ 9. RETURN envelope             │  │
                  │  └────────────────────────────────┘  │
                  └──────────────────────────────────────┘

  Read tool path is steps 1, 4, then SDK.users.getProfile (no audit write).

  Admin REST cache eviction:  DELETE /api/admin/unipile/cache/urn?profile_url=...
                              → kv.delete('unipile:urn:' + sha256(normalize(url)))
```

### Recommended Project Structure
```
src/connectors/unipile/
├── manifest.ts                     # ConnectorManifest export, defineTool wrappers
├── client.ts                       # Lazy UnipileClient singleton + withRetry helper
├── lib/
│   ├── identifiers.ts              # URL normalize + resolveUrn (with KV cache)
│   ├── audit.ts                    # writeAuditRow, checkDedup, audit-id gen
│   ├── crm-bridge.ts               # CrmAdapter interface + TwentyAdapterSkeleton + writeOutbox
│   ├── retry.ts                    # withRetry<T>(fn, opts) — exp backoff
│   ├── errors.ts                   # UnipileRateLimitError, UnipileRestrictedError (extend McpToolError)
│   └── __tests__/
│       ├── identifiers.test.ts     # URL variants, hashing
│       ├── audit.test.ts           # dedup logic, TTL
│       ├── crm-bridge.test.ts      # outbox skeleton
│       ├── retry.test.ts           # 429/5xx retry, 422 no-retry
│       └── client.test.ts          # mocked SDK init
├── tools/
│   ├── linkedin-send-connection.ts # schema + handler + verify-after-write
│   └── linkedin-get-relationship-status.ts  # schema + handler
└── README.md                       # connector docs (also referenced from docs/CONNECTORS.md)

app/api/admin/unipile/cache/urn/route.ts    # DELETE handler (D-11)
```

### Pattern 1: Lazy SDK Singleton (mirror of `apify/lib/client.ts`)
**What:** Single `UnipileClient` instance lazily constructed on first use; throws clearly when env vars missing.
**When to use:** All SDK calls go through this getter.
**Example:**
```typescript
// src/connectors/unipile/client.ts
// Source: pattern from src/connectors/apify/lib/client.ts (verified in repo)
import { UnipileClient } from "unipile-node-sdk";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

let client: UnipileClient | null = null;

export function getUnipileClient(): UnipileClient {
  if (client) return client;
  const dsn = getConfig("UNIPILE_DSN");
  const token = getConfig("UNIPILE_TOKEN");
  if (!dsn || !token) {
    throw new Error("UNIPILE_DSN and UNIPILE_TOKEN must be set");
  }
  // Constructor signature [VERIFIED: src/client.ts in upstream SDK]:
  //   constructor(baseUrl: string, token: string, options?: ClientInstantiationOptions)
  // baseUrl pattern: https://<dsn>/api/v1 — the SDK strips this and rebuilds
  // per-request, so passing https://<dsn> alone is enough per README.
  client = new UnipileClient(`https://${dsn}`, token);
  log.info("UnipileClient initialized");
  return client;
}

export function __resetUnipileClientForTests(): void {
  client = null;
}
```

### Pattern 2: withRetry helper (no native SDK support — hand-roll)
**What:** Wrap any SDK call in exponential-backoff retry on 429 / 5xx.
**When to use:** All write paths (`sendInvitation`) AND read paths (`getProfile`) that count toward Unipile rate limits.
**Example:**
```typescript
// src/connectors/unipile/lib/retry.ts
// Source: hand-rolled; SDK has no retry support [VERIFIED: src/request-sender.ts in upstream SDK]
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
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (
        attempt >= max ||
        !(err instanceof UnsuccessfulRequestError) ||
        !RETRYABLE.has((err.body as { status?: number })?.status ?? 0)
      ) {
        throw err;
      }
      // Exponential backoff with jitter: 200ms, 400ms, 800ms (±20%)
      const delay = baseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
```

### Pattern 3: URL → URN resolver with KV cache
**Example:**
```typescript
// src/connectors/unipile/lib/identifiers.ts
import { createHash } from "node:crypto";
import { getContextKVStore } from "@/core/request-context";
import { getUnipileClient } from "../client";
import { withRetry } from "./retry";

const URN_TTL_SECONDS = 30 * 24 * 60 * 60;  // D-10: 30 days

const SLUG_RE = /^https?:\/\/(?:www\.|(?:fr|de|es|it|pt|nl|pl|tr|zh|ja|ko|ar|ru)\.)?linkedin\.com\/in\/([a-z0-9-_%]+)\/?$/i;

export function normalizeProfileUrl(input: string): string {
  // D-12: lowercase slug, strip trailing slash, strip locale prefix,
  // accept www/https variants
  const m = SLUG_RE.exec(input.trim());
  if (!m || !m[1]) throw new Error(`Invalid LinkedIn profile URL: ${input}`);
  const slug = m[1].toLowerCase();
  return `https://linkedin.com/in/${slug}`;
}

function urlHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export async function resolveProviderId(
  rawUrl: string,
  accountId: string
): Promise<{ provider_id: string; from_cache: boolean }> {
  const normalized = normalizeProfileUrl(rawUrl);
  const kv = getContextKVStore();
  const key = `unipile:urn:${urlHash(normalized)}`;

  const cached = await kv.get(key);
  if (cached) {
    const parsed = JSON.parse(cached) as { urn: string };
    return { provider_id: parsed.urn, from_cache: true };
  }

  // Extract slug from normalized URL — that's the `identifier` Unipile accepts
  const slug = normalized.replace("https://linkedin.com/in/", "");
  const client = getUnipileClient();
  // [VERIFIED: GetProfileInput requires account_id + identifier; LinkedIn profile
  //  response includes provider_id (string). See unipile-node-sdk
  //  src/users/ressource.types.ts → LinkedinUserProfileSchema]
  const profile = await withRetry(() =>
    client.users.getProfile({ account_id: accountId, identifier: slug })
  );

  const providerId = (profile as { provider_id: string }).provider_id;
  await kv.set(
    key,
    JSON.stringify({ urn: providerId, resolved_at: new Date().toISOString() }),
    URN_TTL_SECONDS
  );
  return { provider_id: providerId, from_cache: false };
}
```

### Anti-Patterns to Avoid
- **"verified: pending" anywhere.** Hardcoded in D-14. The 2026-05-18 Antoine Vercken incident is the case study. `verified` is strictly boolean. If we don't know, that's `false`.
- **Mutating `process.env` to inject `UNIPILE_*` at request time.** Phase 50 SEC-02 made `credential-store.ts` route through `hydratedSnapshot` instead. New writes must read via `getConfig()` / `getCredential()`.
- **Calling `getKVStore()` directly from the connector.** Use `getContextKVStore()` — `kv-allowlist` contract test (`tests/contract/kv-allowlist.test.ts`) will fail otherwise. The unipile connector is NOT on the allowlist and shouldn't be.
- **In-memory LRU on top of KV cache.** Explicitly rejected (Deferred Ideas). Vercel serverless invalidates the marginal warm-burst benefit.
- **Storing message body / note text anywhere in KV.** D-07 forbids it. SHA-256 hash only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LinkedIn API client | Direct fetch to LinkedIn voyager API | `unipile-node-sdk` | Hand-rolling means re-implementing LinkedIn anti-bot evasion — that's literally the ADR 0001 decision. |
| HTTP retry / backoff | npm `async-retry` or `p-retry` | Local `withRetry()` (~30 lines) | Adding a dep for 30 lines is bundle bloat; only error type to inspect is the SDK's own `UnsuccessfulRequestError`. |
| URN cache abstraction | Memory LRU + KV write-through | KV-only (per D-09) | Vercel kills warm lambdas frequently; the LRU layer is mostly cold-start cost. |
| Webhook signature verifier (phase 70 concern) | New deps like `crypto-verify` | Node `crypto.timingSafeEqual` + `createHmac` | Built-in. The Unipile webhook auth header is a static shared secret per `Unipile-Auth` header (NOT a per-request HMAC of the body, [MEDIUM confidence — see Pitfall 1]). |
| Audit log retention / cleanup | Background cron | Upstash native `EX` TTL | KV `set(key, value, ttlSeconds)` already supported on UpstashKV via `SET key value EX ttl`. Filesystem KV ignores TTL (dev-only). |
| `provider_id` parser | Regex to extract URN from LinkedIn URL | Always call `client.users.getProfile` | The URN format is opaque/internal; LinkedIn returns it server-side. Caching the resolved value is the only safe pattern. |

**Key insight:** Most "is this complex enough to hand-roll" questions reduce to **"is the SDK fast/honest enough?"** Unipile's SDK is honest (typed errors, no silent retries), so we wrap minimally. The two places we DO hand-roll (retry + URN cache) are because the SDK doesn't ship them — not because we want different behavior than what an existing lib would give.

## Runtime State Inventory

Not applicable — phase 68 is greenfield connector work, no rename/refactor/migration.

## Common Pitfalls

### Pitfall 1: Webhook signature verification semantics (relevant to phase 70 — flag now)
**What goes wrong:** Treating the Unipile webhook `Unipile-Auth` header as an HMAC signature when it's actually a shared static secret.
**Why it happens:** The official docs (developer.unipile.com/docs/webhooks-2) describe both — "Each webhook request includes a signature header that you can verify using your webhook secret" suggests HMAC, but the API reference shows you configure a static `Unipile-Auth` header value at webhook creation time. Marketing page (unipile.com/developer-real-time) explicitly says "HMAC signature verification available" — but the API examples show only the static header pattern.
**How to avoid:** **Phase 68 doesn't need this** — webhooks are phase 70 (UNI-12). When phase 70 starts, verify the exact mechanism by creating a real webhook against the live dashboard and inspecting the headers. Worst case it's a static shared secret (still good practice — rotate per tenant per D-03). Best case it's a real HMAC and we use `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')` + `timingSafeEqual`.
**Warning signs:** [MEDIUM confidence] — the docs are contradictory. Don't assume either way until empirically tested.

### Pitfall 2: `getProfile` rate-limit "stealth" cost
**What goes wrong:** The URN cache miss path silently consumes a Unipile read quota call. Under high call volume (e.g., 100 prospects/day with fresh slugs), this doubles API usage vs the assumption that `sendInvitation` is the only call.
**Why it happens:** Step 1 of the send flow ALWAYS calls `getProfile` on cache miss. There's no way to call `sendInvitation` with the URL — Unipile only accepts `provider_id`.
**How to avoid:** Document this in the connector README. At Cadens scale (5-30 calls/day) it's invisible. At >100/day, consider extending TTL beyond 30 days or pre-warming the cache. Already mitigated by D-09 KV cache + D-10 30-day TTL.
**Warning signs:** Dashboard metrics showing > 2× `sendInvitation` calls in `unipile.api.calls`.

### Pitfall 3: `network_distance` returned as missing field for OUT_OF_NETWORK profiles
**What goes wrong:** The `network_distance` field on `LinkedinUserProfileSchema` is `Type.Optional(...)` — meaning a profile response MAY omit it entirely, not just return `"OUT_OF_NETWORK"`. Defensive code assumes "if missing, treat as third-degree" — but missing might mean private profile, deleted user, or just sparse Unipile data.
**Why it happens:** The schema [VERIFIED: src/users/ressource.types.ts in upstream SDK] declares the field optional with 4 valid values: FIRST_DEGREE, SECOND_DEGREE, THIRD_DEGREE, OUT_OF_NETWORK.
**How to avoid:** The `linkedin_get_relationship_status` tool maps `network_distance` → `degree: 1 | 2 | 3 | null`. The `null` case must be explicit ("relationship status unknown"). Don't conflate "unknown" with "third degree."

### Pitfall 4: SDK error envelope shape inconsistency
**What goes wrong:** SDK's `UnsuccessfulRequestError` has `.body` typed as `unknown`. The README example shows `const { status, type } = err.body;` — assuming `body` is `{ status: number, type: string }`. But actual API responses vary: 503 returns may not include a `type` field.
**Why it happens:** TypeBox runtime validation [VERIFIED: SDK source] is on REQUEST validation, not response. SDK body comes from whatever Unipile returns, normalized only minimally.
**How to avoid:** Use a runtime guard before destructuring:
```typescript
function getStatus(err: UnsuccessfulRequestError): number | null {
  const body = err.body as { status?: unknown };
  return typeof body?.status === "number" ? body.status : null;
}
```
**Warning signs:** Tests passing on mocked errors but failing in production with `Cannot read properties of undefined (reading 'status')`.

### Pitfall 5: SDK is 12 months stale relative to API surface
**What goes wrong:** Some Unipile API endpoints (e.g., specific webhook event types added recently) may not have typed SDK methods. README documents the escape hatch: `client.request.send({path, method, parameters, body})`.
**Why it happens:** unipile-node-sdk@1.9.3 published ~2025-05. API surface evolved since.
**How to avoid:** Phase 68 surface (sendInvitation, getProfile) is core and stable in the SDK. Phase 70 webhook handling may need the escape hatch. Document in connector README.

### Pitfall 6: Vercel cold-start SDK initialization cost
**What goes wrong:** SDK unpacked size 4.2 MB — pulled into the transport lambda's trace on first connector activation.
**Why it happens:** Lazy connector loaders (PERF-01, src/core/registry.ts) defer this until `UNIPILE_DSN` + `UNIPILE_TOKEN` are both present, but once active the bundle counts.
**How to avoid:** Already mitigated by PERF-01 lazy loader pattern — only deploys with `UNIPILE_*` env vars pay the cost. Add a bundle size sanity check after install:
```bash
npm run size:check  # current /config ceiling 620 KB
```
Likely impact is on the transport route trace (route.js.nft.json size), not /config first-load JS. Document delta in commit.

### Pitfall 7: KV `set(key, value)` TTL behavior split between backends
**What goes wrong:** `FilesystemKV.set()` ignores TTL (dev-only by design). Tests against filesystem KV won't catch a missing TTL pass.
**Why it happens:** [VERIFIED: src/core/kv-store.ts line 212-224, `_ttlSeconds?: number` parameter is intentionally unused on filesystem backend]
**How to avoid:** Unit tests verify the TTL value is PASSED to `kv.set()` (mock kv, assert call args), not that the key actually expires. Production behavior verified via Upstash dashboard or one integration test against real Upstash.

## Code Examples

### Send connection — full happy path
```typescript
// src/connectors/unipile/tools/linkedin-send-connection.ts
// Sources: D-13/D-14/D-15 envelope contract; SDK sendInvitation signature
// [VERIFIED: src/resources/users.resource.ts in upstream SDK]
import { z } from "zod";
import { defineTool, type ToolResult } from "@/core/types";
import { getUnipileClient } from "../client";
import { withRetry } from "../lib/retry";
import { resolveProviderId } from "../lib/identifiers";
import { computeParamsHash, checkDedup, writeAuditRow, generateAuditId } from "../lib/audit";
import { writeOutboxRow } from "../lib/crm-bridge";

export const linkedinSendConnectionSchema = {
  profile_url: z.string().url(),
  note: z.string().max(300).optional(),
  account_id: z.string(),
  actor_user_id: z.string(),
  allow_existing_pending: z.boolean().optional(),
  crm_log: z.record(z.string(), z.unknown()).optional(),
};

export async function handleLinkedinSendConnection(args: {
  profile_url: string;
  note?: string;
  account_id: string;
  actor_user_id: string;
  allow_existing_pending?: boolean;
  crm_log?: Record<string, unknown>;
}): Promise<ToolResult> {
  const auditId = generateAuditId();
  const paramsHash = computeParamsHash({
    tool: "linkedin_send_connection",
    profile_url: args.profile_url,  // normalized inside
    note: args.note ?? "",
  });

  // 1. Dedup check (D-05/D-06)
  const dup = await checkDedup(paramsHash);
  if (dup) {
    return makeEnvelope({ provider_ok: false, verified: false, dedup_hit: true, audit_id: auditId });
  }

  // 2. Resolve provider_id (KV cache + SDK fallback)
  const { provider_id } = await resolveProviderId(args.profile_url, args.account_id);

  // 3. Outbox row (D-01: skeleton only — write 'pending', no actual send)
  await writeOutboxRow(auditId, { crm_log: args.crm_log ?? null });

  // 4. Send invitation (with retry on 429/5xx)
  // [VERIFIED: PostInvitationInput requires account_id + provider_id; message optional ≤300 chars]
  let invitationId: string | undefined;
  let result: "success" | "unverified_timeout" | "error_rate_limit" | "error_account_restricted" | "error_unipile_5xx" | "error_not_connected" = "unverified_timeout";

  try {
    const resp = await withRetry(() =>
      getUnipileClient().users.sendInvitation({
        account_id: args.account_id,
        provider_id,
        ...(args.note ? { message: args.note } : {}),
      })
    );
    // [VERIFIED: UserInviteApiResponse = {object: "UserInvitationSent", invitation_id: string}]
    invitationId = (resp as { invitation_id: string }).invitation_id;
  } catch (err) {
    result = classifyUnipileError(err);
    await writeAuditRow({
      audit_id: auditId, actor_user_id: args.actor_user_id, tool: "linkedin_send_connection",
      account_id: args.account_id, params_hash: paramsHash, result, verified: false, dedup_hit: false,
    });
    return makeEnvelope({ provider_ok: false, verified: false, dedup_hit: false, audit_id: auditId, error: result });
  }

  // 5. Verify-after-write (D-13: 3 polls at 2s, 5s, 10s; total ~17s)
  const verified = await pollForRelation(args.account_id, provider_id, [2000, 5000, 10000]);
  result = verified ? "success" : "unverified_timeout";

  // 6. Audit
  await writeAuditRow({
    audit_id: auditId, actor_user_id: args.actor_user_id, tool: "linkedin_send_connection",
    account_id: args.account_id, params_hash: paramsHash, result, verified, dedup_hit: false,
  });

  return makeEnvelope({
    provider_ok: true, verified, dedup_hit: false, audit_id: auditId,
    invitation_id: invitationId,
  });
}
```

### Verify-after-write polling helper
```typescript
// Polls getProfile until network_distance becomes FIRST_DEGREE (immediate accept)
// OR until invitation appears in getAllInvitationsSent (pending state confirmed).
// Returns true on either confirmation, false on timeout.
async function pollForRelation(
  accountId: string,
  providerId: string,
  delaysMs: number[]
): Promise<boolean> {
  const client = getUnipileClient();
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const invitations = await client.users.getAllInvitationsSent({ account_id: accountId });
      // [VERIFIED: response shape includes items[] with invited_user_id]
      const items = (invitations as { items?: Array<{ invited_user_id: string | null }> }).items ?? [];
      if (items.some((i) => i.invited_user_id === providerId)) return true;
    } catch {
      // Transient errors during polling are not fatal — continue to next delay
    }
  }
  return false;
}
```

### Classify Unipile error into audit `result` enum
```typescript
import { UnsuccessfulRequestError } from "unipile-node-sdk";

export function classifyUnipileError(err: unknown):
  | "error_rate_limit" | "error_account_restricted"
  | "error_unipile_5xx" | "error_not_connected" {
  if (!(err instanceof UnsuccessfulRequestError)) return "error_unipile_5xx";
  const body = err.body as { status?: unknown; type?: unknown };
  const status = typeof body?.status === "number" ? body.status : 0;
  const type = typeof body?.type === "string" ? body.type : "";

  if (status === 429) return "error_rate_limit";
  if (status === 422 && type.includes("cannot_resend")) return "error_rate_limit"; // LinkedIn-side cap
  if (status === 403 || status === 401) return "error_account_restricted";
  if (status === 404) return "error_not_connected"; // profile gone / not in network
  if (status >= 500) return "error_unipile_5xx";
  return "error_unipile_5xx";
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Browserbase + Stagehand `web_act` for LinkedIn writes | Unipile Node SDK | 2026-05-18 (ADR 0001 + Antoine Vercken incident) | LinkedIn anti-bot defeats DOM automation; Unipile provides server-managed hosted browser with replicated fingerprint |
| Manual webhook polling | Unipile push webhooks with `Unipile-Auth` header | Phase 70 of this milestone | No polling cost; auto retry up to 5× with exponential backoff [VERIFIED: unipile.com/developer-real-time] |
| In-memory cache for hot identifiers | KV-only (D-09) | This phase (Vercel constraints) | Eliminates the LRU+KV double-tier complexity; trades marginal warm-burst latency for predictability |

**Deprecated/outdated:**
- Browserbase-based LinkedIn writes — kept for **read-only** workflows (profile enrichment, posts scraping); confirmed working per ADR 0001. Don't reach for browser connector for any new write tool.

## Project Constraints (from CLAUDE.md)

**Note:** `./CLAUDE.md` is gitignored personal scratchpad (per its own contents). The canonical contributor doc is `docs/ARCHITECTURE.md` — already enumerated in CONTEXT.md's `<canonical_refs>` section. Specific directives applicable to phase 68:

- **No `process.env` direct reads** — use `getConfig()` from `src/core/config-facade`. Enforced by `kebab/no-direct-process-env` ESLint rule (added Phase 48 / FACADE-03). Allowlist at `tests/contract/allowed-direct-env-reads.test.ts`.
- **No `getKVStore()` outside the allowlist** — use `getContextKVStore()` from `src/core/request-context`. Enforced by `tests/contract/kv-allowlist.test.ts`.
- **No new stray `MYMCP_*` env var names** — use `KEBAB_*` prefix for any new env vars; legacy `MYMCP_*` only via alias fallback (BRAND-01..04). Phase 68's net-new env vars are all `UNIPILE_*` so this is moot, but if we add a kill-switch later it's `KEBAB_UNIPILE_*` not `MYMCP_*`.
- **Connector logger tag pattern:** `[CONNECTOR:<id>]` — use `getLogger("CONNECTOR:unipile")` from `src/core/logging`.
- **Tests must use `vi.mock()` not real KV/SDK** — pattern verified in `src/connectors/apify/lib/__tests__/client.test.ts`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js ≥18 | unipile-node-sdk requirement | ✓ (Vercel runtime) | 20.x typical | — |
| npm | install + lint pipeline | ✓ | ≥10 | — |
| `UNIPILE_DSN` env var | client init | ✗ (must be set per deploy) | — | Connector remains inactive — graceful degradation |
| `UNIPILE_TOKEN` env var | client init | ✗ (must be set per deploy) | — | Connector remains inactive |
| Upstash KV | audit log + URN cache + outbox persistence | ✓ in prod (`UPSTASH_REDIS_REST_URL` + `_TOKEN`) | — | Filesystem KV fallback works for local dev but TTL is ignored — dev-only |
| `vitest` test runner | unit + integration tests | ✓ | ^4.1.5 (devDep) | — |
| Husky pre-commit hook | format + lint on commit | ✓ | ^9.1.7 | — |
| Vercel cron (phase 70 prereq, NOT phase 68) | CRM retry cron | (deferred) | — | N/A for phase 68 |

**Missing dependencies with no fallback:** None for phase 68 development. Production deploy needs `UNIPILE_DSN` + `UNIPILE_TOKEN` provisioned per tenant (operator action).

**Missing dependencies with fallback:** None.

## Security Domain

**Note:** Project config doesn't set `security_enforcement` — treating as not strictly enabled, but documenting relevant controls anyway since LinkedIn writes carry compliance risk.

### Applicable Controls

| Control | Applies | Standard Pattern |
|---------|---------|-----------------|
| Input validation (V5) | yes | `zod` schema in `defineTool({ schema })` — already standard. Schema must enforce `note ≤ 300 chars` (LinkedIn limit) and URL parsing via the SDK before any KV write. |
| Cryptography (V6) | yes | Node `crypto.createHash('sha256')` for `params_hash` and URN cache key. Never roll custom hash. `timingSafeEqual` for any future shared-secret comparison (phase 70 webhook). |
| Secrets management | yes | `UNIPILE_DSN` + `UNIPILE_TOKEN` flow through `credential-store.ts` → `hydratedSnapshot` (per SEC-02, NOT `process.env`). Per-tenant CRM webhook secret env var name pattern `UNIPILE_CRM_WEBHOOK_SECRET_<TENANT_ID>` (D-03). |
| Authn for admin REST eviction endpoint | yes | `DELETE /api/admin/unipile/cache/urn` — admin auth via existing `readAdminCookie()` pattern (Phase 50 BRAND-02). |
| PII data minimization (GDPR-aligned) | yes | D-07 mandates hash-only audit log. The note text never enters KV. D-08 enforces 90-day TTL. |
| Audit logging | yes | All write tool invocations write an audit row with actor, tool, account, params_hash, result, verified, dedup_hit, audit_id. |

### Known Threat Patterns

| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| LLM bypasses dedup by varying note text by 1 char | Tampering | Strict hash (D-05) — change of 1 char IS a new call. By design. |
| Tenant A's credentials leak to tenant B via warm lambda | Information Disclosure | `hydratedSnapshot` is operator-scoped, per-tenant secrets read via `getContextKVStore()` per-request scoping. Existing pattern. |
| Adversary spams duplicate connection requests | Denial of Service (vs LinkedIn account) | Dedup (D-05) + future rate limiter (phase 69 UNI-11) |
| Forged CRM outbox writes | Tampering | Per-tenant HMAC secret (D-03), `timingSafeEqual` check on phase 70 receipt (not phase 68) |
| URN cache poisoning | Tampering | KV writes go through `getContextKVStore()` (per-tenant prefixed). Admin DELETE endpoint requires admin auth (D-11). |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Unipile's `Unipile-Auth` webhook header is a **static shared secret** rather than a per-request HMAC of the body | Common Pitfalls §1 | Phase 70 webhook signature verifier might use the wrong algorithm. **Mitigation:** verify empirically in phase 70 by inspecting a real webhook payload before implementing the verifier. Phase 68 doesn't touch this, so no immediate risk. [MEDIUM confidence — docs are contradictory] |
| A2 | The SDK's `UnsuccessfulRequestError.body` exposes `{status, type}` consistently | Common Pitfalls §4 + classifyUnipileError | If body shape differs across error types, `classifyUnipileError` may misclassify some errors as `error_unipile_5xx`. **Mitigation:** the runtime guard already in the code example defaults to `error_unipile_5xx` on unparseable body — fail safe, not silent. [MEDIUM confidence — README example shows this shape but full type isn't enforced] |
| A3 | `getAllInvitationsSent` returns invitations within seconds of `sendInvitation` returning success | pollForRelation helper | If there's a >17s server-side propagation delay between send and listing, every send would return `verified: false` even on real success. **Mitigation:** phase 68 acceptance test re-runs the Antoine Vercken flow — if every test shows `verified: false`, this assumption is wrong. Adjust poll delays or switch verification strategy to `network_distance` polling on `getProfile`. [LOW confidence — no documented latency SLA found] |
| A4 | `linkedin.com/in/<slug>` URL is the only inbound URL format we need to handle | identifiers.ts SLUG_RE | If users paste Sales Navigator URLs (`linkedin.com/sales/people/...`) or activity URLs, normalizer throws. **Mitigation:** explicit error message points to supported formats; doc in tool description. [HIGH confidence — D-12 explicitly enumerates supported formats] |
| A5 | `unipile-node-sdk@1.9.3` (12 months old) still works against current Unipile API | Standard Stack | If Unipile changed the auth header format or response shape, the SDK breaks silently. **Mitigation:** `testConnection()` calls `/account/me` on every connector activation — if SDK breaks, this fails loud. [HIGH confidence — SDK escape hatch `client.request.send()` exists for any unmapped endpoint] |
| A6 | Bundle size impact of unipile-node-sdk + qrcode (4.2 MB unpacked) stays within /config 620 KB ceiling | Standard Stack | If `qrcode` isn't tree-shaken by Next 16, the /config bundle regresses. **Mitigation:** run `npm run size:check` after install in Wave 0; if it fails, switch to dynamic `import("unipile-node-sdk")` inside the client singleton (deferred load). [MEDIUM confidence — connector lazy loaders already isolate the bundle from transport route, but /config tile loads the manifest stub] |

## Open Questions

1. **Webhook signature mechanism (HMAC vs static header)** — see A1 above. Defer resolution to phase 70.
2. **Multi-tenant isolation pattern for `unipile:*` KV keys** — should they be tenant-prefixed (`tenant:<id>:unipile:audit:*`) via `getContextKVStore`, or operator-global? The CONTEXT.md doesn't explicitly say; `getContextKVStore` is the safer default and matches the kv-allowlist contract. **Recommendation:** tenant-prefixed (use `getContextKVStore`). Planner should confirm.
3. **`testConnection()` endpoint name** — README and CONTEXT.md both say `/account/me`, but the SDK exposes `client.account.getAll()` not a `me` endpoint. Likely actual SDK call is `client.account.getAll()` and we verify ≥1 account returned, OR `client.users.getOwnProfile(<first-account-id>)` if we want a per-account smoke test. **Recommendation:** `client.account.getAll()` for the connector-level test, and skip per-account smoke since UNIPILE_DSN/TOKEN alone don't know which account_id to use. Planner should pin.
4. **Where does the `account_id` for `linkedin_send_connection` come from?** Each Unipile token can host multiple accounts (one per LI seat). For phase 68 the simplest assumption is "first LinkedIn account from `client.account.getAll()`", but multi-account tenants need a way to pass `account_id`. **Recommendation:** make `account_id` an OPTIONAL tool param that defaults to "first LinkedIn account if exactly one exists" and throws "account_id required" if multiple exist. Planner should validate.
5. **The README in CONTEXT.md mentions `linkedin_get_relationship_status` returning `last_message_at` and `has_replied` — Unipile doesn't expose those on `getProfile`** (verified — `LinkedinUserProfileSchema` has no such fields). They'd need a separate `messaging.getAllMessagesFromChat` call. **Recommendation:** for phase 68, drop those fields from the response (return only `{degree, connection_status}`); revisit in phase 69 when messaging tools land.

## Sources

### Primary (HIGH confidence)
- **Unipile Node SDK source** [VERIFIED via `gh api repos/unipile/unipile-node-sdk/...`]:
  - `src/client.ts` — constructor signature `(baseUrl, token, options?)`
  - `src/request-sender.ts` — `X-API-KEY` auth header, no native retry
  - `src/resources/users.resource.ts` — all method signatures (sendInvitation, getProfile, getAllInvitationsSent, etc.)
  - `src/resources/webhook.resource.ts` — `create/getAll/delete` only, no signature helper
  - `src/users/ressource.types.ts` — `LinkedinUserProfileSchema` (network_distance enum, all fields)
  - `src/users/user-invite.types.ts` — `UserInviteApiResponse = {object, invitation_id}`
  - `src/errors/request.error.ts` — `UnsuccessfulRequestError(body)` definition
  - README — install + Quick Start + LinkedIn examples + error-handling sample
- **npm registry** [VERIFIED via `npm view unipile-node-sdk`]: version 1.9.3, deps `@sinclair/typebox`, `qrcode`, `@types/qrcode`, license ISC, unpacked 4.2 MB.
- **`src/core/kv-store.ts`** — Upstash `SET key value EX ttl` confirmed line 411; `setIfNotExists`, `mget`, `scan` available; `TenantKVStore` prefixing pattern.
- **`src/core/credential-store.ts`** — `hydrationPromise` memoization fix (commit f623119), `getHydratedCredentialSnapshot()` snapshot pattern, `process.env` precedence.
- **`src/core/registry.ts`** — `ALL_CONNECTOR_LOADERS` lazy entry shape, `toolCount` static metadata requirement.
- **`src/connectors/apify/manifest.ts`** + **`apify/lib/client.ts`** — direct analogue patterns.
- **`tests/contract/kv-allowlist.test.ts`** — confirms unipile connector must use `getContextKVStore()`.

### Secondary (MEDIUM confidence — needs validation in phase 70)
- developer.unipile.com/docs/invite-users — describes the **two-step send flow** (resolve provider_id via `GET /users/{identifier}`, then `POST /users/invite`).
- developer.unipile.com/docs/provider-limits-and-restrictions — LinkedIn 80-100 connects/day cap on paid accounts; 422 `cannot_resend_yet` documented as the LinkedIn-side cap signal.
- developer.unipile.com/docs/api-usage — confirms `X-API-KEY` header and `https://<dsn>/api/v1/` base URL.
- unipile.com/developer-real-time — webhook event names (`invitation_accepted`, `message_received`, `OK`/`CREDENTIALS`/`ERROR` account-status enum, etc.) and 5× auto-retry exponential backoff.

### Tertiary (LOW confidence — flagged in Assumptions Log)
- developer.unipile.com/docs/webhooks-2 — webhook signing mechanism (static `Unipile-Auth` header vs HMAC unclear).
- Linkedin invitation propagation latency (`getAllInvitationsSent` populated within 2s of `sendInvitation` returning success?) — no documented SLA.

## Metadata

**Confidence breakdown:**
- Standard stack (SDK version, deps): **HIGH** — verified against npm registry today (2026-05-18).
- SDK method signatures (sendInvitation, getProfile, etc.): **HIGH** — verified by reading upstream `develop` branch source via GitHub API.
- LinkedIn endpoint shapes (request body, response): **HIGH** — verified against both SDK types and developer.unipile.com docs (cross-confirmed).
- Error code taxonomy (422 / 429 / 403 mapping): **MEDIUM** — primary error codes confirmed in docs; specific 422 `cannot_resend_yet` type string confirmed in WebSearch; full coverage of less-common errors uncertain.
- Architectural patterns (KV usage, credential hydration, manifest registration): **HIGH** — read directly from repo source files.
- Webhook signing mechanism: **LOW** — phase 70 concern; flagged in assumptions.
- Bundle impact estimate: **MEDIUM** — 4.2 MB unpacked is real, but tree-shake behavior under Next 16 / Webpack 5 not measured; mitigation plan in place.

**Research date:** 2026-05-18
**Valid until:** 2026-06-18 (30 days — stable SDK, but recheck npm version if planning slips past 30 days; the gap between SDK v1.9.3 publish date and today is already 12 months, so a new minor could land at any time).

## RESEARCH COMPLETE
