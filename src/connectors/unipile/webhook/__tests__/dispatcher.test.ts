/**
 * Phase 70 / Plan 01 / Task 2 — dispatcher tests (TDD RED).
 *
 * Coverage:
 *  - getIdempotencyKey
 *    · message_received → payload.message_id
 *    · new_relation → `${account_id}:${user_provider_id}`
 *    · account_status (detected by `payload.account_status` string field,
 *      NOT by `payload.event`) → `${account_id}:${account_status}:${timestamp}`
 *    · returns null on malformed payload (never throws)
 *  - dispatchEventAsync
 *    · routes message_received → _handlers.messageReceived
 *    · routes new_relation → _handlers.newRelation
 *    · routes account_status (no `event` field) → _handlers.accountStatus
 *    · skips message_received with is_sender:true (echo skip — D-63)
 *    · log.warn on unknown event type (does not throw)
 *  - resolveTenantFromAccountId delegates to getAccountTenant
 *  - claimAccountForTenant delegates to writeAccountTenantMapping
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const getAccountTenantMock = vi.fn<(id: string) => Promise<string | null>>();
  const writeAccountTenantMappingMock = vi.fn<(a: string, t: string) => Promise<void>>();
  return { getAccountTenantMock, writeAccountTenantMappingMock };
});

vi.mock("../account-tenant-index", () => ({
  getAccountTenant: hoist.getAccountTenantMock,
  writeAccountTenantMapping: hoist.writeAccountTenantMappingMock,
}));

import {
  getIdempotencyKey,
  dispatchEventAsync,
  resolveTenantFromAccountId,
  claimAccountForTenant,
  _handlers,
} from "../dispatcher";

beforeEach(() => {
  hoist.getAccountTenantMock.mockReset();
  hoist.writeAccountTenantMappingMock.mockReset();
  hoist.writeAccountTenantMappingMock.mockResolvedValue();
  // Reset hooks to vi.fn no-ops between tests so prior spies don't bleed.
  _handlers.messageReceived = vi.fn(async () => {});
  _handlers.newRelation = vi.fn(async () => {});
  _handlers.accountStatus = vi.fn(async () => {});
});

describe("getIdempotencyKey", () => {
  it("message_received → message_id", () => {
    expect(getIdempotencyKey({ event: "message_received", message_id: "msg-abc-123" })).toBe(
      "msg-abc-123"
    );
  });

  it("new_relation → account_id:user_provider_id", () => {
    expect(
      getIdempotencyKey({
        event: "new_relation",
        account_id: "acct_1",
        user_provider_id: "provider_xyz",
      })
    ).toBe("acct_1:provider_xyz");
  });

  it("account_status (no event field) → account_id:account_status:timestamp", () => {
    const key = getIdempotencyKey({
      account_id: "acct_1",
      account_status: "credentials_expired",
      timestamp: "2026-05-18T12:00:00Z",
    });
    expect(key).toBe("acct_1:credentials_expired:2026-05-18T12:00:00Z");
  });

  it("account_status without timestamp falls back to Date.now (composite still includes a non-empty 3rd segment)", () => {
    const key = getIdempotencyKey({
      account_id: "acct_1",
      account_status: "ERROR",
    });
    expect(key).toMatch(/^acct_1:ERROR:\d+$/);
  });

  it("returns null on missing message_id for message_received", () => {
    expect(getIdempotencyKey({ event: "message_received" })).toBeNull();
  });

  it("returns null on missing fields for new_relation", () => {
    expect(getIdempotencyKey({ event: "new_relation", account_id: "a" })).toBeNull();
    expect(getIdempotencyKey({ event: "new_relation", user_provider_id: "u" })).toBeNull();
  });

  it("returns null on completely empty payload (no event, no account_status)", () => {
    expect(getIdempotencyKey({})).toBeNull();
  });

  it("never throws on garbage shape", () => {
    expect(() =>
      getIdempotencyKey({ event: 42, message_id: null, foo: { bar: "baz" } })
    ).not.toThrow();
  });
});

describe("dispatchEventAsync — routing", () => {
  it("routes message_received → _handlers.messageReceived", async () => {
    const payload = { event: "message_received", message_id: "m1", is_sender: false };
    await dispatchEventAsync(payload);
    expect(_handlers.messageReceived).toHaveBeenCalledTimes(1);
    expect(_handlers.messageReceived).toHaveBeenCalledWith(payload);
    expect(_handlers.newRelation).not.toHaveBeenCalled();
    expect(_handlers.accountStatus).not.toHaveBeenCalled();
  });

  it("routes new_relation → _handlers.newRelation", async () => {
    const payload = {
      event: "new_relation",
      account_id: "a1",
      user_provider_id: "u1",
    };
    await dispatchEventAsync(payload);
    expect(_handlers.newRelation).toHaveBeenCalledTimes(1);
    expect(_handlers.messageReceived).not.toHaveBeenCalled();
    expect(_handlers.accountStatus).not.toHaveBeenCalled();
  });

  it("routes account_status (no event field) → _handlers.accountStatus", async () => {
    const payload = { account_id: "a1", account_status: "OK" };
    await dispatchEventAsync(payload);
    expect(_handlers.accountStatus).toHaveBeenCalledTimes(1);
    expect(_handlers.messageReceived).not.toHaveBeenCalled();
    expect(_handlers.newRelation).not.toHaveBeenCalled();
  });

  it("skips outbound echoes (message_received + is_sender:true)", async () => {
    const payload = {
      event: "message_received",
      message_id: "m1",
      is_sender: true,
    };
    await dispatchEventAsync(payload);
    expect(_handlers.messageReceived).not.toHaveBeenCalled();
    expect(_handlers.newRelation).not.toHaveBeenCalled();
    expect(_handlers.accountStatus).not.toHaveBeenCalled();
  });

  it("does not throw on unknown event type", async () => {
    await expect(dispatchEventAsync({ event: "this_event_doesnt_exist" })).resolves.toBeUndefined();
    expect(_handlers.messageReceived).not.toHaveBeenCalled();
    expect(_handlers.newRelation).not.toHaveBeenCalled();
    expect(_handlers.accountStatus).not.toHaveBeenCalled();
  });

  it("does not throw on completely empty payload", async () => {
    await expect(dispatchEventAsync({})).resolves.toBeUndefined();
  });
});

describe("resolveTenantFromAccountId", () => {
  it("returns the tenant_id from the reverse index", async () => {
    hoist.getAccountTenantMock.mockResolvedValue("tenant_xyz");
    expect(await resolveTenantFromAccountId("acct_1")).toBe("tenant_xyz");
    expect(hoist.getAccountTenantMock).toHaveBeenCalledWith("acct_1");
  });

  it("returns null when no mapping exists", async () => {
    hoist.getAccountTenantMock.mockResolvedValue(null);
    expect(await resolveTenantFromAccountId("acct_1")).toBeNull();
  });
});

describe("claimAccountForTenant", () => {
  it("delegates to writeAccountTenantMapping", async () => {
    await claimAccountForTenant("acct_1", "tenant_xyz");
    expect(hoist.writeAccountTenantMappingMock).toHaveBeenCalledWith("acct_1", "tenant_xyz");
  });
});
