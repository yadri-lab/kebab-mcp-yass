import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above any top-level `const` declarations, so the
// factory cannot close over locally-declared spies — use vi.hoisted() to
// move the spies into the same hoist tier as the mock factory.
const { getAllMock, UnipileClientMock, ctorCalls } = vi.hoisted(() => {
  const getAllMock = vi.fn();
  const ctorCalls: Array<[string, string]> = [];
  // Real class so `new UnipileClient(...)` constructs. Construction-call
  // tracking lives in `ctorCalls` (vi.fn cannot wrap a class while keeping
  // it constructible in vitest 4.x).
  class UnipileClientMock {
    account = { getAll: getAllMock };
    constructor(dsn: string, token: string) {
      ctorCalls.push([dsn, token]);
    }
  }
  return { getAllMock, UnipileClientMock, ctorCalls };
});

vi.mock("unipile-node-sdk", () => ({
  UnipileClient: UnipileClientMock,
  // The probe path doesn't construct UnsuccessfulRequestError itself; we
  // still export a stub so any future imports compile.
  UnsuccessfulRequestError: class UnsuccessfulRequestError extends Error {
    body: unknown = {};
  },
}));

import { unipileConnector } from "./manifest";

beforeEach(() => {
  getAllMock.mockReset();
  ctorCalls.length = 0;
});

describe("unipileConnector manifest (Phase 68/69 — 6 tools wired)", () => {
  it("exposes id 'unipile' and exact requiredEnvVars per D-19", () => {
    expect(unipileConnector.id).toBe("unipile");
    expect(unipileConnector.label).toBe("Unipile (LinkedIn writes)");
    expect(unipileConnector.requiredEnvVars).toEqual(["UNIPILE_DSN", "UNIPILE_TOKEN"]);
  });

  it("exposes exactly 6 tools (Phase 69 complete — 2 from phase 68 + 4 from phase 69)", () => {
    const names = unipileConnector.tools.map((t) => t.name);
    expect(names).toEqual([
      "linkedin_send_connection",
      "linkedin_get_relationship_status",
      "linkedin_send_message",
      "linkedin_send_inmail",
      "linkedin_engage",
      "linkedin_list_pending",
    ]);
  });

  it.each([
    ["linkedin_send_connection", true],
    ["linkedin_get_relationship_status", false],
    ["linkedin_send_message", true],
    ["linkedin_send_inmail", true],
    ["linkedin_engage", true],
    ["linkedin_list_pending", false],
  ])("%s destructive flag = %s", (name, destructive) => {
    const t = unipileConnector.tools.find((tool) => tool.name === name);
    expect(t).toBeDefined();
    expect(t?.destructive).toBe(destructive);
  });

  it("testConnection returns ok:false when DSN missing", async () => {
    const r = await unipileConnector.testConnection!({ UNIPILE_TOKEN: "x" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/UNIPILE_DSN/i);
    // Must NOT have hit the SDK on the missing-creds path
    expect(ctorCalls).toHaveLength(0);
    expect(getAllMock).not.toHaveBeenCalled();
  });

  it("testConnection returns ok:false when TOKEN missing", async () => {
    const r = await unipileConnector.testConnection!({ UNIPILE_DSN: "api.unipile.com" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/UNIPILE_TOKEN/i);
    expect(ctorCalls).toHaveLength(0);
  });

  it("testConnection returns ok:true when ≥1 LinkedIn account returned (D-19)", async () => {
    getAllMock.mockResolvedValueOnce({
      items: [{ type: "LINKEDIN" }, { type: "WHATSAPP" }],
    });
    const r = await unipileConnector.testConnection!({
      UNIPILE_DSN: "api.unipile.com",
      UNIPILE_TOKEN: "tok",
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/1 LinkedIn account/);
    // SDK constructed with https://<dsn> (no trailing /api/v1 — SDK appends it)
    expect(ctorCalls).toEqual([["https://api.unipile.com", "tok"]]);
  });

  it("testConnection returns ok:false when 0 LinkedIn accounts present (D-19)", async () => {
    getAllMock.mockResolvedValueOnce({
      items: [{ type: "WHATSAPP" }],
    });
    const r = await unipileConnector.testConnection!({
      UNIPILE_DSN: "api.unipile.com",
      UNIPILE_TOKEN: "tok",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No LinkedIn account/);
  });

  it("testConnection returns ok:false on SDK throw (T-68-01-04 — never silent)", async () => {
    getAllMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await unipileConnector.testConnection!({
      UNIPILE_DSN: "api.unipile.com",
      UNIPILE_TOKEN: "tok",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unipile:/);
    expect(r.message).toMatch(/ECONNRESET/);
  });

  it("diagnose returns ok:false when env vars unset (no live SDK call)", async () => {
    // getConfig() with no UNIPILE_DSN / UNIPILE_TOKEN in process.env returns
    // undefined; diagnose should short-circuit and never construct the client.
    const r = await unipileConnector.diagnose!();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/UNIPILE_DSN or UNIPILE_TOKEN not set/);
    expect(ctorCalls).toHaveLength(0);
  });
});
