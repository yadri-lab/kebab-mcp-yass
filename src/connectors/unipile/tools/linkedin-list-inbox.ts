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
 * Source: Unipile `messaging.getAllChats` via the shared `paginateChats`
 *   helper (cursor pagination + MAX_PAGES cap + try/catch). Native `unread` /
 *   `after` filters verified live against the deployed account 2026-05-20.
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
import { resolveAccountId } from "../lib/account";
import { paginateChats, runRead } from "../lib/read-helpers";

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
  return runRead("linkedin_list_inbox", { count: 0, items: [] }, async () => {
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

    // Native `after` filter is a UTC datetime — derive from since_days.
    const afterIso =
      args.since_days !== undefined
        ? new Date(Date.now() - args.since_days * 86_400_000).toISOString()
        : undefined;

    const chats = await paginateChats(acct.accountId, "LINKEDIN", {
      limit,
      ...(args.unread_only ? { unread: true } : {}),
      ...(afterIso ? { afterIso } : {}),
    });

    const shaped: InboxConversation[] = chats
      .filter((c): c is typeof c & { id: string } => typeof c.id === "string" && c.id.length > 0)
      .map((c) => ({
        chat_id: c.id,
        attendee_provider_id: c.attendee_provider_id ?? null,
        attendee_name: typeof c.name === "string" && c.name.length > 0 ? c.name : null,
        unread: (c.unread_count ?? 0) > 0,
        unread_count: c.unread_count ?? 0,
        last_message_at: c.timestamp ?? null,
        folder: Array.isArray(c.folder) ? c.folder : [],
      }));

    return envelope({ count: shaped.length, items: shaped });
  });
}
