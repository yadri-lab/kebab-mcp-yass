/**
 * Phase 69 / Plan 01 — resolveAccountId D-20 contract tests.
 *
 * Coverage (4 cases):
 *  1. Explicit account_id pass-through (NO account.getAll call)
 *  2. Single LinkedIn account → silent use
 *  3. Zero LinkedIn accounts → error_no_linkedin_account
 *  4. ≥2 LinkedIn accounts → error_account_id_required + available_accounts list
 *
 * Mocks: getUnipileClient via the canonical vi.hoisted pattern (matches
 * identifiers.test.ts and audit.test.ts). UnsuccessfulRequestError shim
 * supplied for `withRetry`'s `instanceof` check.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const getAllMock = vi.fn();
  class FakeUnsuccessful extends Error {
    body: { status?: number };
    constructor(status?: number) {
      super(`Unipile ${status ?? "?"}`);
      this.name = "UnsuccessfulRequestError";
      this.body = status === undefined ? {} : { status };
    }
  }
  return { getAllMock, FakeUnsuccessful };
});

vi.mock("../client", () => ({
  getUnipileClient: () => ({ account: { getAll: hoist.getAllMock } }),
}));

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: hoist.FakeUnsuccessful,
}));

import { resolveAccountId } from "../account";

describe("resolveAccountId (D-20)", () => {
  beforeEach(() => {
    hoist.getAllMock.mockReset();
  });

  it("explicit account_id → silent pass-through, NO account.getAll call", async () => {
    const r = await resolveAccountId({ account_id: "acct_xyz" });
    expect(r).toEqual({ accountId: "acct_xyz" });
    expect(hoist.getAllMock).not.toHaveBeenCalled();
  });

  it("single LinkedIn account → silent use", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [{ id: "acct_only", type: "LINKEDIN" }],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({ accountId: "acct_only" });
    expect(hoist.getAllMock).toHaveBeenCalledTimes(1);
  });

  it("zero LinkedIn accounts → error_no_linkedin_account (other types present but ignored)", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "acct_g", type: "GOOGLE" },
        { id: "acct_w", type: "WHATSAPP" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({ error: "error_no_linkedin_account" });
  });

  it("≥2 LinkedIn accounts → error_account_id_required + available_accounts list (insertion order preserved)", async () => {
    hoist.getAllMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "g", type: "GOOGLE" }, // non-LinkedIn filtered out
        { id: "b", type: "LINKEDIN" },
      ],
    });
    const r = await resolveAccountId({});
    expect(r).toEqual({
      error: "error_account_id_required",
      available_accounts: ["a", "b"],
    });
  });

  it("empty items array → error_no_linkedin_account (defensive default)", async () => {
    hoist.getAllMock.mockResolvedValue({ items: [] });
    expect(await resolveAccountId({})).toEqual({ error: "error_no_linkedin_account" });
  });

  it("missing items field → error_no_linkedin_account (shape-defensive)", async () => {
    hoist.getAllMock.mockResolvedValue({});
    expect(await resolveAccountId({})).toEqual({ error: "error_no_linkedin_account" });
  });
});
