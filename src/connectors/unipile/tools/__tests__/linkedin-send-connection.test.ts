/**
 * Phase 68 / Plan 06 / Task 1 — linkedin_send_connection coverage.
 *
 * Covers the locked envelope (D-14), verify-after-write (D-13/D-15),
 * account_id resolution (D-20), dedup (D-05/D-06), and error
 * classification — including the canonical 2026-05-18 Antoine Vercken
 * re-validation scenario (both happy + timeout paths).
 *
 * The SDK, request-context KV, and unipile-node-sdk error class are all
 * mocked via vi.mock — no live API or KV writes happen here.
 *
 * Fake timers are used to skip past the 17s poll budget without sleeping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ----- mock setup (must be hoisted; closes over vi.hoisted spies) -----
const {
  sendInvitationMock,
  getProfileMock,
  getAllInvitationsSentMock,
  accountGetAllMock,
  kvMock,
  FakeUnsuccessful,
} = vi.hoisted(() => {
  const sendInvitationMock = vi.fn();
  const getProfileMock = vi.fn();
  const getAllInvitationsSentMock = vi.fn();
  const accountGetAllMock = vi.fn();
  const kvMock = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };

  class FakeUnsuccessful extends Error {
    body: { status?: number; type?: string };
    constructor(body: { status?: number; type?: string }) {
      super(`unipile ${JSON.stringify(body)}`);
      this.body = body;
      this.name = "UnsuccessfulRequestError";
    }
  }

  return {
    sendInvitationMock,
    getProfileMock,
    getAllInvitationsSentMock,
    accountGetAllMock,
    kvMock,
    FakeUnsuccessful,
  };
});

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: {
      sendInvitation: sendInvitationMock,
      getProfile: getProfileMock,
      getAllInvitationsSent: getAllInvitationsSentMock,
    },
    account: { getAll: accountGetAllMock },
  }),
  __resetUnipileClientForTests: () => {},
  sanitizeUnipileText: (s: string) => s,
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

vi.mock("unipile-node-sdk", () => ({
  // The retry helper does `err instanceof UnsuccessfulRequestError`; our fake
  // class must be the SAME reference the helper sees — vi.mock hoists this
  // factory above the retry import, so they share the class identity.
  UnsuccessfulRequestError: FakeUnsuccessful,
}));

import { handleLinkedinSendConnection } from "../linkedin-send-connection";

interface ParsedEnvelope {
  provider_ok: boolean;
  verified: boolean;
  crm_sync: string;
  dedup_hit: boolean;
  audit_id: string;
  invitation_id?: string;
  error?: string;
  available_accounts?: string[];
}

function parseEnvelope(result: { content: Array<{ text: string }> }): ParsedEnvelope {
  return JSON.parse(result.content[0]!.text) as ParsedEnvelope;
}

function resetMocks() {
  sendInvitationMock.mockReset();
  getProfileMock.mockReset();
  getAllInvitationsSentMock.mockReset();
  accountGetAllMock.mockReset();
  kvMock.get.mockReset();
  kvMock.set.mockReset();
  kvMock.delete.mockReset();
  kvMock.get.mockResolvedValue(null);
  kvMock.set.mockResolvedValue(undefined);
}

describe("linkedin_send_connection — happy path (Antoine Vercken re-validation)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Antoine Vercken: profile resolves, invitation sent, getAllInvitationsSent confirms within first poll → verified: true", async () => {
    accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_li_1", type: "LINKEDIN" }] });
    getProfileMock.mockResolvedValue({ provider_id: "urn:li:av-123" });
    sendInvitationMock.mockResolvedValue({
      object: "UserInvitationSent",
      invitation_id: "inv-abc",
    });
    getAllInvitationsSentMock.mockResolvedValue({
      items: [{ invited_user_id: "urn:li:av-123" }],
    });

    const p = handleLinkedinSendConnection({
      profile_url: "https://www.linkedin.com/in/Antoine-Vercken/",
      actor_user_id: "yass",
      note: "Hi Antoine, retest after Browserbase failure 2026-05-18.",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const env = parseEnvelope(await p);

    expect(env.provider_ok).toBe(true);
    expect(env.verified).toBe(true);
    expect(env.dedup_hit).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(env.invitation_id).toBe("inv-abc");
    expect(env.error).toBeUndefined();
    expect(sendInvitationMock).toHaveBeenCalledWith({
      account_id: "acct_li_1",
      provider_id: "urn:li:av-123",
      message: "Hi Antoine, retest after Browserbase failure 2026-05-18.",
    });
  });

  it("3-poll timeout: invitation never appears in getAllInvitationsSent → verified: false, error: unverified_timeout (D-13/D-15)", async () => {
    accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_li_1", type: "LINKEDIN" }] });
    getProfileMock.mockResolvedValue({ provider_id: "urn:li:av-123" });
    sendInvitationMock.mockResolvedValue({ invitation_id: "inv-abc" });
    getAllInvitationsSentMock.mockResolvedValue({ items: [] }); // never confirms

    const p = handleLinkedinSendConnection({
      profile_url: "https://linkedin.com/in/antoine-vercken",
      actor_user_id: "yass",
    });
    await vi.advanceTimersByTimeAsync(20_000); // > 2+5+10 = 17s
    const env = parseEnvelope(await p);

    expect(env.provider_ok).toBe(true);
    expect(env.verified).toBe(false);
    expect(env.error).toBe("unverified_timeout");
    expect(env.invitation_id).toBe("inv-abc"); // we DO have an id, but no confirmation
  });
});

describe("dedup (D-05 / D-06)", () => {
  beforeEach(resetMocks);

  it("dedup hit returns without calling Unipile", async () => {
    // Hash pointer returns a prior row
    kvMock.get.mockImplementation((key: string) => {
      if (key.startsWith("unipile:audit:hash:")) {
        return Promise.resolve(
          JSON.stringify({
            audit_id: "prior-uuid",
            actor_user_id: "yass",
            tool: "linkedin_send_connection",
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

    const env = parseEnvelope(
      await handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/antoine-vercken",
        actor_user_id: "yass",
        note: "Hi",
      })
    );

    expect(env.dedup_hit).toBe(true);
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(sendInvitationMock).not.toHaveBeenCalled();
    expect(accountGetAllMock).not.toHaveBeenCalled();
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  it("dedup hit STILL writes a fresh audit row with dedup_hit: true (T-68-06-04)", async () => {
    kvMock.get.mockImplementation((key: string) => {
      if (key.startsWith("unipile:audit:hash:")) {
        return Promise.resolve(
          JSON.stringify({
            audit_id: "prior-uuid",
            actor_user_id: "yass",
            tool: "linkedin_send_connection",
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

    await handleLinkedinSendConnection({
      profile_url: "https://linkedin.com/in/antoine-vercken",
      actor_user_id: "yass",
      note: "Hi",
    });

    // The audit write goes to BOTH unipile:audit:<id> and unipile:audit:hash:<hash>
    // We assert at least one set call had dedup_hit:true in the JSON value.
    const sets = kvMock.set.mock.calls;
    const dedupRow = sets.find(([, value]) => {
      if (typeof value !== "string") return false;
      try {
        const row = JSON.parse(value) as { dedup_hit?: boolean };
        return row.dedup_hit === true;
      } catch {
        return false;
      }
    });
    expect(dedupRow).toBeDefined();
  });
});

describe("account_id resolution (D-20)", () => {
  beforeEach(resetMocks);

  it("0 LinkedIn accounts → error_no_linkedin_account, sendInvitation NOT called", async () => {
    accountGetAllMock.mockResolvedValue({ items: [{ id: "x", type: "WHATSAPP" }] });
    const env = parseEnvelope(
      await handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
      })
    );
    expect(env.error).toBe("error_no_linkedin_account");
    expect(env.provider_ok).toBe(false);
    expect(env.verified).toBe(false);
    expect(sendInvitationMock).not.toHaveBeenCalled();
  });

  it("≥2 LinkedIn accounts → error_account_id_required with available_accounts list", async () => {
    accountGetAllMock.mockResolvedValue({
      items: [
        { id: "acct1", type: "LINKEDIN" },
        { id: "acct2", type: "LINKEDIN" },
      ],
    });
    const env = parseEnvelope(
      await handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
      })
    );
    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["acct1", "acct2"]);
    expect(sendInvitationMock).not.toHaveBeenCalled();
  });

  it("explicit account_id bypasses account.getAll() entirely", async () => {
    getProfileMock.mockResolvedValue({ provider_id: "urn:x" });
    sendInvitationMock.mockResolvedValue({ invitation_id: "inv-1" });
    getAllInvitationsSentMock.mockResolvedValue({ items: [{ invited_user_id: "urn:x" }] });
    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
        account_id: "explicit-acct",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await p;
      expect(accountGetAllMock).not.toHaveBeenCalled();
      expect(sendInvitationMock).toHaveBeenCalledWith(
        expect.objectContaining({ account_id: "explicit-acct" })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("error classification on send failure", () => {
  beforeEach(() => {
    resetMocks();
    accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_1", type: "LINKEDIN" }] });
    getProfileMock.mockResolvedValue({ provider_id: "urn:x" });
  });

  it("429 from sendInvitation → error_rate_limit, verified: false", async () => {
    sendInvitationMock.mockRejectedValue(new FakeUnsuccessful({ status: 429 }));
    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
      });
      // withRetry sleeps ~200/400/800ms between retries on 429 — advance well past.
      await vi.advanceTimersByTimeAsync(5_000);
      const env = parseEnvelope(await p);
      expect(env.error).toBe("error_rate_limit");
      expect(env.verified).toBe(false);
      expect(env.provider_ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("403 from sendInvitation → error_account_restricted", async () => {
    sendInvitationMock.mockRejectedValue(new FakeUnsuccessful({ status: 403 }));
    const env = parseEnvelope(
      await handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
      })
    );
    expect(env.error).toBe("error_account_restricted");
    expect(env.verified).toBe(false);
  });
});

describe("envelope contract (D-14)", () => {
  beforeEach(() => {
    resetMocks();
    accountGetAllMock.mockResolvedValue({ items: [{ id: "a", type: "LINKEDIN" }] });
    getProfileMock.mockResolvedValue({ provider_id: "urn:x" });
    sendInvitationMock.mockResolvedValue({ invitation_id: "i" });
    getAllInvitationsSentMock.mockResolvedValue({ items: [{ invited_user_id: "urn:x" }] });
  });

  it("crm_sync is always the string literal 'pending' (never an enum or undefined)", async () => {
    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "y",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const env = parseEnvelope(await p);
      expect(env.crm_sync).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("verified is strictly boolean (never 'pending' string)", async () => {
    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "y",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const env = parseEnvelope(await p);
      expect(typeof env.verified).toBe("boolean");
    } finally {
      vi.useRealTimers();
    }
  });
});
