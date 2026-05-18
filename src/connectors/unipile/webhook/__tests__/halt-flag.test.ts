/**
 * Phase 70 / Plan 01 / Task 1 — halt-flag tests (TDD RED).
 *
 * Coverage:
 *  - writeHaltFlag writes JSON to `unipile:halt:<account_id>` via getContextKVStore
 *  - readHaltFlag returns the parsed flag, null when missing, null on corrupt JSON
 *  - clearHaltFlag deletes the key
 *  - isHaltStatus covers the 6 halt status codes
 *  - isRecoveryStatus covers the 4 recovery status codes (D-78 — load-bearing,
 *    without recovery clearance accounts stay halted forever)
 *  - HALT_STATUSES + RECOVERY_STATUSES are exported as named bindings
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
  };
  return { kvMock };
});

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

import {
  readHaltFlag,
  writeHaltFlag,
  clearHaltFlag,
  isHaltStatus,
  isRecoveryStatus,
  HALT_STATUSES,
  RECOVERY_STATUSES,
  type HaltFlag,
} from "../halt-flag";

beforeEach(() => {
  hoist.kvMock.get.mockReset();
  hoist.kvMock.set.mockReset();
  hoist.kvMock.delete.mockReset();
  hoist.kvMock.set.mockResolvedValue();
  hoist.kvMock.delete.mockResolvedValue();
});

describe("writeHaltFlag", () => {
  it("writes the flag as JSON under unipile:halt:<accountId>", async () => {
    const flag: HaltFlag = {
      reason: "credentials_expired",
      halted_at: "2026-05-18T12:00:00Z",
      status: "credentials_expired",
    };
    await writeHaltFlag("acct_xyz", flag);
    expect(hoist.kvMock.set).toHaveBeenCalledTimes(1);
    expect(hoist.kvMock.set).toHaveBeenCalledWith("unipile:halt:acct_xyz", JSON.stringify(flag));
  });
});

describe("readHaltFlag", () => {
  it("returns the parsed flag when present", async () => {
    const flag: HaltFlag = {
      reason: "restricted",
      halted_at: "2026-05-18T12:00:00Z",
      status: "ERROR",
    };
    hoist.kvMock.get.mockResolvedValue(JSON.stringify(flag));
    const out = await readHaltFlag("acct_xyz");
    expect(hoist.kvMock.get).toHaveBeenCalledWith("unipile:halt:acct_xyz");
    expect(out).toEqual(flag);
  });

  it("returns null when missing", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    expect(await readHaltFlag("acct_xyz")).toBeNull();
  });

  it("returns null on corrupt JSON (does not throw)", async () => {
    hoist.kvMock.get.mockResolvedValue("not-json{");
    expect(await readHaltFlag("acct_xyz")).toBeNull();
  });
});

describe("clearHaltFlag", () => {
  it("deletes unipile:halt:<accountId>", async () => {
    await clearHaltFlag("acct_xyz");
    expect(hoist.kvMock.delete).toHaveBeenCalledWith("unipile:halt:acct_xyz");
  });
});

describe("isHaltStatus", () => {
  it.each(["credentials_expired", "CREDENTIALS", "restricted", "ERROR", "disconnected", "DELETED"])(
    "returns true for halt status: %s",
    (s) => {
      expect(isHaltStatus(s)).toBe(true);
    }
  );

  it.each(["OK", "SOMETHING_ELSE", "", "creating", "credentials_expiredX"])(
    "returns false for non-halt status: %s",
    (s) => {
      expect(isHaltStatus(s)).toBe(false);
    }
  );
});

describe("isRecoveryStatus (D-78 — load-bearing)", () => {
  it.each(["OK", "CREATION_SUCCESS", "RECONNECTED", "SYNC_SUCCESS"])(
    "returns true for recovery status: %s",
    (s) => {
      expect(isRecoveryStatus(s)).toBe(true);
    }
  );

  it.each(["credentials_expired", "ERROR", "DELETED", "", "ok"])(
    "returns false for non-recovery status: %s",
    (s) => {
      expect(isRecoveryStatus(s)).toBe(false);
    }
  );
});

describe("HALT_STATUSES + RECOVERY_STATUSES — exported as named bindings (D-78)", () => {
  it("HALT_STATUSES is a Set with exactly the 6 documented codes", () => {
    expect(HALT_STATUSES).toBeInstanceOf(Set);
    expect(HALT_STATUSES.size).toBe(6);
    expect(HALT_STATUSES.has("credentials_expired")).toBe(true);
    expect(HALT_STATUSES.has("DELETED")).toBe(true);
  });

  it("RECOVERY_STATUSES is a Set with exactly the 4 documented codes", () => {
    expect(RECOVERY_STATUSES).toBeInstanceOf(Set);
    expect(RECOVERY_STATUSES.size).toBe(4);
    expect(RECOVERY_STATUSES.has("OK")).toBe(true);
    expect(RECOVERY_STATUSES.has("RECONNECTED")).toBe(true);
  });

  it("HALT and RECOVERY sets are disjoint (no status is both)", () => {
    for (const s of HALT_STATUSES) {
      expect(RECOVERY_STATUSES.has(s)).toBe(false);
    }
  });
});
