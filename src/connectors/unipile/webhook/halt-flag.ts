/**
 * Phase 70 / Plan 01 / Task 1 — Halt-flag KV helpers (D-57 / D-58 / D-78).
 *
 * A halt flag marks a Unipile account as "do not write to me" because
 * upstream signaled credentials_expired / disconnected / restricted etc.
 * Stored under `unipile:halt:<account_id>` via `getContextKVStore()`
 * (auto-prefixed to `tenant:<id>:unipile:halt:<account_id>` per the v0.11
 * tenant-scoping pattern — same idiom as `unipile:audit:*` / `unipile:urn:*`).
 *
 * Two pre-flight consumers (Plan 04 retrofit):
 *   - LinkedIn write tools call `readHaltFlag(accountId)` BEFORE dedup-check;
 *     if non-null, return an early `result:error_halted` envelope.
 *   - WhatsApp `whatsapp_send_message` calls the same gate.
 *
 * Write/clear is triggered by the `account_status` webhook handler (Plan 02):
 *   - Halt status (D-57) → `writeHaltFlag()`
 *   - Recovery status (D-78) → `clearHaltFlag()`
 *
 * D-78 — Anti-Pattern #5 (RECOVERY_STATUSES is load-bearing):
 *   Without `RECOVERY_STATUSES`, a tenant that re-connects an account
 *   after a credentials-expired event would stay halted forever. Both
 *   sets are exported so consumers can branch without re-implementing
 *   the membership tests.
 */
import { getContextKVStore } from "@/core/request-context";

export interface HaltFlag {
  reason: string;
  halted_at: string;
  status: string;
}

/**
 * Status codes that should HALT the account.
 * Mixed-case is intentional — Unipile sends both shapes depending on
 * the source (`account_status` webhook vs `account.account_status` field).
 * Membership test treats them as opaque tags, no normalization.
 */
export const HALT_STATUSES = new Set<string>([
  "credentials_expired",
  "CREDENTIALS",
  "restricted",
  "ERROR",
  "disconnected",
  "DELETED",
]);

/**
 * Status codes that should CLEAR the halt flag (account recovered).
 * D-78: missing this set = accounts stay halted forever after a transient
 * disconnect. Operator only sees "still halted" in the dashboard until they
 * manually nuke the KV row — terrible UX.
 */
export const RECOVERY_STATUSES = new Set<string>([
  "OK",
  "CREATION_SUCCESS",
  "RECONNECTED",
  "SYNC_SUCCESS",
]);

function haltKey(accountId: string): string {
  return `unipile:halt:${accountId}`;
}

export async function readHaltFlag(accountId: string): Promise<HaltFlag | null> {
  const raw = await getContextKVStore().get(haltKey(accountId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HaltFlag;
  } catch {
    // Corrupt JSON — fail OPEN (treat as no halt) rather than blocking
    // every future write on garbage state. Mirror the `audit.ts checkDedup`
    // shape-defensive pattern.
    return null;
  }
}

export async function writeHaltFlag(accountId: string, flag: HaltFlag): Promise<void> {
  await getContextKVStore().set(haltKey(accountId), JSON.stringify(flag));
}

export async function clearHaltFlag(accountId: string): Promise<void> {
  await getContextKVStore().delete(haltKey(accountId));
}

export function isHaltStatus(s: string): boolean {
  return HALT_STATUSES.has(s);
}

export function isRecoveryStatus(s: string): boolean {
  return RECOVERY_STATUSES.has(s);
}
