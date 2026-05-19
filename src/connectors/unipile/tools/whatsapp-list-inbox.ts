/**
 * whatsapp_list_inbox tool — READ-ONLY WhatsApp conversation lister.
 *
 * WhatsApp counterpart to linkedin_list_inbox. Same Unipile messaging API
 * (getAllChats) with account_type "WHATSAPP". Read-only invariants: NO
 * audit, NO rate-limit, NO dedup, NO CRM bridge.
 *
 * Unlike LinkedIn, WhatsApp chats carry a human-readable `name` (contact or
 * group name) directly on the chat object, so attendee_name is usually
 * populated without an extra round-trip. `is_group` is derived from the
 * chat `type` field (0 = 1:1, 1 = group — verified live 2026-05-20).
 *
 * Envelope: {count, items: [{chat_id, name, is_group, provider_id, unread,
 *   unread_count, last_message_at}]}.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveAccountIdForType } from "../lib/account";
import { getLogger } from "@/core/logging";

const log = getLogger("CONNECTOR:unipile");

export const whatsappListInboxSchema = {
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile WhatsApp account_id (optional if exactly 1 WhatsApp account connected; required if 0 or ≥2)."
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
  type?: number;
  unread?: number;
  unread_count?: number;
  timestamp?: string;
  provider_id?: string;
}

interface InboxConversation {
  chat_id: string;
  name: string | null;
  is_group: boolean;
  provider_id: string | null;
  unread: boolean;
  unread_count: number;
  last_message_at: string | null;
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

export async function handleWhatsappListInbox(args: ListInboxArgs): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 50, 200);

  const acct = await resolveAccountIdForType(
    "WHATSAPP",
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
        account_type: "WHATSAPP",
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
      log.warn("whatsapp_list_inbox hit MAX_PAGES safety cap", {
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
      name: typeof c.name === "string" && c.name.length > 0 ? c.name : null,
      is_group: c.type === 1,
      provider_id: c.provider_id ?? null,
      unread: (c.unread_count ?? c.unread ?? 0) > 0,
      unread_count: c.unread_count ?? 0,
      last_message_at: c.timestamp ?? null,
    }));

  return envelope({ count: shaped.length, items: shaped });
}
