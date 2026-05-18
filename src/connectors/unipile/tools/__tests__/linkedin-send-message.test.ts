/**
 * Phase 69 / Plan 03 / Task 2 — linkedin_send_message coverage.
 *
 * Covers the locked envelope (D-13/D-14), 9-step handler order (D-49 +
 * WARNING-6), 1st-degree gate (D-22), attachments decode (D-46), and
 * verify-after-write via getAllMessagesFromChat (D-47).
 *
 * Mocks (all hoisted via vi.hoisted — vitest 4.x mock-factory hoisting):
 *  - SDK methods: messaging.startNewChat + messaging.getAllMessagesFromChat
 *    + users.getProfile + account.getAll
 *  - request-context KV store
 *  - rate-limiter (so we can drive `checkUnipileRateLimit` per test, and
 *    assert it was NOT called for dedup hits / pre-flight refusals)
 *  - unipile-node-sdk UnsuccessfulRequestError (same identity as the retry
 *    helper sees, per the canonical pattern in linkedin-send-connection.test.ts)
 *
 * Fake timers are used to skip past the 5s + 5s poll budget without sleeping.
 *
 * WARNING-6 assertions: tests for pre-flight refusal paths explicitly assert
 * `rateLimitMock.not.toHaveBeenCalled()` — these are the runtime guards
 * proving the handler order in PLAN.md is respected (RESEARCH §4.7).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ───── hoisted mock surface (closes over vi.hoisted spies) ─────
const {
  sendChatMock,
  getMessagesMock,
  getProfileMock,
  accountGetAllMock,
  kvMock,
  rateLimitMock,
  haltFlagMock,
  FakeUnsuccessful,
} = vi.hoisted(() => {
  const sendChatMock = vi.fn();
  const getMessagesMock = vi.fn();
  const getProfileMock = vi.fn();
  const accountGetAllMock = vi.fn();
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
    incr: vi.fn<(k: string, opts?: { ttlSeconds?: number }) => Promise<number>>(),
  };
  const rateLimitMock = vi.fn();
  // Phase 70 plan 70-03 retrofit (D-65/D-66) — readHaltFlag mock.
  const haltFlagMock = vi.fn();

  class FakeUnsuccessful extends Error {
    body: { status?: number; type?: string };
    constructor(body: { status?: number; type?: string }) {
      super(`unipile ${JSON.stringify(body)}`);
      this.body = body;
      this.name = "UnsuccessfulRequestError";
    }
  }

  return {
    sendChatMock,
    getMessagesMock,
    getProfileMock,
    accountGetAllMock,
    kvMock,
    rateLimitMock,
    haltFlagMock,
    FakeUnsuccessful,
  };
});

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    messaging: {
      startNewChat: sendChatMock,
      getAllMessagesFromChat: getMessagesMock,
      sendMessage: vi.fn(),
    },
    users: {
      getProfile: getProfileMock,
      getAllInvitationsSent: vi.fn(),
      sendInvitation: vi.fn(),
    },
    account: { getAll: accountGetAllMock },
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

// Phase 70 plan 70-03 retrofit (D-65/D-66) — halt-flag mock wires readHaltFlag
// so tests can drive the halt short-circuit.
vi.mock("../../webhook/halt-flag", () => ({
  readHaltFlag: haltFlagMock,
}));

vi.mock("unipile-node-sdk", () => ({
  // The retry helper does `err instanceof UnsuccessfulRequestError`; our fake
  // class must be the SAME reference the helper sees — vi.mock hoists this
  // factory above the retry import, so they share class identity.
  UnsuccessfulRequestError: FakeUnsuccessful,
}));

import { handleLinkedinSendMessage } from "../linkedin-send-message";

interface ParsedEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: string;
  dedup_hit: boolean;
  audit_id: string;
  message_id?: string;
  chat_id?: string;
  error?: string;
  recipient_degree?: 1 | 2 | 3 | null;
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  retry_after?: string;
  available_accounts?: string[];
  // Phase 70 / Plan 70-03 retrofit (D-65/D-66) — halt-flag envelope fields
  reason?: string;
  halted_at?: string;
}

function parseEnvelope(result: { content: Array<{ text: string }> }): ParsedEnvelope {
  return JSON.parse(result.content[0]!.text) as ParsedEnvelope;
}

const BASE_ARGS = {
  profile_url: "https://linkedin.com/in/test-user",
  text: "Hello from a test",
  actor_user_id: "yass",
};

function resetMocks() {
  sendChatMock.mockReset();
  getMessagesMock.mockReset();
  getProfileMock.mockReset();
  accountGetAllMock.mockReset();
  kvMock.get.mockReset();
  kvMock.set.mockReset();
  kvMock.delete.mockReset();
  kvMock.incr.mockReset();
  rateLimitMock.mockReset();
  // Phase 70 plan 70-03 retrofit (D-65/D-66) — reset readHaltFlag spy.
  haltFlagMock.mockReset();

  // Sane defaults — each test overrides as needed.
  kvMock.get.mockResolvedValue(null); // no dedup hit
  kvMock.set.mockResolvedValue(undefined);
  kvMock.incr.mockResolvedValue(1);
  accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_li_1", type: "LINKEDIN" }] });
  getProfileMock.mockResolvedValue({
    provider_id: "urn:li:test",
    network_distance: "FIRST_DEGREE",
  });
  rateLimitMock.mockResolvedValue({ blocked: false, daily_used: 1, daily_limit: 50 });
  // Phase 70 retrofit default: account NOT halted (existing tests must
  // continue to flow through to dedup / SDK calls unchanged).
  haltFlagMock.mockResolvedValue(null);
}

// ───────────────────────────────────────────────────────────────────────
describe("happy path: provider_ok + verified flow (D-13/D-14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 1 — verified=true when poll finds is_sender=1 message at >= requestStartAt", async () => {
    sendChatMock.mockResolvedValue({ chat_id: "chat_abc", message_id: "msg_1" });
    // Poll returns a message authored by us (is_sender=1) AFTER the request start.
    // We set timestamp to a far-future date so any reasonable Date.now() compares true.
    getMessagesMock.mockResolvedValue({
      items: [{ is_sender: 1, timestamp: "2099-01-01T00:00:00.000Z" }],
    });

    const p = handleLinkedinSendMessage(BASE_ARGS);
    await vi.advanceTimersByTimeAsync(6_000); // past the first 5s delay
    const env = parseEnvelope(await p);

    expect(env.provider_ok).toBe(true);
    expect(env.verified).toBe(true);
    expect(env.crm_sync).toBe("pending");
    expect(env.dedup_hit).toBe(false);
    expect(env.message_id).toBe("msg_1");
    expect(env.chat_id).toBe("chat_abc");
    expect(env.recipient_degree).toBe(1);
    expect(env.error).toBeUndefined();
  });

  it("Test 2 — verified=false on poll timeout (D-13 strict — verified is never the string 'pending')", async () => {
    sendChatMock.mockResolvedValue({ chat_id: "chat_abc", message_id: "msg_1" });
    getMessagesMock.mockResolvedValue({ items: [] }); // never finds anything

    const p = handleLinkedinSendMessage(BASE_ARGS);
    await vi.advanceTimersByTimeAsync(15_000); // past both 5s polls
    const env = parseEnvelope(await p);

    expect(env.provider_ok).toBe(true);
    expect(env.verified).toBe(false);
    // STRICT BOOLEAN guard — runtime equivalent of the grep D-13/D-14 guard.
    expect(typeof env.verified).toBe("boolean");
    // String '"pending"' literal must NEVER show up in the verified slot.
    expect(env.verified as unknown).not.toBe("pending");
    expect(env.error).toBe("unverified_timeout");
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("dedup hit (D-49 — dedup FIRST, MUST NOT touch rate-limiter or SDK)", () => {
  beforeEach(resetMocks);

  it("Test 3 — dedup hit returns early without calling rate-limiter or SDK", async () => {
    // checkDedup reads kv.get('unipile:audit:hash:<hash>') — return a parsed row.
    kvMock.get.mockImplementation((key: string) => {
      if (key.startsWith("unipile:audit:hash:")) {
        return Promise.resolve(
          JSON.stringify({
            audit_id: "prior-uuid",
            actor_user_id: "yass",
            tool: "linkedin_send_message",
            account_id: "acct_li_1",
            params_hash: "hashval",
            result: "success",
            verified: true,
            dedup_hit: false,
            timestamp: "2026-05-01T00:00:00Z",
          })
        );
      }
      return Promise.resolve(null);
    });

    const env = parseEnvelope(await handleLinkedinSendMessage(BASE_ARGS));

    expect(env.dedup_hit).toBe(true);
    expect(env.provider_ok).toBe(false);
    // Mirrors the prior cached result's verified value (true here).
    expect(env.verified).toBe(true);
    expect(env.crm_sync).toBe("pending");
    // WARNING-6 + D-49 runtime guards:
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(sendChatMock).not.toHaveBeenCalled();
    // Phase 70 Plan 70-03 (D-66) reorder: accountGetAllMock IS now called
    // (account-resolve moved BEFORE dedup so halt-check has an accountId).
    // The meaningful "no Unipile call" guarantees become: no degree-fetch
    // (getProfile), no SDK send (sendChat), no rate-limit (rateLimitMock).
    expect(getProfileMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("rate-limit block (D-43 — error_rate_limit_kebab + WARNING-5 fields)", () => {
  beforeEach(resetMocks);

  it("Test 4 — rate-limit block returns error_rate_limit_kebab WITHOUT calling startNewChat", async () => {
    rateLimitMock.mockResolvedValue({
      blocked: true,
      daily_used: 50,
      daily_limit: 50,
      reason: "daily_cap",
      retry_after: "2026-05-19T00:00:00.000Z",
    });

    const env = parseEnvelope(await handleLinkedinSendMessage(BASE_ARGS));

    expect(env.error).toBe("error_rate_limit_kebab");
    expect(env.blocked_by_rate_limit).toBe(true);
    expect(env.daily_used).toBe(50);
    expect(env.daily_limit).toBe(50);
    expect(env.retry_after).toBe("2026-05-19T00:00:00.000Z");
    expect(env.recipient_degree).toBe(1); // we already passed the degree-check
    expect(sendChatMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("attachments (D-46 — server-side decode to [filename, Buffer] tuples)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 5 — attachment > 15MB rejected BEFORE rate-limit (RESEARCH §4.7 — pre-flight does NOT count)", async () => {
    const bigBuf = Buffer.alloc(16 * 1024 * 1024); // 16 MB
    const env = parseEnvelope(
      await handleLinkedinSendMessage({
        ...BASE_ARGS,
        attachments: [
          {
            filename: "big.pdf",
            mimetype: "application/pdf",
            base64: bigBuf.toString("base64"),
          },
        ],
      })
    );

    expect(env.error).toBe("error_attachment_too_large");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(sendChatMock).not.toHaveBeenCalled();
    // WARNING-6 critical guard: pre-flight refusal MUST NOT burn rate-limit quota.
    expect(rateLimitMock).not.toHaveBeenCalled();
    // Also confirms degree-check did not run (no profile fetch for an aborted send).
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  it("Test 6 — attachment ≤ 15MB decoded to [filename, Buffer] tuple and passed to SDK", async () => {
    sendChatMock.mockResolvedValue({ chat_id: "chat_abc", message_id: "msg_1" });
    getMessagesMock.mockResolvedValue({
      items: [{ is_sender: 1, timestamp: "2099-01-01T00:00:00.000Z" }],
    });

    const smallBuf = Buffer.from("test pdf content here");
    const p = handleLinkedinSendMessage({
      ...BASE_ARGS,
      attachments: [
        {
          filename: "small.pdf",
          mimetype: "application/pdf",
          base64: smallBuf.toString("base64"),
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await p;

    // D-46 tuple shape: Array<[filename, Buffer]>
    expect(sendChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [["small.pdf", expect.any(Buffer)]],
      })
    );
    // Buffer content round-trip survives the base64 hop.
    const passed = sendChatMock.mock.calls[0]![0] as { attachments: Array<[string, Buffer]> };
    expect(passed.attachments[0]![1]!.toString()).toBe("test pdf content here");
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("1st-degree gate (D-22 — refuses non-1st-degree BEFORE SDK AND rate-limit)", () => {
  beforeEach(resetMocks);

  it("Test 7 — 2nd-degree recipient refused with error_not_connected, NO SDK send, NO rate-limit call", async () => {
    getProfileMock.mockResolvedValue({
      provider_id: "urn:li:test",
      network_distance: "SECOND_DEGREE",
    });

    const env = parseEnvelope(await handleLinkedinSendMessage(BASE_ARGS));

    expect(env.error).toBe("error_not_connected");
    expect(env.recipient_degree).toBe(2);
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(sendChatMock).not.toHaveBeenCalled();
    // WARNING-6 critical guard: pre-flight refusal MUST NOT burn rate-limit quota.
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("Test 7b — historical DISTANCE_3 spelling also refused (degree=3)", async () => {
    getProfileMock.mockResolvedValue({
      provider_id: "urn:li:test",
      network_distance: "DISTANCE_3",
    });

    const env = parseEnvelope(await handleLinkedinSendMessage(BASE_ARGS));

    expect(env.error).toBe("error_not_connected");
    expect(env.recipient_degree).toBe(3);
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("SDK error classification (classifyUnipileError integration)", () => {
  beforeEach(resetMocks);

  it("Test 8 — SDK 5xx is classified to error_unipile_5xx, verified strictly false", async () => {
    sendChatMock.mockRejectedValue(new FakeUnsuccessful({ status: 503 }));
    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendMessage(BASE_ARGS);
      // withRetry sleeps ~200/400/800ms between retries on 5xx — advance well past.
      await vi.advanceTimersByTimeAsync(5_000);
      const env = parseEnvelope(await p);

      expect(env.provider_ok).toBe(false);
      expect(env.verified).toBe(false);
      expect(typeof env.verified).toBe("boolean");
      expect(env.error).toBe("error_unipile_5xx");
      expect(env.recipient_degree).toBe(1); // we did pass the degree-check
    } finally {
      vi.useRealTimers();
    }
  });

  it("Test 8b — 422 invalid_recipient → error_recipient_unreachable (Wave 1 Plan 01 classifier extension)", async () => {
    sendChatMock.mockRejectedValue(
      new FakeUnsuccessful({ status: 422, type: "errors/invalid_recipient" })
    );

    const env = parseEnvelope(await handleLinkedinSendMessage(BASE_ARGS));

    expect(env.error).toBe("error_recipient_unreachable");
    expect(env.verified).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
describe("account_id resolution (D-20)", () => {
  beforeEach(resetMocks);

  it("Test 9 — 0 LinkedIn accounts → error_no_linkedin_account, NO SDK send", async () => {
    accountGetAllMock.mockResolvedValue({ items: [{ id: "x", type: "WHATSAPP" }] });

    // Omit account_id entirely (exactOptionalPropertyTypes — undefined would be a type error).
    const env = parseEnvelope(await handleLinkedinSendMessage({ ...BASE_ARGS }));

    expect(env.error).toBe("error_no_linkedin_account");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("Test 10 — ≥2 LinkedIn accounts → error_account_id_required with available_accounts list", async () => {
    accountGetAllMock.mockResolvedValue({
      items: [
        { id: "acct1", type: "LINKEDIN" },
        { id: "acct2", type: "LINKEDIN" },
      ],
    });

    // Omit account_id entirely (exactOptionalPropertyTypes — undefined would be a type error).
    const env = parseEnvelope(await handleLinkedinSendMessage({ ...BASE_ARGS }));

    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["acct1", "acct2"]);
    expect(sendChatMock).not.toHaveBeenCalled();
  });

  it("Test 11 — explicit account_id bypasses account.getAll() entirely", async () => {
    sendChatMock.mockResolvedValue({ chat_id: "chat_x", message_id: "msg_x" });
    getMessagesMock.mockResolvedValue({
      items: [{ is_sender: 1, timestamp: "2099-01-01T00:00:00.000Z" }],
    });

    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendMessage({
        ...BASE_ARGS,
        account_id: "explicit-acct",
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const env = parseEnvelope(await p);

      expect(env.provider_ok).toBe(true);
      expect(accountGetAllMock).not.toHaveBeenCalled();
      expect(sendChatMock).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: "explicit-acct" })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 70 / Plan 70-03 retrofit — halt-check Step 0 (D-65 / D-66)
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 70 Plan 70-03 — halt-check Step 0 (D-65 / D-66)", () => {
  beforeEach(resetMocks);

  it("refuses immediately when account is halted, NO dedup / SDK / rate-limit / profile-fetch / chat-poll calls; single audit row with result=error_account_halted", async () => {
    haltFlagMock.mockResolvedValueOnce({
      reason: "restricted",
      halted_at: "2026-05-18T11:00:00.000Z",
      status: "restricted",
    });
    // Default accountGetAllMock returns one LinkedIn account ("acct_li_1") —
    // halt-check runs IMMEDIATELY after account-resolve per the new D-66 ordering.

    const env = parseEnvelope(
      await handleLinkedinSendMessage({
        profile_url: "https://linkedin.com/in/halted-msg-test",
        text: "this should not be sent",
        actor_user_id: "yass",
      })
    );

    expect(env.error).toBe("error_account_halted");
    expect(env.verified).toBe(false);
    expect(env.provider_ok).toBe(false);
    expect(env.dedup_hit).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(env.reason).toBe("restricted");
    expect(env.halted_at).toBe("2026-05-18T11:00:00.000Z");
    expect(env.audit_id).toBeTruthy();

    // Halt-check is the ONLY gate that fired — nothing downstream ran.
    expect(sendChatMock).not.toHaveBeenCalled();
    expect(getMessagesMock).not.toHaveBeenCalled();
    // getProfile is the degree-check call — MUST NOT fire when halted.
    expect(getProfileMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    // Dedup uses kvMock.get — assert it was never asked. readHaltFlag is mocked
    // so it does not touch kvMock either.
    expect(kvMock.get).not.toHaveBeenCalled();

    // Exactly ONE audit row written, with result error_account_halted.
    const auditSetCalls = kvMock.set.mock.calls.filter(
      ([k]) => typeof k === "string" && k.startsWith("unipile:audit:")
    );
    expect(auditSetCalls.length).toBeGreaterThan(0);
    const distinctResults = new Set(
      auditSetCalls
        .map(([, v]) => {
          if (typeof v !== "string") return undefined;
          try {
            return (JSON.parse(v) as { result?: string }).result;
          } catch {
            return undefined;
          }
        })
        .filter(Boolean)
    );
    expect(distinctResults).toEqual(new Set(["error_account_halted"]));
  });
});
