/**
 * Shared helpers for the read-only Unipile inbox tools (linkedin/whatsapp
 * list_inbox + read_messages, and linkedin_list_pending).
 *
 * Two exports:
 *  - `paginateChats` — the cursor-pagination loop over `messaging.getAllChats`,
 *    shared by linkedin_list_inbox + whatsapp_list_inbox. Extracted because the
 *    loop is non-trivial control flow (cursor + MAX_PAGES + remaining math) that
 *    was duplicated byte-for-byte across two files; a fix to one would silently
 *    rot the other (review LOW-2). The try/catch lives HERE so the SDK call can
 *    never escape as an unhandled exception (review HIGH-1).
 *  - `runRead` — wraps a read-tool handler body so ANY throw (account-resolver
 *    failure, getUnipileClient() on missing env, a stray SDK error) is converted
 *    into the standard `{error}` envelope instead of crashing the MCP request
 *    (review HIGH-2). Read tools never mutate, so a blanket catch is safe — there
 *    is no half-committed state to worry about.
 */

import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "./client";
import { withRetry } from "./retry";
import { classifyUnipileError } from "./errors";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

/** Per-page hard cap enforced by Unipile's getAllChats. */
const PAGE_CAP = 100;
/** Runaway-safety: 500 max / 100 per page = 5 typical; 10 leaves headroom. */
const MAX_PAGES = 10;

/** Minimal chat shape the inbox tools consume. SDK returns more fields. */
export interface RawChat {
  id?: string;
  name?: string | null;
  type?: number;
  unread?: number;
  unread_count?: number;
  timestamp?: string;
  folder?: string[];
  provider_id?: string;
  attendee_provider_id?: string;
}

/**
 * Paginate `messaging.getAllChats` for one account+type until the cursor is
 * exhausted or `limit` items are collected (MAX_PAGES safety cap). Native
 * `unread` / `after` filters are forwarded when provided.
 *
 * Throws nothing — on any SDK/transport failure it logs a warning and returns
 * whatever was collected so far (empty on a first-page failure). Callers wrap
 * the whole handler in `runRead`, but pagination degrading to a partial/empty
 * result is friendlier than aborting the whole call on a late-page blip.
 */
export async function paginateChats(
  accountId: string,
  accountType: "LINKEDIN" | "WHATSAPP",
  opts: { limit: number; unread?: boolean; afterIso?: string }
): Promise<RawChat[]> {
  const allItems: RawChat[] = [];
  let cursor: string | null = null;
  let pageNum = 0;

  try {
    do {
      const remaining = opts.limit - allItems.length;
      const pageLimit = Math.min(remaining, PAGE_CAP);
      if (pageLimit <= 0) break;

      const resp: unknown = await withRetry(() =>
        getUnipileClient().messaging.getAllChats({
          account_id: accountId,
          account_type: accountType,
          limit: pageLimit,
          ...(opts.unread ? { unread: true } : {}),
          ...(opts.afterIso ? { after: opts.afterIso } : {}),
          ...(cursor ? { cursor } : {}),
        })
      );
      const items = (resp as { items?: RawChat[] }).items ?? [];
      allItems.push(...items);
      cursor = (resp as { cursor?: string | null }).cursor ?? null;
      pageNum += 1;
      if (pageNum >= MAX_PAGES) {
        log.warn("paginateChats hit MAX_PAGES safety cap", {
          account_id: accountId,
          account_type: accountType,
          pageNum,
          allItemsCount: allItems.length,
        });
        break;
      }
    } while (cursor && allItems.length < opts.limit);
  } catch (err) {
    // Re-thrown by withRetry on non-retryable / exhausted errors. The outer
    // runRead wrapper would also catch this, but handling it here lets a
    // late-page failure still return the pages already gathered.
    log.warn("paginateChats getAllChats failed", {
      account_id: accountId,
      account_type: accountType,
      collected: allItems.length,
      err: toMsg(err),
    });
    if (allItems.length === 0) throw err; // first-page failure → let runRead surface error envelope
  }

  return allItems.slice(0, opts.limit);
}

/**
 * Run a read-tool handler body, converting any thrown error into the standard
 * empty `{error}` envelope. `emptyEnvelope` is the tool's zero-result shape
 * (count:0/items:[] plus any tool-specific nulls like chat_id), to which the
 * `error` string is added. Safe for read tools only (no mutation to roll back).
 */
export async function runRead<E extends Record<string, unknown>>(
  toolName: string,
  emptyEnvelope: E,
  body: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    log.warn(`${toolName} failed`, { err: toMsg(err) });
    const payload = { ...emptyEnvelope, error: classifyUnipileError(err) };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  }
}
