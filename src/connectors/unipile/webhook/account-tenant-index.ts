/**
 * Phase 70 / Plan 01 / Task 1 — Account → Tenant reverse index (D-56).
 *
 * Maps a Unipile `account_id` to the tenant that owns it. Lives at the
 * ROOT KV scope (not tenant-scoped) under `unipile:account-tenant:<account_id>`
 * because the webhook ingress route has NO tenant context at request time
 * — Unipile POSTs with the operator's static `Unipile-Auth` secret and a
 * payload whose `account_id` field is the ONLY hook back to a tenant.
 *
 * Lifecycle:
 *   - WRITTEN by the dashboard's account-claim flow (operator says
 *     "this LinkedIn/WhatsApp account belongs to tenant X" — NOT
 *     implemented in this phase; tracked for the operator dashboard).
 *   - WRITTEN opportunistically by the webhook dispatcher when a payload
 *     carries both `account_id` and `tenant_id` (defense-in-depth for
 *     the dashboard-omitted case — Plan 02 wires this).
 *   - READ by the dispatcher's `resolveTenantFromAccountId(accountId)`
 *     before invoking `runWithTenant(tenantId, ...)` for tenant-scoped
 *     handler work.
 *
 * Stored as a plain string (no JSON envelope) — single scalar = minimal
 * serialization cost. Mappings have no TTL because they're stable for
 * the lifetime of the operator's Unipile-side account.
 *
 * KV ALLOWLIST: this module uses `getKVStore()` (ROOT scope) and is
 * registered in `tests/contract/kv-allowlist.test.ts` (Phase 70 / Task 3
 * adds the entry). The rationale is identical to the other webhook
 * ingress allowlist entry (`app/api/unipile/webhook/route.ts`) — no
 * tenant context exists at the call site, by design.
 */
import { getKVStore } from "@/core/kv-store";

function indexKey(accountId: string): string {
  return `unipile:account-tenant:${accountId}`;
}

/**
 * Record that `accountId` belongs to `tenantId`. No-ops on empty / whitespace
 * inputs (defensive against caller bugs that pass undefined-y values).
 */
export async function writeAccountTenantMapping(
  accountId: string,
  tenantId: string
): Promise<void> {
  if (!accountId) return;
  const trimmed = tenantId.trim();
  if (!trimmed) return;
  await getKVStore().set(indexKey(accountId), trimmed);
}

/**
 * Resolve the tenant that owns `accountId`, or null if no mapping exists.
 * Trims the stored value defensively (legacy writes may have shipped
 * whitespace).
 */
export async function getAccountTenant(accountId: string): Promise<string | null> {
  if (!accountId) return null;
  const raw = await getKVStore().get(indexKey(accountId));
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
