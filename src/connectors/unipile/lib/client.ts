/**
 * Phase 68 / Plan 02 / Task 1 — Lazy UnipileClient singleton.
 *
 * Owns the per-lambda lifecycle of the Unipile SDK client:
 *  - Lazy construction on first `getUnipileClient()` call.
 *  - Memoization across repeat calls within the same warm container (one
 *    `new UnipileClient(...)` per cold start, not per tool invocation).
 *  - Clear failure when UNIPILE_DSN or UNIPILE_TOKEN is missing — throws
 *    BEFORE invoking the SDK constructor so misconfigured deploys fail
 *    loud rather than producing a half-initialized client.
 *  - `__resetUnipileClientForTests()` for vitest isolation (mirrors the
 *    test-only escape hatch in src/core/credential-store.ts:resetHydrationFlag).
 *  - `sanitizeUnipileText()` redacts the live UNIPILE_TOKEN from any
 *    operator-visible error string (T-68-02-01 mitigation).
 *
 * Mirrors the apify connector's client pattern (src/connectors/apify/lib/client.ts)
 * for credential indirection through getConfig() — never raw env reads
 * (enforced by the `kebab/no-direct-process-env` ESLint rule).
 */

import { UnipileClient } from "unipile-node-sdk";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

let client: UnipileClient | null = null;

/**
 * Returns a memoized UnipileClient instance for this warm lambda.
 *
 * Resolution order: cache → getConfig("UNIPILE_DSN") + getConfig("UNIPILE_TOKEN")
 * → `new UnipileClient(normalizedDsn, token)`.
 *
 * Throws if either env var is missing — the SDK constructor is never
 * invoked with empty strings (avoids constructing a doomed client).
 *
 * SDK constructor signature [VERIFIED: src/client.ts in unipile-node-sdk@1.9.3]:
 *   constructor(baseUrl: string, token: string, options?: ClientInstantiationOptions)
 * Base URL pattern: `https://${dsn}` — SDK appends `/api/v1` internally.
 *
 * **DSN format tolerance:** Unipile's dashboard ships the DSN with
 * `https://` already included (e.g. `https://api41.unipile.com:17153`),
 * but the Kebab convention in the test suite is to set
 * `UNIPILE_DSN=api41.unipile.com:17153` (host:port only) and let the
 * client prepend the protocol. We accept BOTH shapes — a DSN that
 * already starts with `https://` or `http://` is passed through; a
 * bare host:port gets `https://` prepended. This avoids surprising the
 * operator who copy-pastes verbatim from the Unipile dashboard.
 */
function normalizeDsn(dsn: string): string {
  return /^https?:\/\//i.test(dsn) ? dsn : `https://${dsn}`;
}

export function getUnipileClient(): UnipileClient {
  if (client) return client;
  const dsn = getConfig("UNIPILE_DSN");
  const token = getConfig("UNIPILE_TOKEN");
  if (!dsn || !token) {
    throw new Error("UNIPILE_DSN and UNIPILE_TOKEN must be set");
  }
  client = new UnipileClient(normalizeDsn(dsn), token);
  log.info("UnipileClient initialized");
  return client;
}

/**
 * Test-only: reset the module-scope cache between tests.
 *
 * Mirrors the test-isolation seam established by `resetHydrationFlag()`
 * in src/core/credential-store.ts:171. Never call from production code.
 */
export function __resetUnipileClientForTests(): void {
  client = null;
}

/**
 * Redact the live UNIPILE_TOKEN value from arbitrary text before surfacing
 * it to operators (logs, error responses, dashboard messages).
 *
 * Strategy: split-join on the literal token value. A no-op when the token
 * isn't set (early-boot, fresh-install, post-reset). T-68-02-01 mitigation
 * — verified by test "sanitizeUnipileText redacts the token value".
 */
export function sanitizeUnipileText(text: string): string {
  const token = getConfig("UNIPILE_TOKEN");
  if (!token) return text;
  return text.split(token).join("<redacted>");
}
