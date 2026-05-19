/**
 * linkedin_read_messages coverage — READ-only thread reader.
 *
 * Asserts: chat_id path, profile_url→chat resolution, direction mapping
 * (is_sender 0/1 → in/out), ascending sort, missing-target error, and the
 * read-only invariant (NO rate-limiter call).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getAllMessagesFromChatMock,
  getAllChatsFromAttendeeMock,
  getProfileMock,
  getAllAccountsMock,
  kvMock,
  rateLimitMock,
} = vi.hoisted(() => ({
  getAllMessagesFromChatMock: vi.fn(),
  getAllChatsFromAttendeeMock: vi.fn(),
  getProfileMock: vi.fn(),
  getAllAccountsMock: vi.fn(),
  kvMock: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  rateLimitMock: vi.fn(),
}));

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: { getProfile: getProfileMock },
    account: { getAll: getAllAccountsMock },
    messaging: {
      getAllMessagesFromChat: getAllMessagesFromChatMock,
      getAllChatsFromAttendee: getAllChatsFromAttendeeMock,
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

import { handleLinkedinReadMessages } from "../linkedin-read-messages";

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
  kvMock.get.mockResolvedValue(null);
  kvMock.set.mockResolvedValue(undefined);
  getAllAccountsMock.mockResolvedValue({ items: [{ id: "acct1", type: "LINKEDIN" }] });
});

describe("linkedin_read_messages", () => {
  it("errors when neither chat_id nor profile_url given", async () => {
    const env = parse(await handleLinkedinReadMessages({}));
    expect(env.error).toBe("error_missing_target");
    expect(getAllMessagesFromChatMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

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
    const env = parse(await handleLinkedinReadMessages({ chat_id: "chat_1" }));
    expect(env.chat_id).toBe("chat_1");
    expect(env.count).toBe(2);
    // sorted ascending → m1 (out) first, then m2 (in)
    expect(env.items[0]!.message_id).toBe("m1");
    expect(env.items[0]!.direction).toBe("out");
    expect(env.items[1]!.message_id).toBe("m2");
    expect(env.items[1]!.direction).toBe("in");
    expect(env.items[1]!.text).toBe("their reply");
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
    const env = parse(await handleLinkedinReadMessages({ chat_id: "c" }));
    expect(env.items[0]!.has_attachments).toBe(true);
    expect(env.items[0]!.text).toBe(null);
  });

  it("resolves profile_url → attendee → chat → messages", async () => {
    getProfileMock.mockResolvedValueOnce({ provider_id: "PROV_123" });
    getAllChatsFromAttendeeMock.mockResolvedValueOnce({ items: [{ id: "chat_from_attendee" }] });
    getAllMessagesFromChatMock.mockResolvedValueOnce({
      items: [
        {
          id: "m1",
          text: "hi",
          is_sender: 0,
          sender_id: "them",
          timestamp: "2026-05-19T10:00:00.000Z",
          attachments: [],
        },
      ],
    });
    const env = parse(
      await handleLinkedinReadMessages({ profile_url: "https://linkedin.com/in/adrien" })
    );
    expect(env.chat_id).toBe("chat_from_attendee");
    expect(env.count).toBe(1);
    const attendeeArg = getAllChatsFromAttendeeMock.mock.calls[0]![0] as { attendee_id: string };
    expect(attendeeArg.attendee_id).toBe("PROV_123");
  });

  it("returns error_no_conversation when attendee has no chat", async () => {
    getProfileMock.mockResolvedValueOnce({ provider_id: "PROV_123" });
    getAllChatsFromAttendeeMock.mockResolvedValueOnce({ items: [] });
    const env = parse(
      await handleLinkedinReadMessages({ profile_url: "https://linkedin.com/in/adrien" })
    );
    expect(env.error).toBe("error_no_conversation");
    expect(getAllMessagesFromChatMock).not.toHaveBeenCalled();
  });
});
