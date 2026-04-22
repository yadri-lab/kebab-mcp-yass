/**
 * Phase 49 / TYPE-03 — connector-scoped required-env accessor.
 *
 * Canonical replacement for the 8 `getConfig("X")!` non-null-bang
 * callsites (7 in `src/connectors/browser/lib/browserbase.ts` + 1 in
 * `src/connectors/composio/manifest.ts`). The bang silently UNSAFE-
 * casts a `string | undefined` to `string`; when the env var is in
 * fact missing, the consumer crashes downstream with a confusing
 * "undefined is not a string" / "Invalid API key" message that
 * obscures the root cause (missing env var).
 *
 * `getRequiredEnv(key, connectorName)` throws `McpConfigError` with
 * an actionable message naming BOTH the env var AND the connector the
 * caller belongs to — the pipeline layer catches this and surfaces a
 * 500 response with a generic message while the connector + env var
 * names are logged server-side.
 *
 * Why a wrapper over `getRequiredConfig()` (Phase 48 / FACADE-01):
 * `getRequiredConfig()` throws `McpConfigError(message, key)` — the
 * connector owning the env var is absent from both the message and
 * structured fields. Connector-scoped callers need the richer shape,
 * but we do NOT want to break existing `getRequiredConfig()` callers
 * that don't have (or shouldn't invent) a connector name. So `env-
 * utils` wraps `getConfig()` with the connector-aware message shape
 * and preserves `getRequiredConfig()` unchanged for non-connector
 * callers. See `.planning/phases/49-type-tightening/INVENTORY.md`
 * § JC-1 for the rationale.
 *
 * The helper routes through `getConfig()` (NOT raw `process.env`) so
 * SEC-02's tenant-isolation seam — the request-context credential
 * override via `runWithCredentials()` / `getCredential()` — continues
 * to apply. A connector's apiKey can still be overridden per-request
 * by the pipeline without touching this helper.
 */

import { getConfig } from "./config-facade";
import { McpConfigError } from "./errors";

/**
 * Returns the value of a required env var, or throws `McpConfigError`
 * with an actionable per-connector message.
 *
 * @param key           — The env var name (UPPER_SNAKE_CASE).
 * @param connectorName — The connector that owns this env var (lowercase).
 *                        Surfaced in the thrown error's `.connector`
 *                        field and in the message text.
 */
export function getRequiredEnv(key: string, connectorName: string): string {
  const value = getConfig(key);
  if (value === undefined || value === "") {
    throw new McpConfigError(
      `Connector ${connectorName} requires ${key}. Set it in the dashboard or .env and redeploy.`,
      key,
      connectorName
    );
  }
  return value;
}
