/**
 * whatsapp_read_messages coverage — READ-only WhatsApp thread reader.
 *
 * Asserts: account guard, direction mapping, ascending sort, attachment
 * flag, and the read-only invariant (NO rate-limiter call).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getAllMessagesFromChatMock, getAllAccountsMock, kvMock, rateLimitMock } = vi.hoisted(
  () => ({
    getAllMessagesFromChatMock: vi.fn(),
    getAllAccountsMock: vi.fn(),
    kvMock: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    rateLimitMock: vi.fn(),
  })
);

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: { getProfile: vi.fn() },
    account: { getAll: getAllAccountsMock },
    messaging: {
      getAllMessagesFromChat: getAllMessagesFromChatMock,
      getAllChats: vi.fn(),
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

import { handleWhatsappReadMessages } from "../whatsapp-read-messages";

interface ThreadMsg {
  message_id: string;
  direction: "in" | "out";
  sender_id: string | null;
  text: string | null;
  sent_at: string | null;
  has_attachments: boolean;
}
interface ReadEnvelope {
  chat_id: string | null;
  count: number;
  items: ThreadMsg[];
  error?: string;
  available_accounts?: string[];
}

function parse(r: { content: Array<{ text: string }> }): ReadEnvelope {
  return JSON.parse(r.content[0]!.text) as ReadEnvelope;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAllAccountsMock.mockResolvedValue({ items: [{ id: "wa1", type: "WHATSAPP" }] });
});

describe("whatsapp_read_messages", () => {
  it("reads by chat_id, maps direction, sorts ascending", async () => {
    getAllMessagesFromChatMock.mockResolvedValueOnce({
      items: [
        {
          id: "m2",
          text: "their reply",
          is_sender: 0,
          sender_id: "them",
          timestamp: "2026-05-19T10:05:00.000Z",
          attachments: [],
        },
        {
          id: "m1",
          text: "my message",
          is_sender: 1,
          sender_id: "me",
          timestamp: "2026-05-19T10:00:00.000Z",
          attachments: [],
        },
      ],
    });
    const env = parse(await handleWhatsappReadMessages({ chat_id: "chat_1" }));
    expect(env.chat_id).toBe("chat_1");
    expect(env.count).toBe(2);
    expect(env.items[0]!.message_id).toBe("m1");
    expect(env.items[0]!.direction).toBe("out");
    expect(env.items[1]!.direction).toBe("in");
    expect(env.items[1]!.text).toBe("their reply");
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("flags attachments", async () => {
    getAllMessagesFromChatMock.mockResolvedValueOnce({
      items: [
        {
          id: "m1",
          text: null,
          is_sender: 0,
          sender_id: "them",
          timestamp: "2026-05-19T10:00:00.000Z",
          attachments: [{ type: "img", id: "x" }],
        },
      ],
    });
    const env = parse(await handleWhatsappReadMessages({ chat_id: "c" }));
    expect(env.items[0]!.has_attachments).toBe(true);
  });

  it("surfaces error_account_id_required when 2+ WhatsApp accounts", async () => {
    getAllAccountsMock.mockResolvedValue({
      items: [
        { id: "wa1", type: "WHATSAPP" },
        { id: "wa2", type: "WHATSAPP" },
      ],
    });
    const env = parse(await handleWhatsappReadMessages({ chat_id: "c" }));
    expect(env.error).toBe("error_account_id_required");
    expect(getAllMessagesFromChatMock).not.toHaveBeenCalled();
  });

  it("uses explicit account_id without an account.getAll round-trip", async () => {
    getAllMessagesFromChatMock.mockResolvedValueOnce({ items: [] });
    await handleWhatsappReadMessages({ chat_id: "c", account_id: "wa_explicit" });
    expect(getAllAccountsMock).not.toHaveBeenCalled();
  });
});
