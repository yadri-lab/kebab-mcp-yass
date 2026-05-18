/**
 * Phase 70 / Plan 02 / Task 1 — `account_status` webhook handler (D-57 / D-58).
 *
 * Mutates INTERNAL connector state ONLY — no outbound HTTP. The handler
 * sets a halt flag on `credentials_expired` / `restricted` / `disconnected`
 * transitions so subsequent write-tool invocations short-circuit with
 * `error_account_halted` (Plan 70-03 retrofit), and CLEARS the halt flag
 * on recovery transitions (`OK` / `RECONNECTED` / `CREATION_SUCCESS` /
 * `SYNC_SUCCESS`) so a re-connected account does not stay halted forever
 * (D-78, Anti-Pattern #5).
 *
 * Tenant scope: the webhook ingress route runs WITHOUT an ambient tenant
 * (Unipile POSTs anonymously with the operator's static secret). We resolve
 * the owning tenant via the root-scope reverse index
 * (`getAccountTenant(accountId)`) and then enter `runWithTenant` so every
 * downstream KV write (halt-flag in this handler, audit-row enrichment in
 * the sibling new-relation / message-received handlers) is correctly
 * tenant-scoped via `getContextKVStore()`.
 *
 * Failure modes (all fail-CLOSED):
 *  - Missing `account_id` / `account_status` → warn + return (malformed payload).
 *  - No tenant mapping for `account_id` → warn + return (operator must claim).
 *  - Status neither halt nor recovery → debug + no-op (e.g. transient state).
 *
 * D-71 scope guard: this file is grep-fenced — NO `fetch(`, NO
 * `TwentyAdapter`, NO `notifyEvent`. Pure KV-state mutator.
 */
import { getLogger } from "@/core/logging";
import { runWithTenant } from "@/core/request-context";
import { writeHaltFlag, clearHaltFlag, isHaltStatus, isRecoveryStatus } from "../halt-flag";
import { resolveTenantFromAccountId } from "../dispatcher";

const log = getLogger("CONNECTOR:unipile-webhook");

export async function handleAccountStatus(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.account_id ?? "");
  const status = String(payload.account_status ?? "");

  if (!accountId || !status) {
    log.warn("account_status missing account_id or status", {
      keys: Object.keys(payload),
    });
    return;
  }

  const tenantId = await resolveTenantFromAccountId(accountId);
  if (!tenantId) {
    log.warn("account_status — no tenant mapping (operator must claim account)", {
      accountId,
      status,
    });
    return;
  }

  await runWithTenant(tenantId, async () => {
    if (isHaltStatus(status)) {
      const reason = String(payload.account_status_specifics ?? status);
      await writeHaltFlag(accountId, {
        reason,
        halted_at: new Date().toISOString(),
        status,
      });
      log.warn("account halted", { accountId, status, reason, tenantId });
    } else if (isRecoveryStatus(status)) {
      await clearHaltFlag(accountId);
      log.info("account recovered — halt cleared", { accountId, status, tenantId });
    } else {
      log.debug("account_status no-op (status neither halt nor recovery)", {
        accountId,
        status,
      });
    }
  });
}
