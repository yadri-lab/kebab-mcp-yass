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
// BLOCKER-2 (phase 69 plan 06): the complete merged vi.hoisted block is
// shown here — vi.mock hoisting order is load-bearing, so the
// rate-limiter mock MUST be declared in the same hoist tier as all
// existing phase-68 mocks AND appear BEFORE the import of
// `handleLinkedinSendConnection` below. Reordering this risks wiring the
// real rate-limiter into a test run, which would silently break the
// dedup-first ordering assertion in the D-49 test.
const {
  // === EXISTING phase-68 mocks (preserve verbatim) ===
  sendInvitationMock,
  getProfileMock,
  getAllInvitationsSentMock,
  accountGetAllMock,
  kvMock,
  FakeUnsuccessful,
  // === NEW phase-69 retrofit mock ===
  rateLimitMock,
  // === NEW phase-70 plan 70-03 retrofit mock (halt-flag) ===
  haltFlagMock,
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

  // NEW (phase 69 plan 06 retrofit) — checkUnipileRateLimit mock.
  const rateLimitMock = vi.fn();
  // NEW (phase 70 plan 70-03 retrofit) — readHaltFlag mock.
  const haltFlagMock = vi.fn();

  return {
    sendInvitationMock,
    getProfileMock,
    getAllInvitationsSentMock,
    accountGetAllMock,
    kvMock,
    FakeUnsuccessful,
    rateLimitMock,
    haltFlagMock,
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

// NEW (BLOCKER-2 phase 69 plan 06): rate-limiter mock — MUST appear BEFORE
// the `import { handleLinkedinSendConnection }` below so the import wires
// the mock instead of the real rate-limiter.
vi.mock("../../lib/rate-limiter", () => ({
  checkUnipileRateLimit: rateLimitMock,
}));

// NEW (phase 70 plan 70-03 retrofit): halt-flag mock — wires readHaltFlag
// so tests can drive the halt short-circuit per D-65/D-66.
vi.mock("../../webhook/halt-flag", () => ({
  readHaltFlag: haltFlagMock,
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
  // Phase 69 / Plan 06 retrofit (D-43) — rate-limit envelope fields
  blocked_by_rate_limit?: boolean;
  daily_used?: number;
  daily_limit?: number;
  weekly_used?: number;
  weekly_limit?: number;
  retry_after?: string;
  // Phase 70 / Plan 70-03 retrofit (D-65/D-66) — halt-flag envelope fields
  reason?: string;
  halted_at?: string;
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
  // Phase 70 Plan 70-03 (D-65/D-66): account-resolve now runs BEFORE dedup
  // so every test path needs a default LinkedIn account or it would refuse
  // with error_no_linkedin_account on the new account-first ordering.
  // Tests that need explicit ≥2 or 0-account scenarios still override.
  accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_li_1", type: "LINKEDIN" }] });
  // INFO-8 guard: confirm the mock factories wired correctly.
  expect(typeof rateLimitMock).toBe("function");
  expect(typeof haltFlagMock).toBe("function");
  // Phase 69 retrofit default: rate-limit ALLOWS (existing phase-68 happy-path
  // tests continue to work — they were authored before rate-limit existed and
  // expect the flow to proceed all the way through to sendInvitation).
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue({ blocked: false, daily_used: 1, daily_limit: 25 });
  // Phase 70 retrofit default: account NOT halted (existing tests must continue
  // to flow through to dedup/SDK calls unchanged).
  haltFlagMock.mockReset();
  haltFlagMock.mockResolvedValue(null);
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
    // Phase 70 Plan 70-03 (D-66) reorder note: accountGetAllMock IS now called
    // (account-resolve moved BEFORE dedup so halt-check has an accountId).
    // The provider write API (sendInvitation) and the read-side profile fetch
    // (getProfile) remain the meaningful "no Unipile call" guarantees.
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 69 / Plan 06 retrofit — per-account / per-tool rate-limit (D-43 + D-49)
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 69 retrofit — rate-limit (D-43 + D-49)", () => {
  beforeEach(() => {
    resetMocks();
    accountGetAllMock.mockResolvedValue({ items: [{ id: "acct1", type: "LINKEDIN" }] });
    getProfileMock.mockResolvedValue({ provider_id: "urn:x" });
  });

  it("D-43: rate-limit block returns error_rate_limit_kebab envelope + writes audit row + does NOT call sendInvitation", async () => {
    rateLimitMock.mockResolvedValueOnce({
      blocked: true,
      daily_used: 25,
      daily_limit: 25,
      weekly_used: 50,
      weekly_limit: 100,
      reason: "daily_cap",
      retry_after: "2026-05-19T00:00:00.000Z",
    });

    const env = parseEnvelope(
      await handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
        note: "Hi",
      })
    );

    expect(env.error).toBe("error_rate_limit_kebab");
    expect(env.blocked_by_rate_limit).toBe(true);
    expect(env.daily_used).toBe(25);
    expect(env.daily_limit).toBe(25);
    expect(env.weekly_used).toBe(50);
    expect(env.weekly_limit).toBe(100);
    expect(env.retry_after).toBe("2026-05-19T00:00:00.000Z");
    expect(env.verified).toBe(false);
    expect(env.provider_ok).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(env.dedup_hit).toBe(false);
    // SDK never called — rate-limit fired BEFORE the send.
    expect(sendInvitationMock).not.toHaveBeenCalled();

    // Audit row written with result: error_rate_limit_kebab
    const sets = kvMock.set.mock.calls;
    const auditRow = sets.find(([, value]) => {
      if (typeof value !== "string") return false;
      try {
        const row = JSON.parse(value) as { result?: string };
        return row.result === "error_rate_limit_kebab";
      } catch {
        return false;
      }
    });
    expect(auditRow).toBeDefined();
  });

  it("D-49: dedup hit short-circuits BEFORE the rate-limiter is touched (dedup-first ordering)", async () => {
    // Stage a dedup hit on the hash pointer key.
    kvMock.get.mockImplementation((key: string) => {
      if (key.startsWith("unipile:audit:hash:")) {
        return Promise.resolve(
          JSON.stringify({
            audit_id: "prior-uuid",
            actor_user_id: "yass",
            tool: "linkedin_send_connection",
            account_id: "acct1",
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
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
        note: "Hi",
      })
    );

    expect(env.dedup_hit).toBe(true);
    // KEY ASSERTION — D-49 dedup-FIRST: rate-limiter is never called when
    // dedup short-circuits the handler. This protects retried operator clicks
    // from burning quota.
    expect(rateLimitMock).not.toHaveBeenCalled();
    // SDK also untouched.
    expect(sendInvitationMock).not.toHaveBeenCalled();
  });

  it("rate-limit happy path (blocked: false) does NOT add rate-limit envelope fields", async () => {
    // Default rateLimitMock from beforeEach is { blocked: false }, so the happy
    // path should send through cleanly.
    sendInvitationMock.mockResolvedValue({ invitation_id: "inv-1" });
    getAllInvitationsSentMock.mockResolvedValue({ items: [{ invited_user_id: "urn:x" }] });
    vi.useFakeTimers();
    try {
      const p = handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/x",
        actor_user_id: "yass",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const env = parseEnvelope(await p);
      expect(env.provider_ok).toBe(true);
      expect(env.blocked_by_rate_limit).toBeUndefined();
      expect(env.daily_used).toBeUndefined();
      expect(env.error).toBeUndefined();
      // Rate-limiter WAS called (happy path).
      expect(rateLimitMock).toHaveBeenCalledWith({
        account_id: "acct1",
        tool: "send_connection",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 70 / Plan 70-03 retrofit — halt-check Step 0 (D-65 / D-66)
// ──────────────────────────────────────────────────────────────────────────
describe("Phase 70 Plan 70-03 — halt-check Step 0 (D-65 / D-66)", () => {
  beforeEach(() => {
    resetMocks();
    accountGetAllMock.mockResolvedValue({ items: [{ id: "acc_li_halt", type: "LINKEDIN" }] });
  });

  it("refuses immediately when account is halted, NO dedup / SDK / rate-limit calls; single audit row with result=error_account_halted", async () => {
    haltFlagMock.mockResolvedValueOnce({
      reason: "credentials_expired",
      halted_at: "2026-05-18T10:00:00.000Z",
      status: "credentials_expired",
    });

    const env = parseEnvelope(
      await handleLinkedinSendConnection({
        profile_url: "https://linkedin.com/in/halted-test",
        actor_user_id: "yass",
        note: "Hi",
      })
    );

    expect(env.error).toBe("error_account_halted");
    expect(env.verified).toBe(false);
    expect(env.provider_ok).toBe(false);
    expect(env.dedup_hit).toBe(false);
    expect(env.crm_sync).toBe("pending");
    expect(env.reason).toBe("credentials_expired");
    expect(env.halted_at).toBe("2026-05-18T10:00:00.000Z");
    expect(env.audit_id).toBeTruthy();

    // Halt-check is the ONLY gate that fired — nothing downstream ran.
    expect(sendInvitationMock).not.toHaveBeenCalled();
    expect(getAllInvitationsSentMock).not.toHaveBeenCalled();
    expect(getProfileMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    // Dedup uses kvMock.get under the hood — assert it was never asked.
    // (readHaltFlag is mocked, so it doesn't call kvMock.get either.)
    expect(kvMock.get).not.toHaveBeenCalled();

    // Exactly ONE audit row was written, with result error_account_halted.
    // writeAuditRow does 2 kv.set calls (row + hash pointer) per audit row,
    // but the underlying audit row JSON is the same.
    const auditSetCalls = kvMock.set.mock.calls.filter((call: unknown[]) => {
      const k = call[0];
      return typeof k === "string" && k.startsWith("unipile:audit:");
    });
    expect(auditSetCalls.length).toBeGreaterThan(0);
    const distinctResults = new Set(
      auditSetCalls
        .map((call: unknown[]) => {
          const v = call[1];
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
    // Sanity: account_id captured in the row.
    const firstCall = auditSetCalls[0] as unknown[];
    const row = JSON.parse(firstCall[1] as string) as { account_id?: string };
    expect(row.account_id).toBe("acc_li_halt");
  });
});
