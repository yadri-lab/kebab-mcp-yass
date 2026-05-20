/**
 * whatsapp_list_inbox coverage — READ-only WhatsApp inbox lister.
 *
 * Asserts: WhatsApp account resolution, account_type wiring, is_group
 * derivation, envelope shape, native unread/after filters, and the
 * read-only invariant (NO rate-limiter call).
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

import { handleWhatsappListInbox } from "../whatsapp-list-inbox";

interface InboxItem {
  chat_id: string;
  name: string | null;
  conversation_type: "single" | "group" | "channel";
  provider_id: string | null;
  unread: boolean;
  unread_count: number;
  last_message_at: string | null;
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
  // Exactly 1 WhatsApp account connected (plus a LinkedIn one to prove the
  // type filter actually discriminates).
  getAllAccountsMock.mockResolvedValue({
    items: [
      { id: "li1", type: "LINKEDIN" },
      { id: "wa1", type: "WHATSAPP" },
    ],
  });
});

describe("whatsapp_list_inbox", () => {
  it("empty inbox → count 0, no rate-limit", async () => {
    getAllChatsMock.mockResolvedValueOnce({ items: [], cursor: null });
    const env = parse(await handleWhatsappListInbox({}));
    expect(env.count).toBe(0);
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("resolves the WHATSAPP account (not LinkedIn) and passes account_type", async () => {
    getAllChatsMock.mockResolvedValueOnce({ items: [], cursor: null });
    await handleWhatsappListInbox({});
    const callArg = getAllChatsMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.account_id).toBe("wa1");
    expect(callArg.account_type).toBe("WHATSAPP");
  });

  it("shapes single / group / channel chats correctly", async () => {
    getAllChatsMock.mockResolvedValueOnce({
      items: [
        {
          id: "c_dm",
          name: "Guillaume",
          type: 0,
          unread: 1,
          unread_count: 3,
          timestamp: "2026-05-19T15:04:35.000Z",
          provider_id: "33786624801@s.whatsapp.net",
        },
        {
          id: "c_group",
          name: "Apéro crew",
          type: 1,
          unread: 0,
          unread_count: 0,
          timestamp: "2026-05-18T10:00:00.000Z",
          provider_id: "123-456@g.us",
        },
        {
          id: "c_channel",
          name: "Annonces",
          type: 2,
          unread: 0,
          unread_count: 0,
          timestamp: "2026-05-17T10:00:00.000Z",
          provider_id: "789@newsletter",
        },
      ],
      cursor: null,
    });
    const env = parse(await handleWhatsappListInbox({}));
    expect(env.count).toBe(3);
    expect(env.items[0]).toEqual({
      chat_id: "c_dm",
      name: "Guillaume",
      conversation_type: "single",
      provider_id: "33786624801@s.whatsapp.net",
      unread: true,
      unread_count: 3,
      last_message_at: "2026-05-19T15:04:35.000Z",
    });
    expect(env.items[1]!.conversation_type).toBe("group");
    expect(env.items[1]!.unread).toBe(false);
    // CHANNEL (type 2) must NOT be misclassified as a 1:1 (review MEDIUM-1).
    expect(env.items[2]!.conversation_type).toBe("channel");
  });

  it("passes unread + after filters when set", async () => {
    getAllChatsMock.mockResolvedValueOnce({ items: [], cursor: null });
    await handleWhatsappListInbox({ unread_only: true, since_days: 3 });
    const callArg = getAllChatsMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.unread).toBe(true);
    expect(typeof callArg.after).toBe("string");
  });

  it("error_no_account when no WhatsApp account connected", async () => {
    getAllAccountsMock.mockResolvedValue({ items: [{ id: "li1", type: "LINKEDIN" }] });
    const env = parse(await handleWhatsappListInbox({}));
    expect(env.error).toBe("error_no_account");
    expect(getAllChatsMock).not.toHaveBeenCalled();
  });

  it("error_account_id_required when 2+ WhatsApp accounts", async () => {
    getAllAccountsMock.mockResolvedValue({
      items: [
        { id: "wa1", type: "WHATSAPP" },
        { id: "wa2", type: "WHATSAPP" },
      ],
    });
    const env = parse(await handleWhatsappListInbox({}));
    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["wa1", "wa2"]);
  });
});
