/**
 * Phase 69 / Plan 01 — shared D-20 LinkedIn account resolver.
 *
 * Extracted from `tools/linkedin-send-connection.ts` (and its duplicate in
 * `linkedin-get-relationship-status.ts`) so the 4 phase-69 tools
 * (`linkedin_send_message`, `linkedin_send_inmail`, `linkedin_engage`,
 * `linkedin_list_pending`) + the retrofit of `linkedin_send_connection`
 * can all share one source of truth. PATTERNS.md flagged the looming
 * 4-way drift as the highest-leverage anti-drift extraction in phase 69;
 * shipping in Wave 1 unblocks Wave 2 plans to import this directly.
 *
 * D-20 behavior (LOCKED from phase 68):
 *   - explicit `args.account_id` → use silently (NO `account.getAll` call,
 *     no surprise side effects, no extra round-trip).
 *   - else `account.getAll()` → filter `type === "LINKEDIN"`:
 *     · 0 → `{ error: "error_no_linkedin_account" }`
 *     · 1 → `{ accountId }`                           (silent)
 *     · ≥2 → `{ error: "error_account_id_required",
 *               available_accounts: string[] }`
 *
 * The phase-68 tools (`linkedin-send-connection.ts`,
 * `linkedin-get-relationship-status.ts`) keep their LOCAL copies of this
 * function in THIS plan to avoid coupling Wave 1 with the existing tools'
 * test surface. Wave 2/3 plans (03/04/05/06) will switch them to import
 * from here — at that point the local copies are deleted.
 *
 * D-16 (transient handling): the `account.getAll()` call is wrapped in
 * `withRetry` so transient 429/5xx do not surface as `error_no_linkedin_account`.
 * A persistent failure throws the underlying `UnsuccessfulRequestError` to the
 * caller, which classifies it via `classifyUnipileError` as usual.
 */

import { getUnipileClient } from "./client";
import { withRetry } from "./retry";

interface ResolveArgs {
  account_id?: string;
}

interface UnipileAccountItem {
  id: string;
  type: string;
}

export type AccountResolution =
  | { accountId: string }
  | { error: "error_no_linkedin_account" }
  | { error: "error_account_id_required"; available_accounts: string[] };

export async function resolveAccountId(args: ResolveArgs): Promise<AccountResolution> {
  if (args.account_id) return { accountId: args.account_id };
  const resp = await withRetry(() => getUnipileClient().account.getAll());
  const items = (resp as { items?: UnipileAccountItem[] }).items ?? [];
  const linkedinAccounts = items.filter((i) => i.type === "LINKEDIN").map((i) => i.id);
  if (linkedinAccounts.length === 0) return { error: "error_no_linkedin_account" };
  if (linkedinAccounts.length > 1) {
    return { error: "error_account_id_required", available_accounts: linkedinAccounts };
  }
  return { accountId: linkedinAccounts[0]! };
}
