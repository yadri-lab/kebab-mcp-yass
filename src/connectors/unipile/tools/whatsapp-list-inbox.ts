/**
 * whatsapp_list_inbox tool — READ-ONLY WhatsApp conversation lister.
 *
 * WhatsApp counterpart to linkedin_list_inbox. Same Unipile messaging API
 * (getAllChats, via the shared paginateChats helper) with account_type
 * "WHATSAPP". Read-only invariants: NO audit, NO rate-limit, NO dedup, NO
 * CRM bridge.
 *
 * Unlike LinkedIn, WhatsApp chats carry a human-readable `name` (contact or
 * group name) directly on the chat object, so `name` is usually populated.
 * The chat `type` enum is SINGLE=0, GROUP=1, CHANNEL=2 (verified against
 * unipile-node-sdk chat.types) — exposed as conversation_type so an operator
 * can tell a 1:1 DM, a group, and a broadcast channel apart.
 *
 * Envelope: {count, items: [{chat_id, name, conversation_type, provider_id,
 *   unread, unread_count, last_message_at}]}.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { resolveAccountIdForType } from "../lib/account";
import { paginateChats, runRead } from "../lib/read-helpers";

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

type ConversationType = "single" | "group" | "channel";

interface InboxConversation {
  chat_id: string;
  name: string | null;
  conversation_type: ConversationType;
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

/** SDK chat `type` enum: SINGLE=0, GROUP=1, CHANNEL=2. */
function conversationType(type: number | undefined): ConversationType {
  if (type === 1) return "group";
  if (type === 2) return "channel";
  return "single";
}

export async function handleWhatsappListInbox(args: ListInboxArgs): Promise<ToolResult> {
  return runRead("whatsapp_list_inbox", { count: 0, items: [] }, async () => {
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

    const afterIso =
      args.since_days !== undefined
        ? new Date(Date.now() - args.since_days * 86_400_000).toISOString()
        : undefined;

    const chats = await paginateChats(acct.accountId, "WHATSAPP", {
      limit,
      ...(args.unread_only ? { unread: true } : {}),
      ...(afterIso ? { afterIso } : {}),
    });

    const shaped: InboxConversation[] = chats
      .filter((c): c is typeof c & { id: string } => typeof c.id === "string" && c.id.length > 0)
      .map((c) => ({
        chat_id: c.id,
        name: typeof c.name === "string" && c.name.length > 0 ? c.name : null,
        conversation_type: conversationType(c.type),
        provider_id: c.provider_id ?? null,
        unread: (c.unread_count ?? 0) > 0,
        unread_count: c.unread_count ?? 0,
        last_message_at: c.timestamp ?? null,
      }));

    return envelope({ count: shaped.length, items: shaped });
  });
}
