/**
 * linkedin_read_messages tool — READ-ONLY conversation thread reader.
 *
 * Returns the message history of ONE LinkedIn conversation, identified by
 * either an explicit `chat_id` (from linkedin_list_inbox) OR a
 * `profile_url` (resolved to the attendee's provider_id, then to their
 * chat). Includes both inbound (`direction: "in"`, is_sender=0) and
 * outbound (`direction: "out"`, is_sender=1) messages so the caller sees
 * the full thread.
 *
 * Read-only invariants (same as linkedin_list_pending / linkedin_list_inbox):
 *   NO audit row, NO rate-limit, NO dedup, NO CRM bridge.
 *
 * Resolution:
 *   - chat_id given → messaging.getAllMessagesFromChat({chat_id}).
 *   - profile_url given → resolveProviderId(url) → attendee_id →
 *     messaging.getAllChatsFromAttendee({attendee_id, account_id}) → take
 *     the most recent chat → getAllMessagesFromChat.
 *   Exactly one of {chat_id, profile_url} is required.
 *
 * Envelope: {chat_id, count, items: [{message_id, direction, sender_id,
 *   text, sent_at, has_attachments}]}. Newest-last is NOT guaranteed by the
 *   API; we sort ascending by sent_at so the thread reads top-to-bottom.
 *
 * Raw message text IS returned here (unlike the write tools, which only
 * hash it) — reading your own inbox is the explicit purpose of the tool.
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveAccountId } from "../lib/account";
import { resolveProviderId } from "../lib/identifiers";
import { classifyUnipileError } from "../lib/errors";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

export const linkedinReadMessagesSchema = {
  chat_id: z
    .string()
    .optional()
    .describe(
      "Unipile chat_id (from linkedin_list_inbox). Provide this OR profile_url — chat_id wins if both are set."
    ),
  profile_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Public LinkedIn profile URL. Resolved to the person, then to your most-recent conversation with them. Provide this OR chat_id."
    ),
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id (optional if exactly 1 LinkedIn account connected; required if 0 or ≥2)."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe(
      "Max messages to return, most recent first then sorted ascending (default 50, cap 200)."
    ),
};

type ReadMessagesArgs = {
  chat_id?: string;
  profile_url?: string;
  account_id?: string;
  limit?: number;
};

interface MessageItem {
  id?: string;
  text?: string | null;
  is_sender?: 0 | 1;
  sender_id?: string;
  timestamp?: string;
  attachments?: unknown[];
}

interface ThreadMessage {
  message_id: string;
  direction: "in" | "out";
  sender_id: string | null;
  text: string | null;
  sent_at: string | null;
  has_attachments: boolean;
}

interface ReadMessagesEnvelope {
  chat_id: string | null;
  count: number;
  items: ThreadMessage[];
  error?: string;
  available_accounts?: string[];
}

function envelope(e: ReadMessagesEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}

export async function handleLinkedinReadMessages(args: ReadMessagesArgs): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 50, 200);

  if (!args.chat_id && !args.profile_url) {
    return envelope({
      chat_id: null,
      count: 0,
      items: [],
      error: "error_missing_target",
    });
  }

  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    return envelope({
      chat_id: null,
      count: 0,
      items: [],
      error: acct.error,
      ...(acct.error === "error_account_id_required"
        ? { available_accounts: acct.available_accounts }
        : {}),
    });
  }
  const accountId = acct.accountId;

  // === Resolve chat_id ===================================================
  let chatId = args.chat_id ?? null;
  if (!chatId && args.profile_url) {
    try {
      const { provider_id } = await resolveProviderId(args.profile_url, accountId);
      const resp: unknown = await withRetry(() =>
        getUnipileClient().messaging.getAllChatsFromAttendee({
          attendee_id: provider_id,
          account_id: accountId,
          limit: 1,
        })
      );
      const chats = (resp as { items?: Array<{ id?: string }> }).items ?? [];
      chatId = chats[0]?.id ?? null;
      if (!chatId) {
        return envelope({
          chat_id: null,
          count: 0,
          items: [],
          error: "error_no_conversation",
        });
      }
    } catch (err) {
      log.warn("read_messages profile_url resolve failed", { err: toMsg(err) });
      return envelope({
        chat_id: null,
        count: 0,
        items: [],
        error: classifyUnipileError(err),
      });
    }
  }

  // === Fetch messages ====================================================
  let rawItems: MessageItem[];
  try {
    const resp: unknown = await withRetry(() =>
      getUnipileClient().messaging.getAllMessagesFromChat({
        chat_id: chatId as string,
        limit,
      })
    );
    rawItems = (resp as { items?: MessageItem[] }).items ?? [];
  } catch (err) {
    log.warn("read_messages getAllMessagesFromChat failed", { chat_id: chatId, err: toMsg(err) });
    return envelope({
      chat_id: chatId,
      count: 0,
      items: [],
      error: classifyUnipileError(err),
    });
  }

  const shaped: ThreadMessage[] = rawItems
    .filter((m): m is MessageItem & { id: string } => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({
      message_id: m.id,
      direction: m.is_sender === 1 ? ("out" as const) : ("in" as const),
      sender_id: m.sender_id ?? null,
      text: m.text ?? null,
      sent_at: m.timestamp ?? null,
      has_attachments: Array.isArray(m.attachments) && m.attachments.length > 0,
    }))
    .sort((a, b) => {
      const ta = a.sent_at ? new Date(a.sent_at).getTime() : 0;
      const tb = b.sent_at ? new Date(b.sent_at).getTime() : 0;
      return ta - tb;
    });

  return envelope({ chat_id: chatId, count: shaped.length, items: shaped });
}
