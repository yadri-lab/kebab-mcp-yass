/**
 * Phase 70 / Plan 02 / Task 1 — account_status handler tests.
 *
 * Coverage (D-57 / D-58 / D-78):
 *  - Halt status → writeHaltFlag invoked once, runWithTenant wraps the call,
 *    payload.account_status_specifics is used as `reason` when present,
 *    falls back to the raw status string when specifics absent.
 *  - Recovery status → clearHaltFlag invoked, writeHaltFlag NOT invoked.
 *  - Indifferent status → neither writeHaltFlag nor clearHaltFlag invoked.
 *  - Missing account_id → early warn return, no KV interaction.
 *  - Missing tenant mapping → early warn return, no halt-flag interaction.
 *  - NEGATIVE: no global.fetch call anywhere (no outbound HTTP — D-71 scope guard).
 *
 * Mocks (vi.hoisted): halt-flag writers, resolveTenantFromAccountId, runWithTenant.
 * The runWithTenant mock is a pass-through that records the tenantId it received
 * so tests can assert tenant scope without exercising AsyncLocalStorage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const writeHaltFlag = vi.fn<(accountId: string, flag: unknown) => Promise<void>>();
  const clearHaltFlag = vi.fn<(accountId: string) => Promise<void>>();
  const isHaltStatus = vi.fn<(s: string) => boolean>();
  const isRecoveryStatus = vi.fn<(s: string) => boolean>();
  const resolveTenantFromAccountId = vi.fn<(a: string) => Promise<string | null>>();
  const runWithTenantCalls: Array<{ tenantId: string }> = [];
  const runWithTenant = vi.fn(async <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    runWithTenantCalls.push({ tenantId });
    return fn();
  });
  return {
    writeHaltFlag,
    clearHaltFlag,
    isHaltStatus,
    isRecoveryStatus,
    resolveTenantFromAccountId,
    runWithTenant,
    runWithTenantCalls,
  };
});

vi.mock("../../halt-flag", () => ({
  writeHaltFlag: hoist.writeHaltFlag,
  clearHaltFlag: hoist.clearHaltFlag,
  isHaltStatus: hoist.isHaltStatus,
  isRecoveryStatus: hoist.isRecoveryStatus,
}));

vi.mock("../../dispatcher", () => ({
  resolveTenantFromAccountId: hoist.resolveTenantFromAccountId,
  // _handlers exported as a stub so a side-effect import of the barrel doesn't crash here
  _handlers: { messageReceived: vi.fn(), newRelation: vi.fn(), accountStatus: vi.fn() },
}));

vi.mock("@/core/request-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/request-context")>();
  return {
    ...actual,
    runWithTenant: hoist.runWithTenant,
  };
});

import { handleAccountStatus } from "../account-status";

describe("handleAccountStatus (D-57 / D-58)", () => {
  beforeEach(() => {
    hoist.writeHaltFlag.mockReset().mockResolvedValue();
    hoist.clearHaltFlag.mockReset().mockResolvedValue();
    hoist.isHaltStatus.mockReset();
    hoist.isRecoveryStatus.mockReset();
    hoist.resolveTenantFromAccountId.mockReset();
    hoist.runWithTenant.mockClear();
    hoist.runWithTenantCalls.length = 0;
  });

  it("writes halt flag on halt status with account_status_specifics as reason", async () => {
    hoist.isHaltStatus.mockReturnValue(true);
    hoist.isRecoveryStatus.mockReturnValue(false);
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-A");

    await handleAccountStatus({
      account_id: "acct_1",
      account_status: "credentials_expired",
      account_status_specifics: "OAUTH_TOKEN_REVOKED",
    });

    expect(hoist.writeHaltFlag).toHaveBeenCalledTimes(1);
    const [accountId, flag] = hoist.writeHaltFlag.mock.calls[0]!;
    expect(accountId).toBe("acct_1");
    expect(flag).toMatchObject({
      reason: "OAUTH_TOKEN_REVOKED",
      status: "credentials_expired",
    });
    expect((flag as { halted_at: string }).halted_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
    expect(hoist.clearHaltFlag).not.toHaveBeenCalled();
    // tenant-scoped
    expect(hoist.runWithTenantCalls).toEqual([{ tenantId: "tenant-A" }]);
  });

  it("falls back to status string as reason when account_status_specifics is absent", async () => {
    hoist.isHaltStatus.mockReturnValue(true);
    hoist.isRecoveryStatus.mockReturnValue(false);
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-B");

    await handleAccountStatus({
      account_id: "acct_2",
      account_status: "restricted",
    });

    const [, flag] = hoist.writeHaltFlag.mock.calls[0]!;
    expect(flag).toMatchObject({ reason: "restricted", status: "restricted" });
  });

  it("clears halt flag on recovery status (CREATION_SUCCESS / RECONNECTED / OK / SYNC_SUCCESS)", async () => {
    hoist.isHaltStatus.mockReturnValue(false);
    hoist.isRecoveryStatus.mockReturnValue(true);
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-C");

    await handleAccountStatus({
      account_id: "acct_3",
      account_status: "OK",
    });

    expect(hoist.clearHaltFlag).toHaveBeenCalledTimes(1);
    expect(hoist.clearHaltFlag).toHaveBeenCalledWith("acct_3");
    expect(hoist.writeHaltFlag).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([{ tenantId: "tenant-C" }]);
  });

  it("no-ops on a status that is neither halt nor recovery (debug log only)", async () => {
    hoist.isHaltStatus.mockReturnValue(false);
    hoist.isRecoveryStatus.mockReturnValue(false);
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-D");

    await handleAccountStatus({
      account_id: "acct_4",
      account_status: "SOMETHING_ELSE",
    });

    expect(hoist.writeHaltFlag).not.toHaveBeenCalled();
    expect(hoist.clearHaltFlag).not.toHaveBeenCalled();
    // runWithTenant should still have wrapped the branch (we entered the tenant scope before deciding)
    expect(hoist.runWithTenantCalls).toEqual([{ tenantId: "tenant-D" }]);
  });

  it("warns + early returns on missing account_id (no KV interaction, no tenant resolve)", async () => {
    await handleAccountStatus({ account_status: "OK" });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeHaltFlag).not.toHaveBeenCalled();
    expect(hoist.clearHaltFlag).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([]);
  });

  it("warns + early returns on missing account_status", async () => {
    await handleAccountStatus({ account_id: "acct_5" });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeHaltFlag).not.toHaveBeenCalled();
    expect(hoist.clearHaltFlag).not.toHaveBeenCalled();
  });

  it("warns + early returns when no tenant mapping is found (fail-CLOSED)", async () => {
    hoist.isHaltStatus.mockReturnValue(true);
    hoist.resolveTenantFromAccountId.mockResolvedValue(null);

    await handleAccountStatus({
      account_id: "unclaimed_acct",
      account_status: "credentials_expired",
    });

    expect(hoist.writeHaltFlag).not.toHaveBeenCalled();
    expect(hoist.clearHaltFlag).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([]);
  });

  it("NEGATIVE: never calls global.fetch (no outbound HTTP from the handler — scope guard)", async () => {
    hoist.isHaltStatus.mockReturnValue(true);
    hoist.isRecoveryStatus.mockReturnValue(false);
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-Z");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      await handleAccountStatus({
        account_id: "acct_9",
        account_status: "credentials_expired",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
