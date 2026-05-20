/**
 * linkedin_list_inbox coverage — READ-only inbox lister.
 *
 * Asserts: account resolution (D-20), native filter wiring (unread, after),
 * envelope shape, pagination cursor loop, and the read-only invariant (NO
 * rate-limiter call — same guard pattern as linkedin_list_pending).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getAllChatsMock, getAllAccountsMock, kvMock, rateLimitMock } = vi.hoisted(() => ({
  getAllChatsMock: vi.fn(),
  getAllAccountsMock: vi.fn(),
  kvMock: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  rateLimitMock: vi.fn(),
}));

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: { getProfile: vi.fn() },
    account: { getAll: getAllAccountsMock },
    messaging: {
      getAllChats: getAllChatsMock,
      getAllMessagesFromChat: vi.fn(),
      getAllChatsFromAttendee: vi.fn(),
    },
    request: { send: vi.fn() },
  }),
  __resetUnipileClientForTests: () => {},
  sanitizeUnipileText: (s: string) => s,
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

vi.mock("../../lib/rate-limiter", () => ({
  checkUnipileRateLimit: rateLimitMock,
}));

import { handleLinkedinListInbox } from "../linkedin-list-inbox";

interface InboxItem {
  chat_id: string;
  attendee_provider_id: string | null;
  attendee_name: string | null;
  unread: boolean;
  unread_count: number;
  last_message_at: string | null;
  folder: string[];
}
interface InboxEnvelope {
  count: number;
  items: InboxItem[];
  error?: string;
  available_accounts?: string[];
}

function parse(r: { content: Array<{ text: string }> }): InboxEnvelope {
  return JSON.parse(r.content[0]!.text) as InboxEnvelope;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAllAccountsMock.mockResolvedValue({ items: [{ id: "acct1", type: "LINKEDIN" }] });
});

describe("linkedin_list_inbox", () => {
  it("empty inbox → count 0", async () => {
    getAllChatsMock.mockResolvedValueOnce({ items: [], cursor: null });
    const env = parse(await handleLinkedinListInbox({}));
    expect(env.count).toBe(0);
    expect(env.items).toEqual([]);
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("shapes a chat into the inbox envelope", async () => {
    getAllChatsMock.mockResolvedValueOnce({
      items: [
        {
          id: "chat_1",
          name: null,
          unread: 1,
          unread_count: 2,
          timestamp: "2026-05-19T23:23:13.000Z",
          folder: ["INBOX", "INBOX_LINKEDIN_CLASSIC"],
          attendee_provider_id: "ACoAAtest",
          account_type: "LINKEDIN",
        },
      ],
      cursor: null,
    });
    const env = parse(await handleLinkedinListInbox({}));
    expect(env.count).toBe(1);
    expect(env.items[0]).toEqual({
      chat_id: "chat_1",
      attendee_provider_id: "ACoAAtest",
      attendee_name: null,
      unread: true,
      unread_count: 2,
      last_message_at: "2026-05-19T23:23:13.000Z",
      folder: ["INBOX", "INBOX_LINKEDIN_CLASSIC"],
    });
  });

  it("passes unread + after filters to the SDK", async () => {
    getAllChatsMock.mockResolvedValueOnce({ items: [], cursor: null });
    await handleLinkedinListInbox({ unread_only: true, since_days: 7 });
    const callArg = getAllChatsMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.unread).toBe(true);
    expect(typeof callArg.after).toBe("string");
    expect(callArg.account_type).toBe("LINKEDIN");
  });

  it("does NOT pass unread/after when filters are omitted", async () => {
    getAllChatsMock.mockResolvedValueOnce({ items: [], cursor: null });
    await handleLinkedinListInbox({});
    const callArg = getAllChatsMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("unread" in callArg).toBe(false);
    expect("after" in callArg).toBe(false);
  });

  it("paginates via cursor until limit reached", async () => {
    getAllChatsMock
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, unread_count: 0 })),
        cursor: "next",
      })
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, i) => ({ id: `d${i}`, unread_count: 0 })),
        cursor: null,
      });
    const env = parse(await handleLinkedinListInbox({ limit: 150 }));
    expect(env.count).toBe(150);
    expect(getAllChatsMock).toHaveBeenCalledTimes(2);
  });

  it("returns error_account_id_required with available_accounts when 2+ accounts", async () => {
    getAllAccountsMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "b", type: "LINKEDIN" },
      ],
    });
    const env = parse(await handleLinkedinListInbox({}));
    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["a", "b"]);
    expect(getAllChatsMock).not.toHaveBeenCalled();
  });

  it("returns an error envelope (not a throw) when getAllChats fails on the first page (review HIGH-1)", async () => {
    getAllChatsMock.mockRejectedValue(new Error("boom 500"));
    const env = parse(await handleLinkedinListInbox({}));
    expect(env.count).toBe(0);
    expect(env.items).toEqual([]);
    expect(env.error).toBeTruthy();
  });

  it("returns an error envelope (not a throw) when account resolution fails (review HIGH-2)", async () => {
    getAllAccountsMock.mockRejectedValue(new Error("account.getAll 503"));
    const env = parse(await handleLinkedinListInbox({}));
    expect(env.count).toBe(0);
    expect(env.error).toBeTruthy();
  });
});
