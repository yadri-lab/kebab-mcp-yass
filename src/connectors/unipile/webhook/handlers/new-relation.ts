/**
 * Phase 70 / Plan 02 / Task 2 — `new_relation` webhook handler (D-61 / D-78).
 *
 * Fires when a LinkedIn invitation is ACCEPTED by the recipient. The
 * upstream send was probably emitted by `linkedin-send-connection` 1h–8h
 * earlier (D-77 — Unipile's `new_relation` event arrives with substantial
 * delay; the bounded reverse-lookup in `findAuditByProviderId` covers a
 * ~7-day window by default).
 *
 * Two outcomes:
 *  1. The matching audit row is found → enrich it in-place by appending
 *     `accepted_at: now` and re-persisting via `writeAuditRow` under the
 *     SAME audit_id (no new row, no dedup-key drift).
 *  2. No matching row → insert a NEW standalone audit row with result
 *     `inbound_accept_unknown_origin` (D-78). This happens when the
 *     originating send predates phase 70's `recipient_provider_id`
 *     enrichment in phase 68/69 write tools (which is most rows today).
 *
 * D-71 scope guard: NO outbound HTTP. The future audit-query tool
 * (UNI-22, phase 71) is how the LLM caller surfaces "who accepted my
 * invite?" — this handler just writes the state for that tool to read.
 */
import { getLogger } from "@/core/logging";
import { runWithTenant } from "@/core/request-context";
import { resolveTenantFromAccountId } from "../dispatcher";
import {
  findAuditByProviderId,
  writeAuditRow,
  generateAuditId,
  type AuditRow,
} from "../../lib/audit";

const log = getLogger("CONNECTOR:unipile-webhook");

export async function handleNewRelation(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.account_id ?? "");
  const userProviderId = String(payload.user_provider_id ?? "");

  if (!accountId || !userProviderId) {
    log.warn("new_relation missing account_id or user_provider_id", {
      keys: Object.keys(payload),
    });
    return;
  }

  const tenantId = await resolveTenantFromAccountId(accountId);
  if (!tenantId) {
    log.warn("new_relation — no tenant mapping (operator must claim account)", {
      accountId,
    });
    return;
  }

  await runWithTenant(tenantId, async () => {
    const matching = await findAuditByProviderId(userProviderId);
    const acceptedAt = new Date().toISOString();

    if (matching) {
      // D-61: enrich in-place; same audit_id keeps the dedup pointer
      // valid and downstream queries stable.
      const enriched: AuditRow = { ...matching, accepted_at: acceptedAt };
      await writeAuditRow(enriched);
      log.info("new_relation — enriched audit row", {
        audit_id: matching.audit_id,
        accepted_at: acceptedAt,
        accountId,
      });
    } else {
      // D-61 / D-78 fallback: standalone inbound row. Anti-Repudiation
      // (T-70-02-04) — every inbound event is recorded even if the
      // originating audit row predates the phase-70 enrichment fields.
      const row: AuditRow = {
        audit_id: generateAuditId(),
        actor_user_id: "system",
        tool: "webhook:new_relation",
        account_id: accountId,
        params_hash: "inbound",
        result: "inbound_accept_unknown_origin",
        verified: true,
        dedup_hit: false,
        timestamp: acceptedAt,
        recipient_provider_id: userProviderId,
        accepted_at: acceptedAt,
      };
      await writeAuditRow(row);
      log.info("new_relation — standalone inbound row (no matching origin)", {
        audit_id: row.audit_id,
        accountId,
        recipient: userProviderId,
      });
    }
  });
}
