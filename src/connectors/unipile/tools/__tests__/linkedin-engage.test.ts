/**
 * Phase 69 / Plan 06 / Task 1 — linkedin_engage tool coverage (UNI-09).
 *
 * Strategy: mock the 3 delegate handlers (handleLinkedinSend{Message,Connection,Inmail})
 * so we can assert routing decisions without booting the entire SDK stack of
 * each delegate. Also mock the SDK client (`users.getProfile` for degree
 * resolution + `account.getAll` for D-20 resolution) and the KV store (for
 * audit row writes).
 *
 * Test surface:
 *  - dry_run branches (D-32): 4 routes — degree=1, degree=2, OON+InMail,
 *    OON+no-fallback. Plus the BLOCKER-1 InMail-without-subject preview.
 *  - dry_run does NOT call any delegate (D-32 grep guard at runtime).
 *  - dry_run writes ONE audit row with result: "dry_run" (D-33).
 *  - real dispatch routes to the correct delegate (D-31).
 *  - skipped_no_message (degree=1 + no message — pre-existing branch).
 *  - skipped_no_inmail_subject (BLOCKER-1) for both real dispatch AND
 *    dry_run preview (with `would_skip_with_reason: 'no_inmail_subject'`).
 *  - skipped_unreachable (OON without allow_inmail).
 *  - dry_run + profile-fetch error still writes an audit row (operator
 *    observability per D-33 — bill-of-actions includes failures).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ----- mock setup (must be hoisted; closes over vi.hoisted spies) -----
const {
  sendMessageMock,
  sendConnectionMock,
  sendInmailMock,
  getProfileMock,
  getAllAccountsMock,
  kvMock,
  FakeUnsuccessful,
} = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const sendConnectionMock = vi.fn();
  const sendInmailMock = vi.fn();
  const getProfileMock = vi.fn();
  const getAllAccountsMock = vi.fn();
  const kvMock = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    incr: vi.fn(),
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
    sendMessageMock,
    sendConnectionMock,
    sendInmailMock,
    getProfileMock,
    getAllAccountsMock,
    kvMock,
    FakeUnsuccessful,
  };
});

// Mock the 3 delegate handlers — order MUST be before the engage import below.
vi.mock("../linkedin-send-message", () => ({
  handleLinkedinSendMessage: sendMessageMock,
}));
vi.mock("../linkedin-send-connection", () => ({
  handleLinkedinSendConnection: sendConnectionMock,
}));
vi.mock("../linkedin-send-inmail", () => ({
  handleLinkedinSendInmail: sendInmailMock,
}));

// Mock the SDK client (engage's getDegreeOnly calls users.getProfile;
// resolveAccountId from lib/account.ts calls account.getAll under withRetry).
vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: {
      getProfile: getProfileMock,
      getAllInvitationsSent: vi.fn(),
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

vi.mock("unipile-node-sdk", () => ({
  // Same identity trick as send-connection.test.ts — the retry helper does
  // `err instanceof UnsuccessfulRequestError`; the FakeUnsuccessful class
  // must be the SAME reference the helper sees.
  UnsuccessfulRequestError: FakeUnsuccessful,
}));

import { handleLinkedinEngage } from "../linkedin-engage";

interface EngageEnv {
  action: string;
  proposed_action?: string;
  dry_run?: boolean;
  reason?: string;
  would_skip_with_reason?: string;
  degree?: 1 | 2 | 3 | null;
  audit_id?: string;
  error?: string;
  available_accounts?: string[];
  delegate_envelope?: Record<string, unknown>;
}

function envOf(r: { content: Array<{ text: string }> }): EngageEnv {
  return JSON.parse(r.content[0]!.text) as EngageEnv;
}

const BASE = {
  profile_url: "https://linkedin.com/in/some-prospect",
  actor_user_id: "yass",
};

beforeEach(() => {
  vi.clearAllMocks();
  // INFO-8 guard: verify mock factory wired the spy correctly.
  expect(typeof sendMessageMock).toBe("function");
  // Default: exactly one LinkedIn account available (D-20 single-account silent
  // resolution).
  getAllAccountsMock.mockResolvedValue({
    items: [{ id: "acct1", type: "LINKEDIN" }],
  });
  kvMock.set.mockResolvedValue(undefined);
  kvMock.get.mockResolvedValue(null);
});

// ──────────────────────────────────────────────────────────────────────────
// DRY-RUN branches (D-32 / D-33)
// ──────────────────────────────────────────────────────────────────────────
describe("dry_run preview (D-32 / D-33)", () => {
  it("D-32: dry_run degree=1 + message → proposes send_message, no delegate called, audit row written", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "FIRST_DEGREE" });
    const env = envOf(await handleLinkedinEngage({ ...BASE, message: "hi", dry_run: true }));
    expect(env.action).toBe("dry_run_proposed");
    expect(env.proposed_action).toBe("send_message");
    expect(env.degree).toBe(1);
    expect(env.dry_run).toBe(true);
    expect(env.audit_id).toBeDefined();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendConnectionMock).not.toHaveBeenCalled();
    expect(sendInmailMock).not.toHaveBeenCalled();
    // D-33: ONE audit row written for dry_run (writeAuditRow does 2 kv.set
    // calls — row + hash pointer). Asserting kvMock.set was called proves
    // the audit row write happened.
    expect(kvMock.set).toHaveBeenCalled();
    // Assert the row payload has result: 'dry_run'
    const setCalls = kvMock.set.mock.calls;
    const dryRunRow = setCalls.find(([, value]) => {
      if (typeof value !== "string") return false;
      try {
        const row = JSON.parse(value) as { result?: string };
        return row.result === "dry_run";
      } catch {
        return false;
      }
    });
    expect(dryRunRow).toBeDefined();
  });

  it("D-32: dry_run degree=2 → proposes send_connection", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "SECOND_DEGREE" });
    const env = envOf(
      await handleLinkedinEngage({ ...BASE, note: "hi from a 2nd-degree", dry_run: true })
    );
    expect(env.action).toBe("dry_run_proposed");
    expect(env.proposed_action).toBe("send_connection");
    expect(env.degree).toBe(2);
    expect(sendConnectionMock).not.toHaveBeenCalled();
  });

  it("D-32: dry_run degree=3 → proposes send_connection", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "THIRD_DEGREE" });
    const env = envOf(await handleLinkedinEngage({ ...BASE, dry_run: true }));
    expect(env.action).toBe("dry_run_proposed");
    expect(env.proposed_action).toBe("send_connection");
    expect(env.degree).toBe(3);
  });

  it("D-32 + BLOCKER-1: dry_run OON + allow_inmail=true + fallback=inmail + inmail_subject → proposes send_inmail", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    const env = envOf(
      await handleLinkedinEngage({
        ...BASE,
        dry_run: true,
        allow_inmail: true,
        fallback_if_unreachable: "inmail",
        inmail_subject: "Quick intro",
      })
    );
    expect(env.proposed_action).toBe("send_inmail");
    expect(env.degree).toBeNull();
    expect(env.would_skip_with_reason).toBeUndefined();
    expect(sendInmailMock).not.toHaveBeenCalled();
  });

  it("BLOCKER-1: dry_run InMail route WITHOUT inmail_subject → proposed_action=send_inmail + would_skip_with_reason=no_inmail_subject", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    const env = envOf(
      await handleLinkedinEngage({
        ...BASE,
        dry_run: true,
        allow_inmail: true,
        fallback_if_unreachable: "inmail",
        // intentionally NO inmail_subject
      })
    );
    expect(env.action).toBe("dry_run_proposed");
    expect(env.proposed_action).toBe("send_inmail");
    expect(env.would_skip_with_reason).toBe("no_inmail_subject");
    expect(env.degree).toBeNull();
    expect(sendInmailMock).not.toHaveBeenCalled();
  });

  it("D-32: dry_run OON without allow_inmail → proposes skipped with reason", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    const env = envOf(await handleLinkedinEngage({ ...BASE, dry_run: true }));
    expect(env.proposed_action).toBe("skipped");
    expect(env.reason).toBe("unreachable_no_inmail_fallback");
  });

  it("D-33: dry_run with getProfile error still writes audit + returns dry_run_proposed/skipped", async () => {
    getProfileMock.mockRejectedValueOnce(new FakeUnsuccessful({ status: 404 }));
    const env = envOf(await handleLinkedinEngage({ ...BASE, dry_run: true }));
    expect(env.action).toBe("dry_run_proposed");
    expect(env.proposed_action).toBe("skipped");
    expect(env.dry_run).toBe(true);
    expect(env.audit_id).toBeDefined();
    expect(kvMock.set).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// REAL dispatch routing (D-31)
// ──────────────────────────────────────────────────────────────────────────
describe("real dispatch routing (D-31)", () => {
  it("degree=1 + message → calls handleLinkedinSendMessage with text + account_id", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "FIRST_DEGREE" });
    sendMessageMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({ provider_ok: true, verified: true, audit_id: "x" }),
        },
      ],
    });
    const env = envOf(await handleLinkedinEngage({ ...BASE, message: "hi" }));
    expect(env.action).toBe("sent_message");
    expect(env.degree).toBe(1);
    expect(env.delegate_envelope).toMatchObject({ provider_ok: true, verified: true });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hi",
        account_id: "acct1",
        actor_user_id: "yass",
      })
    );
    expect(sendConnectionMock).not.toHaveBeenCalled();
    expect(sendInmailMock).not.toHaveBeenCalled();
  });

  it("degree=1 WITHOUT message → skipped reason=no_message_provided, NO delegate called", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "FIRST_DEGREE" });
    const env = envOf(await handleLinkedinEngage(BASE)); // no message
    expect(env.action).toBe("skipped");
    expect(env.reason).toBe("no_message_provided");
    expect(env.degree).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("degree=3 → calls handleLinkedinSendConnection with note pass-through", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "THIRD_DEGREE" });
    sendConnectionMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({ provider_ok: true, verified: true, audit_id: "y" }),
        },
      ],
    });
    const env = envOf(
      await handleLinkedinEngage({
        ...BASE,
        note: "Hi from a 3rd-degree",
        message: "ignored on the connection branch",
      })
    );
    expect(env.action).toBe("sent_connection");
    expect(env.degree).toBe(3);
    expect(sendConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        note: "Hi from a 3rd-degree",
        account_id: "acct1",
      })
    );
  });

  it("BLOCKER-1: OON + allow_inmail + fallback=inmail + inmail_subject → calls handleLinkedinSendInmail with subject pass-through (NOT hardcoded 'Outreach')", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    sendInmailMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({ provider_ok: true, verified: true, credits_used: 1 }),
        },
      ],
    });
    const env = envOf(
      await handleLinkedinEngage({
        ...BASE,
        message: "InMail body",
        allow_inmail: true,
        fallback_if_unreachable: "inmail",
        inmail_subject: "Custom subject from operator",
      })
    );
    expect(env.action).toBe("sent_inmail");
    expect(sendInmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allow_inmail: true,
        text: "InMail body",
        subject: "Custom subject from operator",
      })
    );
  });

  it("BLOCKER-1: REAL OON + allow_inmail + fallback=inmail WITHOUT inmail_subject → skipped_no_inmail_subject, sendInmailMock NOT called", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    const env = envOf(
      await handleLinkedinEngage({
        ...BASE,
        message: "InMail body",
        allow_inmail: true,
        fallback_if_unreachable: "inmail",
        // intentionally NO inmail_subject — engage MUST refuse with explicit reason
      })
    );
    expect(env.action).toBe("skipped");
    expect(env.reason).toBe("skipped_no_inmail_subject");
    expect(env.degree).toBeNull();
    expect(sendInmailMock).not.toHaveBeenCalled();
  });

  it("OON without allow_inmail → skipped reason=unreachable_no_inmail_fallback, NO delegate", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    const env = envOf(await handleLinkedinEngage({ ...BASE, message: "hi" }));
    expect(env.action).toBe("skipped");
    expect(env.reason).toBe("unreachable_no_inmail_fallback");
    expect(sendInmailMock).not.toHaveBeenCalled();
  });

  it("OON + allow_inmail=true BUT fallback='skip' (default) → still skipped (both conditions must hold)", async () => {
    getProfileMock.mockResolvedValueOnce({ network_distance: "OUT_OF_NETWORK" });
    const env = envOf(
      await handleLinkedinEngage({
        ...BASE,
        message: "hi",
        allow_inmail: true,
        // fallback_if_unreachable defaults to 'skip'
      })
    );
    expect(env.action).toBe("skipped");
    expect(env.reason).toBe("unreachable_no_inmail_fallback");
    expect(sendInmailMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Account-resolution failures (D-20 carry)
// ──────────────────────────────────────────────────────────────────────────
describe("account_id resolution (D-20)", () => {
  it("0 LinkedIn accounts → action=skipped, reason=error_no_linkedin_account", async () => {
    getAllAccountsMock.mockResolvedValueOnce({ items: [{ id: "x", type: "WHATSAPP" }] });
    const env = envOf(await handleLinkedinEngage({ ...BASE, message: "hi" }));
    expect(env.action).toBe("skipped");
    expect(env.reason).toBe("error_no_linkedin_account");
    expect(env.error).toBe("error_no_linkedin_account");
  });

  it("≥2 LinkedIn accounts → action=skipped, reason=error_account_id_required, available_accounts populated", async () => {
    getAllAccountsMock.mockResolvedValueOnce({
      items: [
        { id: "acct1", type: "LINKEDIN" },
        { id: "acct2", type: "LINKEDIN" },
      ],
    });
    const env = envOf(await handleLinkedinEngage({ ...BASE, message: "hi" }));
    expect(env.action).toBe("skipped");
    expect(env.reason).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["acct1", "acct2"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Degree resolution failure on REAL dispatch (not dry_run)
// ──────────────────────────────────────────────────────────────────────────
describe("degree-resolution failure on REAL dispatch", () => {
  it("getProfile 404 on real dispatch → action=skipped with error classified", async () => {
    getProfileMock.mockRejectedValue(new FakeUnsuccessful({ status: 404 }));
    const env = envOf(await handleLinkedinEngage({ ...BASE, message: "hi" }));
    expect(env.action).toBe("skipped");
    expect(env.degree).toBeNull();
    expect(env.error).toBeDefined();
    // No delegate called when degree resolution itself fails.
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendConnectionMock).not.toHaveBeenCalled();
    expect(sendInmailMock).not.toHaveBeenCalled();
  });
});
