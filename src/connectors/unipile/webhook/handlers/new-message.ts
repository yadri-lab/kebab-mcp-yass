/**
 * Phase 70 / Plan 02 / Task 2 — `message_received` webhook handler
 * (D-63 / D-64 / D-78).
 *
 * Fires on every inbound chat message Unipile sees on the connected
 * account. Two outcomes:
 *  1. The matching audit row (originally a `linkedin_send_message` send
 *     to the same `recipient_provider_id`) is found → enrich with
 *     `last_replied_at: now` and re-persist under the same audit_id.
 *  2. No matching row → insert standalone audit row with result
 *     `inbound_message_unknown_origin` (D-78).
 *
 * CRITICAL — D-63 echo skip: Unipile emits `message_received` for BOTH
 * inbound AND outbound (`is_sender: true` marks our own outbound).
 * The dispatcher (Plan 70-01) drops `is_sender:true` BEFORE invoking
 * this handler, but we double-check defensively here with a warn log
 * — if a future dispatcher refactor regresses, this guard fires.
 *
 * CRITICAL — D-64 GDPR: message bodies NEVER leave Kebab. Only the
 * SHA-256 truncated 16-char content_hash is persisted in `params_hash`
 * as the prefix `inbound:<hash>`. The body is consumed exactly once in
 * `hashBody()` and never assigned to a variable that flows into the
 * AuditRow. JSON.stringify of the row will not contain the body text.
 * Tests assert this via substring inspection.
 *
 * D-71 scope guard: NO outbound HTTP. No CRM POST. No Slack notify.
 * Pure KV-state mutator.
 */
import { createHash } from "node:crypto";
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

/**
 * SHA-256 → 16 hex chars over the message body (or `payload.message`
 * fallback). Empty input hashes to `e3b0c4429f00ad2c` deterministically;
 * that's fine — it's still a stable identifier.
 *
 * The body text is read ONCE inside this function and never escapes.
 */
function hashBody(payload: Record<string, unknown>): string {
  const text = String(payload.body ?? payload.message ?? "");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export async function handleMessageReceived(payload: Record<string, unknown>): Promise<void> {
  // D-63 defense-in-depth: dispatcher already filtered is_sender:true.
  // If we still see one here, log loud and skip — a regression in the
  // dispatcher must not silently leak echoes into the audit log.
  if (payload.is_sender === true) {
    log.warn("handleMessageReceived saw is_sender:true — dispatcher filter missed", {
      message_id: payload.message_id,
    });
    return;
  }

  const accountId = String(payload.account_id ?? "");
  const messageId = String(payload.message_id ?? "");

  if (!accountId || !messageId) {
    log.warn("message_received missing account_id or message_id", {
      keys: Object.keys(payload),
    });
    return;
  }

  const tenantId = await resolveTenantFromAccountId(accountId);
  if (!tenantId) {
    log.warn("message_received — no tenant mapping (operator must claim account)", {
      accountId,
    });
    return;
  }

  await runWithTenant(tenantId, async () => {
    const senderProviderId = String(
      payload.attendee_provider_id ?? payload.sender_attendee_id ?? ""
    );
    const lastRepliedAt = new Date().toISOString();
    const contentHash = hashBody(payload); // D-64 — only the hash leaves the lambda

    const matching = senderProviderId ? await findAuditByProviderId(senderProviderId) : null;

    if (matching) {
      const enriched: AuditRow = { ...matching, last_replied_at: lastRepliedAt };
      await writeAuditRow(enriched);
      log.info("message_received — enriched audit row", {
        audit_id: matching.audit_id,
        last_replied_at: lastRepliedAt,
        accountId,
      });
    } else {
      // D-78 fallback: standalone inbound row, hash-only (D-64).
      // recipient_provider_id is omitted (not set to undefined) when the
      // sender id is missing — `exactOptionalPropertyTypes: true` disallows
      // explicit-undefined assignment to optional fields.
      const row: AuditRow = {
        audit_id: generateAuditId(),
        actor_user_id: "system",
        tool: "webhook:message_received",
        account_id: accountId,
        params_hash: `inbound:${contentHash}`, // hash-only — D-64
        result: "inbound_message_unknown_origin",
        verified: true,
        dedup_hit: false,
        timestamp: lastRepliedAt,
        last_replied_at: lastRepliedAt,
        ...(senderProviderId ? { recipient_provider_id: senderProviderId } : {}),
      };
      await writeAuditRow(row);
      log.info("message_received — standalone inbound row (no matching origin)", {
        audit_id: row.audit_id,
        accountId,
        content_hash: contentHash,
      });
    }
  });
}
