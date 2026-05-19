/**
 * linkedin_list_inbox tool — READ-ONLY inbox/conversation lister.
 *
 * Lists LinkedIn conversations from a connected account so operators can
 * answer "what came in recently / what's unread". Mirrors the read-only
 * invariants established by linkedin_list_pending (UNI-10):
 *   - NO audit row (no PII transit beyond what the caller asked for).
 *   - NO rate-limit check (reads don't count against LinkedIn write caps).
 *   - NO dedup (idempotent — never mutates LinkedIn).
 *   - NO CRM bridge (no write event to bridge).
 *
 * Source: Unipile `messaging.getAllChats({account_id, unread?, after?,
 *   limit?, cursor?})`. Filtering uses the API's native params where
 *   available (unread, after) — verified live against the deployed account
 *   2026-05-20. Per-page cap is 100; we paginate via cursor up to the
 *   requested limit with a MAX_PAGES safety cap.
 *
 * Envelope: {count, items: [{chat_id, attendee_provider_id, attendee_name,
 *   unread, unread_count, last_message_at, folder}]}.
 *   attendee_name is only present when the chat object carries it (1:1 LI
 *   chats often have name:null — the human name lives on the attendee, which
 *   would cost an extra round-trip per chat; we deliberately do NOT fetch it
 *   here to keep the inbox call cheap. Use linkedin_read_messages for the
 *   resolved name on a specific thread).
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveAccountId } from "../lib/account";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

export const linkedinListInboxSchema = {
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id (optional if exactly 1 LinkedIn account connected; required if 0 or ≥2)."
    ),
  unread_only: z
    .boolean()
    .optional()
    .describe("If true, only return conversations with unread messages (native Unipile filter)."),
  since_days: z
    .number()
    .int()
    .positive()
    .max(365)
    .optional()
    .describe(
      "Only return conversations whose last message is within the last N days (native Unipile `after` filter). Capped at 365."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe("Max conversations to return (default 50, hard cap 200). Paginated via cursor."),
};

type ListInboxArgs = {
  account_id?: string;
  unread_only?: boolean;
  since_days?: number;
  limit?: number;
};

interface ChatItem {
  id?: string;
  name?: string | null;
  unread?: number;
  unread_count?: number;
  timestamp?: string;
  folder?: string[];
  attendee_provider_id?: string;
  account_type?: string;
}

interface InboxConversation {
  chat_id: string;
  attendee_provider_id: string | null;
  attendee_name: string | null;
  unread: boolean;
  unread_count: number;
  last_message_at: string | null;
  folder: string[];
}

interface ListInboxEnvelope {
  count: number;
  items: InboxConversation[];
  error?: string;
  available_accounts?: string[];
}

function envelope(e: ListInboxEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}

export async function handleLinkedinListInbox(args: ListInboxArgs): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 50, 200);

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

  // Native `after` filter is a UTC datetime — derive from since_days.
  const afterIso =
    args.since_days !== undefined
      ? new Date(Date.now() - args.since_days * 86_400_000).toISOString()
      : undefined;

  const allItems: ChatItem[] = [];
  let cursor: string | null = null;
  let pageNum = 0;
  const MAX_PAGES = 10;

  do {
    const remaining = limit - allItems.length;
    const pageLimit = Math.min(remaining, 100);
    if (pageLimit <= 0) break;

    const resp: unknown = await withRetry(() =>
      getUnipileClient().messaging.getAllChats({
        account_id: accountId,
        account_type: "LINKEDIN",
        limit: pageLimit,
        ...(args.unread_only ? { unread: true } : {}),
        ...(afterIso ? { after: afterIso } : {}),
        ...(cursor ? { cursor } : {}),
      })
    );
    const items = (resp as { items?: ChatItem[] }).items ?? [];
    allItems.push(...items);
    cursor = (resp as { cursor?: string | null }).cursor ?? null;
    pageNum += 1;
    if (pageNum >= MAX_PAGES) {
      log.warn("linkedin_list_inbox hit MAX_PAGES safety cap", {
        account_id: accountId,
        pageNum,
        allItemsCount: allItems.length,
      });
      break;
    }
  } while (cursor && allItems.length < limit);

  const shaped: InboxConversation[] = allItems
    .filter((c): c is ChatItem & { id: string } => typeof c.id === "string" && c.id.length > 0)
    .slice(0, limit)
    .map((c) => ({
      chat_id: c.id,
      attendee_provider_id: c.attendee_provider_id ?? null,
      attendee_name: typeof c.name === "string" && c.name.length > 0 ? c.name : null,
      unread: (c.unread_count ?? c.unread ?? 0) > 0,
      unread_count: c.unread_count ?? 0,
      last_message_at: c.timestamp ?? null,
      folder: Array.isArray(c.folder) ? c.folder : [],
    }));

  return envelope({ count: shaped.length, items: shaped });
}
