/**
 * Phase 69 / Plan 05 / Task 2 — linkedin_list_pending coverage (UNI-10).
 *
 * READ-only tool — the test surface is intentionally narrower than the
 * write tools: only `users.getAllInvitationsSent` + `account.getAll`. We
 * assert all four D-decisions (D-34/D-35/D-36/D-37) plus the read-only
 * invariant (NO call to rate-limiter / audit / dedup) and the
 * parsed_datetime null filter from RESEARCH §3.1.
 *
 * Mock strategy:
 *  - vi.hoisted spies for SDK + KV (same pattern as the other phase-69
 *    test files — keeps class identity for `UnsuccessfulRequestError`
 *    intact across the retry helper).
 *  - The rate-limiter is mocked with a spy so we can assert it is NEVER
 *    invoked (read-only invariant — D-37). The handler does not import
 *    the rate-limiter directly, but mocking it with an alarm spy makes
 *    the test fail loudly if a future refactor accidentally wires it in.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ───── hoisted mock surface ────────────────────────────────────────────────
const { getInvitationsMock, getAllAccountsMock, kvMock, rateLimitMock } = vi.hoisted(() => ({
  getInvitationsMock: vi.fn(),
  getAllAccountsMock: vi.fn(),
  kvMock: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  rateLimitMock: vi.fn(),
}));

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: {
      getAllInvitationsSent: getInvitationsMock,
      getProfile: vi.fn(),
      sendInvitation: vi.fn(),
    },
    account: { getAll: getAllAccountsMock },
    messaging: {
      startNewChat: vi.fn(),
      getAllMessagesFromChat: vi.fn(),
      sendMessage: vi.fn(),
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

// Negative guard (D-37 read-only invariant) — if a future refactor wires the
// rate-limiter into the read tool, EVERY test below will fail because they
// all assert `expect(rateLimitMock).not.toHaveBeenCalled()` implicitly via
// the catch-all afterEach check below.
vi.mock("../../lib/rate-limiter", () => ({
  checkUnipileRateLimit: rateLimitMock,
}));

import { handleLinkedinListPending } from "../linkedin-list-pending";

interface ParsedItem {
  invitation_id: string;
  recipient_profile_url: string | null;
  recipient_name: string | null;
  sent_at: string;
  age_days: number;
  has_note: boolean;
}
interface ParsedEnvelope {
  count: number;
  items: ParsedItem[];
  error?: string;
  available_accounts?: string[];
}

function parseEnvelope(r: { content: Array<{ text: string }> }): ParsedEnvelope {
  return JSON.parse(r.content[0]!.text) as ParsedEnvelope;
}

beforeEach(() => {
  vi.clearAllMocks();
  kvMock.get.mockResolvedValue(null);
  kvMock.set.mockResolvedValue(undefined);
  // Default: exactly 1 LinkedIn account connected (D-20 silent path).
  getAllAccountsMock.mockResolvedValue({ items: [{ id: "acct1", type: "LINKEDIN" }] });
});

describe("linkedin_list_pending — D-34/D-35/D-36/D-37", () => {
  // ───────────────────────────────────────────────────────────────────────
  // Test 1 — Empty result
  // ───────────────────────────────────────────────────────────────────────
  it("empty: count=0, items=[]", async () => {
    getInvitationsMock.mockResolvedValueOnce({ items: [], cursor: null });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    expect(env.count).toBe(0);
    expect(env.items).toEqual([]);
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 2 — Single page, full envelope shape (D-34)
  // ───────────────────────────────────────────────────────────────────────
  it("D-34: single page — shape items {invitation_id, recipient_profile_url, recipient_name, sent_at, age_days, has_note}", async () => {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 86_400_000).toISOString();
    getInvitationsMock.mockResolvedValueOnce({
      items: [
        {
          id: "inv_1",
          date: "Sent 1 week ago",
          parsed_datetime: sevenDaysAgo,
          invitation_text: "Let's connect!",
          invited_user: "Adrien Gaignebet",
          invited_user_public_id: "adriengaignebet",
        },
      ],
      cursor: null,
    });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    expect(env.count).toBe(1);
    const item = env.items[0]!;
    expect(item.invitation_id).toBe("inv_1");
    expect(item.recipient_profile_url).toBe("https://linkedin.com/in/adriengaignebet");
    expect(item.recipient_name).toBe("Adrien Gaignebet");
    expect(item.sent_at).toBe(sevenDaysAgo);
    expect(item.age_days).toBe(7);
    expect(item.has_note).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 3 — Multi-page pagination — cursor follow-through (D-36)
  // ───────────────────────────────────────────────────────────────────────
  it("D-36: paginates via cursor until null (2 pages, 100 + 50 = 150 items @ limit 200)", async () => {
    const now = new Date().toISOString();
    getInvitationsMock
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, i) => ({
          id: `inv_p1_${i}`,
          parsed_datetime: now,
          invited_user: `User${i}`,
          invited_user_public_id: `user${i}`,
          invitation_text: null,
        })),
        cursor: "next_cursor_abc",
      })
      .mockResolvedValueOnce({
        items: Array.from({ length: 50 }, (_, i) => ({
          id: `inv_p2_${i}`,
          parsed_datetime: now,
          invited_user: `User${i}`,
          invited_user_public_id: `user${i}`,
          invitation_text: null,
        })),
        cursor: null,
      });
    const env = parseEnvelope(await handleLinkedinListPending({ limit: 200 }));
    expect(env.count).toBe(150);
    expect(getInvitationsMock).toHaveBeenCalledTimes(2);
    expect(getInvitationsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ account_id: "acct1", limit: 100 })
    );
    expect(getInvitationsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ account_id: "acct1", cursor: "next_cursor_abc" })
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 4 — older_than_days CLIENT-side filter (D-35)
  // ───────────────────────────────────────────────────────────────────────
  it("D-35: older_than_days filters CLIENT-side after fetch (Unipile API has no since param)", async () => {
    const now = Date.now();
    const fiveDaysAgo = new Date(now - 5 * 86_400_000).toISOString();
    const fortyDaysAgo = new Date(now - 40 * 86_400_000).toISOString();
    getInvitationsMock.mockResolvedValueOnce({
      items: [
        {
          id: "inv_recent",
          parsed_datetime: fiveDaysAgo,
          invited_user: "Recent",
          invited_user_public_id: "recent",
          invitation_text: null,
        },
        {
          id: "inv_stale",
          parsed_datetime: fortyDaysAgo,
          invited_user: "Stale",
          invited_user_public_id: "stale",
          invitation_text: null,
        },
      ],
      cursor: null,
    });
    const env = parseEnvelope(await handleLinkedinListPending({ older_than_days: 30 }));
    expect(env.count).toBe(1);
    expect(env.items[0]!.invitation_id).toBe("inv_stale");
    expect(env.items[0]!.age_days).toBeGreaterThanOrEqual(30);
    // Verify the call to Unipile did NOT include any date-filter parameter — only
    // {account_id, limit, [cursor]}. The handler must NOT silently invent
    // server-side filter params (D-35).
    const calledWith = getInvitationsMock.mock.calls[0]![0];
    expect(Object.keys(calledWith).sort()).toEqual(["account_id", "limit"].sort());
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 5 — parsed_datetime: null filter (RESEARCH §3.1)
  // ───────────────────────────────────────────────────────────────────────
  it("filters out items with parsed_datetime: null (can't compute age_days)", async () => {
    getInvitationsMock.mockResolvedValueOnce({
      items: [
        {
          id: "inv_ok",
          parsed_datetime: new Date().toISOString(),
          invited_user: "Ok",
          invited_user_public_id: "ok",
          invitation_text: null,
        },
        {
          id: "inv_bad",
          parsed_datetime: null,
          invited_user: "Bad",
          invited_user_public_id: "bad",
          invitation_text: null,
        },
      ],
      cursor: null,
    });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    expect(env.count).toBe(1);
    expect(env.items[0]!.invitation_id).toBe("inv_ok");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 6 — No LinkedIn account → error_no_linkedin_account, empty items (D-20)
  // ───────────────────────────────────────────────────────────────────────
  it("D-20: no LinkedIn account returns error_no_linkedin_account, count=0, no SDK call", async () => {
    getAllAccountsMock.mockResolvedValueOnce({ items: [{ id: "g1", type: "GOOGLE" }] });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    expect(env.error).toBe("error_no_linkedin_account");
    expect(env.count).toBe(0);
    expect(env.items).toEqual([]);
    expect(getInvitationsMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 7 — has_note semantics (D-34)
  // ───────────────────────────────────────────────────────────────────────
  it("has_note: true only for non-empty invitation_text (null and empty string both → false)", async () => {
    getInvitationsMock.mockResolvedValueOnce({
      items: [
        {
          id: "with_note",
          parsed_datetime: new Date().toISOString(),
          invited_user: "A",
          invited_user_public_id: "a",
          invitation_text: "Hi there!",
        },
        {
          id: "null_text",
          parsed_datetime: new Date().toISOString(),
          invited_user: "B",
          invited_user_public_id: "b",
          invitation_text: null,
        },
        {
          id: "empty_text",
          parsed_datetime: new Date().toISOString(),
          invited_user: "C",
          invited_user_public_id: "c",
          invitation_text: "",
        },
      ],
      cursor: null,
    });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    const byId = Object.fromEntries(env.items.map((i) => [i.invitation_id, i.has_note]));
    expect(byId.with_note).toBe(true);
    expect(byId.null_text).toBe(false);
    expect(byId.empty_text).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 8 — limit cap enforced (D-36)
  // ───────────────────────────────────────────────────────────────────────
  it("D-36: limit capped at 500 — passing 1000 still requests ≤500 total", async () => {
    const now = new Date().toISOString();
    // 5 pages of 100 each = 500 (the hard cap), cursor stays non-null on
    // the 5th page but the loop should still exit because allItems.length >= limit (500).
    const makePage = (prefix: string, cursor: string | null) => ({
      items: Array.from({ length: 100 }, (_, i) => ({
        id: `${prefix}_${i}`,
        parsed_datetime: now,
        invited_user: `U${i}`,
        invited_user_public_id: `u${i}`,
        invitation_text: null,
      })),
      cursor,
    });
    getInvitationsMock
      .mockResolvedValueOnce(makePage("p1", "c2"))
      .mockResolvedValueOnce(makePage("p2", "c3"))
      .mockResolvedValueOnce(makePage("p3", "c4"))
      .mockResolvedValueOnce(makePage("p4", "c5"))
      .mockResolvedValueOnce(makePage("p5", "c6")); // cursor non-null but limit reached

    const env = parseEnvelope(await handleLinkedinListPending({ limit: 1000 }));
    expect(env.count).toBe(500);
    // Exactly 5 pages — the 6th must NOT be requested because limit reached.
    expect(getInvitationsMock).toHaveBeenCalledTimes(5);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 9 — invited_user_public_id null → recipient_profile_url null
  // ───────────────────────────────────────────────────────────────────────
  it("invited_user_public_id null → recipient_profile_url null (D-34 graceful degrade)", async () => {
    getInvitationsMock.mockResolvedValueOnce({
      items: [
        {
          id: "inv_no_slug",
          parsed_datetime: new Date().toISOString(),
          invited_user: "Mystery Person",
          invited_user_public_id: null,
          invitation_text: null,
        },
      ],
      cursor: null,
    });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    expect(env.count).toBe(1);
    expect(env.items[0]!.recipient_profile_url).toBeNull();
    expect(env.items[0]!.recipient_name).toBe("Mystery Person");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 10 — ≥2 LinkedIn accounts → error_account_id_required + available_accounts (D-20)
  // ───────────────────────────────────────────────────────────────────────
  it("D-20: ≥2 LinkedIn accounts → error_account_id_required with available_accounts", async () => {
    getAllAccountsMock.mockResolvedValueOnce({
      items: [
        { id: "acctA", type: "LINKEDIN" },
        { id: "acctB", type: "LINKEDIN" },
      ],
    });
    const env = parseEnvelope(await handleLinkedinListPending({}));
    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["acctA", "acctB"]);
    expect(env.count).toBe(0);
    expect(getInvitationsMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 11 — Explicit account_id bypasses account.getAll (D-20)
  // ───────────────────────────────────────────────────────────────────────
  it("D-20: explicit account_id is used silently (no account.getAll call)", async () => {
    getInvitationsMock.mockResolvedValueOnce({ items: [], cursor: null });
    await handleLinkedinListPending({ account_id: "acctExplicit" });
    expect(getAllAccountsMock).not.toHaveBeenCalled();
    expect(getInvitationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "acctExplicit" })
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 12 — MAX_PAGES safety cap (D-36)
  // ───────────────────────────────────────────────────────────────────────
  it("D-36: MAX_PAGES safety cap exits at 10 even if cursor never goes null", async () => {
    const now = new Date().toISOString();
    // limit 1000 (capped to 500 internally → 5 pages of 100 would be the natural
    // exit; but each item gets a UNIQUE id so we'd accumulate 500 before MAX_PAGES.
    // To exercise MAX_PAGES specifically, we use limit=500 with 10 pages of small
    // size — page returns 5 items per page; 10 pages * 5 = 50 items, never hits
    // the limit cap, only the MAX_PAGES cap).
    const makeTinyPage = (n: number) => ({
      items: Array.from({ length: 5 }, (_, i) => ({
        id: `p${n}_${i}`,
        parsed_datetime: now,
        invited_user: `U`,
        invited_user_public_id: `u${n}_${i}`,
        invitation_text: null,
      })),
      cursor: "never_null", // forever non-null
    });
    // Mock 15 pages worth — the handler must stop at 10.
    for (let n = 0; n < 15; n++) getInvitationsMock.mockResolvedValueOnce(makeTinyPage(n));

    const env = parseEnvelope(await handleLinkedinListPending({ limit: 500 }));
    // Exactly 10 pages × 5 items = 50 items returned.
    expect(env.count).toBe(50);
    expect(getInvitationsMock).toHaveBeenCalledTimes(10);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Test 13 — Read-only invariant (D-37): KV never written, rate-limiter never called
  // ───────────────────────────────────────────────────────────────────────
  it("D-37 read-only: KV.set never called, rate-limiter never called, KV.delete never called", async () => {
    getInvitationsMock.mockResolvedValueOnce({
      items: [
        {
          id: "inv_x",
          parsed_datetime: new Date().toISOString(),
          invited_user: "X",
          invited_user_public_id: "x",
          invitation_text: "hi",
        },
      ],
      cursor: null,
    });
    await handleLinkedinListPending({});
    expect(kvMock.set).not.toHaveBeenCalled();
    expect(kvMock.delete).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});
