/**
 * Phase 69 / Plan 05 — linkedin_list_pending tool (UNI-10).
 *
 * READ-ONLY counterpart to the three write tools shipped in waves 1-2
 * (send_connection, send_message, send_inmail). Lists pending invitations
 * sent from a connected LinkedIn account so operators can run cleanup
 * loops — typically: "show me invitations sent >30 days ago without a
 * note, so I can withdraw them and free quota for fresh outreach".
 *
 * **Read-only invariants (D-37 — non-mutating, `destructiv` flag false):**
 *   - NO audit row written (no PII transit; the recipient list is what
 *     the caller asked for).
 *   - NO rate-limit check (read calls don't count against LinkedIn's
 *     80-100 connects/day cap that the rate-limiter guards).
 *   - NO dedup key (idempotent — repeating the call returns the same
 *     state of the world, never mutates LinkedIn).
 *   - NO CRM bridge (no write event to bridge).
 *
 * **D-34 (envelope shape):** `{count, items: [{invitation_id,
 * recipient_profile_url, recipient_name, sent_at, age_days, has_note}]}`.
 * `has_note` is the cleanup-loop signal — invitations sent without a
 * personal note convert worst and are the first to withdraw.
 *
 * **D-35 (client-side age filter):** Unipile's `getAllInvitationsSent`
 * accepts ONLY `{account_id, limit?, cursor?}` — there is NO date filter
 * parameter at all (verified against
 * unipile-node-sdk@1.9.3 — see
 * node_modules/unipile-node-sdk/dist/types/users/user-invitation-sent-list.types.d.ts).
 * The `older_than_days` filter is therefore applied AFTER the fetch by
 * computing `age_days = floor((now - parsed_datetime) / 86_400_000)`
 * and comparing.
 *
 * **D-36 (pagination):** Unipile caps each page at 100 items. We
 * paginate via the cursor field until either (a) cursor is null
 * (no more pages) or (b) the collected items reach the user's `limit`
 * (default 100, capped at 500). A MAX_PAGES=10 safety cap prevents
 * runaway loops if the API misbehaves and never returns cursor=null
 * (500 limit / 100-per-page = 5 typical, 10 leaves headroom).
 *
 * **parsed_datetime null filter (RESEARCH §3.1):** Some old/corrupted
 * invitations have `parsed_datetime: null` — we can't compute `age_days`
 * for those, so they are silently filtered out rather than surfaced
 * with a garbage value.
 *
 * **recipient_profile_url derivation:** Unipile returns the user slug
 * as `invited_user_public_id` ("adriengaignebet") — we expand it to a
 * full LinkedIn URL (`https://linkedin.com/in/adriengaignebet`) so the
 * envelope is operator-clickable. Items with no slug get `null`.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveAccountId } from "../lib/account";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

// ──────────────────────────────────────────────────────────────────────────
// Schema (D-36 — limit default 100, cap 500)
// ──────────────────────────────────────────────────────────────────────────
export const linkedinListPendingSchema = {
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id (D-20 — optional if exactly 1 LinkedIn account connected; required if 0 or ≥2)."
    ),
  older_than_days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Client-side filter — only return invitations whose age_days >= this value. " +
        "Useful for cleanup loops: 'show me invitations sent >30 days ago with no reply'. " +
        "Applied AFTER fetch (the Unipile API has no server-side date filter — D-35)."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(100)
    .describe(
      "Max items to return (default 100, hard cap 500 — D-36). Pagination is handled via " +
        "Unipile cursor under the hood; multiple round-trips may be made (per-page cap is 100)."
    ),
};

type ListPendingArgs = {
  account_id?: string;
  older_than_days?: number;
  limit?: number;
};

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
interface InvitationItem {
  id?: string;
  date?: string;
  parsed_datetime?: string | null;
  invitation_text?: string | null;
  invited_user?: string | null;
  invited_user_id?: string | null;
  invited_user_public_id?: string | null;
  invited_user_description?: string | null;
}

interface PendingInvitation {
  invitation_id: string;
  recipient_profile_url: string | null;
  recipient_name: string | null;
  sent_at: string;
  age_days: number;
  has_note: boolean;
}

interface ListPendingEnvelope {
  count: number;
  items: PendingInvitation[];
  error?: string;
  available_accounts?: string[];
}

function envelope(e: ListPendingEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}

// ──────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────
export async function handleLinkedinListPending(args: ListPendingArgs): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 100, 500);

  // === Step 1: account_id resolution (D-20 via shared helper) =============
  // `exactOptionalPropertyTypes: true` (carried from phase 68 D-13/D-14):
  // omit the property entirely when undefined rather than passing
  // `{account_id: undefined}` which the strict type rejects.
  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    return envelope({
      count: 0,
      items: [],
      error: acct.error,
      ...(acct.error === "error_account_id_required"
        ? { available_accounts: acct.available_accounts }
        : {}),
    });
  }
  const accountId = acct.accountId;

  // === Step 2: paginate Unipile (per-page cap 100; loop until cursor null
  //             OR collected items reach `limit`; MAX_PAGES=10 runaway-safety) =
  const allItems: InvitationItem[] = [];
  let cursor: string | null = null;
  let pageNum = 0;
  const MAX_PAGES = 10;

  do {
    const remaining = limit - allItems.length;
    const pageLimit = Math.min(remaining, 100);
    if (pageLimit <= 0) break;

    const resp: unknown = await withRetry(() =>
      getUnipileClient().users.getAllInvitationsSent({
        account_id: accountId,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
        // NOTE: NO server-side date filter parameter is available — verified
        // absent from UserInvitationSentListQueryDTO in
        // unipile-node-sdk@1.9.3 (D-35); see file-header comment.
      })
    );
    const items = (resp as { items?: InvitationItem[] }).items ?? [];
    allItems.push(...items);
    cursor = (resp as { cursor?: string | null }).cursor ?? null;
    pageNum += 1;
    if (pageNum >= MAX_PAGES) {
      log.warn("linkedin_list_pending hit MAX_PAGES safety cap", {
        account_id: accountId,
        pageNum,
        allItemsCount: allItems.length,
      });
      break;
    }
  } while (cursor && allItems.length < limit);

  // === Step 3: shape + client-side filter (D-34 + D-35) ===================
  const now = Date.now();
  const shaped: PendingInvitation[] = allItems
    .filter(
      (i): i is InvitationItem & { id: string; parsed_datetime: string } =>
        i.parsed_datetime !== null &&
        i.parsed_datetime !== undefined &&
        typeof i.id === "string" &&
        i.id.length > 0
    )
    .map((i) => {
      const sentAt = i.parsed_datetime;
      const ageDays = Math.floor((now - new Date(sentAt).getTime()) / 86_400_000);
      return {
        invitation_id: i.id,
        recipient_profile_url:
          typeof i.invited_user_public_id === "string" && i.invited_user_public_id.length > 0
            ? `https://linkedin.com/in/${i.invited_user_public_id}`
            : null,
        recipient_name: i.invited_user ?? null,
        sent_at: sentAt,
        age_days: ageDays,
        has_note: typeof i.invitation_text === "string" && i.invitation_text.length > 0,
      };
    })
    .filter((i) => args.older_than_days === undefined || i.age_days >= args.older_than_days);

  return envelope({ count: shaped.length, items: shaped });
}
