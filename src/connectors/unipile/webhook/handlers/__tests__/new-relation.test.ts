/**
 * Phase 70 / Plan 02 / Task 2 — `new_relation` handler tests (D-61 / D-78).
 *
 * Coverage:
 *  - Valid payload + matching audit row → enriches existing row with
 *    `accepted_at` (same audit_id re-persisted via writeAuditRow).
 *  - Valid payload + no matching row → inserts a NEW standalone row with
 *    result "inbound_accept_unknown_origin", recipient_provider_id set
 *    to user_provider_id.
 *  - Missing account_id / user_provider_id → warn + early return.
 *  - Missing tenant mapping → warn + early return (fail-CLOSED).
 *  - NEGATIVE: no global.fetch (no outbound HTTP — D-71 scope guard).
 *  - All KV access runs inside runWithTenant (tenant scope assertion).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AuditRow } from "../../../lib/audit";

const hoist = vi.hoisted(() => {
  const findAuditByProviderId = vi.fn<(p: string) => Promise<AuditRow | null>>();
  const writeAuditRow = vi.fn<(r: AuditRow) => Promise<void>>();
  const generateAuditId = vi.fn<() => string>();
  const resolveTenantFromAccountId = vi.fn<(a: string) => Promise<string | null>>();
  const runWithTenantCalls: Array<{ tenantId: string }> = [];
  const runWithTenant = vi.fn(async <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    runWithTenantCalls.push({ tenantId });
    return fn();
  });
  return {
    findAuditByProviderId,
    writeAuditRow,
    generateAuditId,
    resolveTenantFromAccountId,
    runWithTenant,
    runWithTenantCalls,
  };
});

vi.mock("../../../lib/audit", () => ({
  findAuditByProviderId: hoist.findAuditByProviderId,
  writeAuditRow: hoist.writeAuditRow,
  generateAuditId: hoist.generateAuditId,
}));

vi.mock("../../dispatcher", () => ({
  resolveTenantFromAccountId: hoist.resolveTenantFromAccountId,
  _handlers: { messageReceived: vi.fn(), newRelation: vi.fn(), accountStatus: vi.fn() },
}));

vi.mock("@/core/request-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/request-context")>();
  return {
    ...actual,
    runWithTenant: hoist.runWithTenant,
  };
});

import { handleNewRelation } from "../new-relation";

describe("handleNewRelation (D-61 / D-78)", () => {
  beforeEach(() => {
    hoist.findAuditByProviderId.mockReset();
    hoist.writeAuditRow.mockReset().mockResolvedValue();
    hoist.generateAuditId.mockReset().mockReturnValue("uuid-generated");
    hoist.resolveTenantFromAccountId.mockReset();
    hoist.runWithTenant.mockClear();
    hoist.runWithTenantCalls.length = 0;
  });

  it("enriches the matching audit row with accepted_at (re-writes under same audit_id)", async () => {
    const existing: AuditRow = {
      audit_id: "uuid-original",
      actor_user_id: "user-42",
      tool: "linkedin_send_connection",
      account_id: "acct_1",
      params_hash: "h1",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-01T12:00:00Z",
      recipient_provider_id: "ACoAA-target",
    };
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-A");
    hoist.findAuditByProviderId.mockResolvedValue(existing);

    await handleNewRelation({
      account_id: "acct_1",
      user_provider_id: "ACoAA-target",
    });

    expect(hoist.writeAuditRow).toHaveBeenCalledTimes(1);
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    expect(written.audit_id).toBe("uuid-original");
    expect(written.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // other fields preserved
    expect(written.result).toBe("success");
    expect(written.params_hash).toBe("h1");
    // generateAuditId NOT used for enrichment
    expect(hoist.generateAuditId).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([{ tenantId: "tenant-A" }]);
  });

  it("inserts a standalone inbound_accept_unknown_origin row when no audit row matches", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-B");
    hoist.findAuditByProviderId.mockResolvedValue(null);

    await handleNewRelation({
      account_id: "acct_2",
      user_provider_id: "ACoAA-unknown",
    });

    expect(hoist.generateAuditId).toHaveBeenCalledTimes(1);
    expect(hoist.writeAuditRow).toHaveBeenCalledTimes(1);
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    expect(written).toMatchObject({
      audit_id: "uuid-generated",
      tool: "webhook:new_relation",
      account_id: "acct_2",
      result: "inbound_accept_unknown_origin",
      verified: true,
      dedup_hit: false,
      recipient_provider_id: "ACoAA-unknown",
    });
    expect(written.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hoist.runWithTenantCalls).toEqual([{ tenantId: "tenant-B" }]);
  });

  it("warns + early returns on missing account_id", async () => {
    await handleNewRelation({ user_provider_id: "ACoAA-x" });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
  });

  it("warns + early returns on missing user_provider_id", async () => {
    await handleNewRelation({ account_id: "acct_3" });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
  });

  it("warns + early returns when no tenant mapping is found (fail-CLOSED)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue(null);
    await handleNewRelation({
      account_id: "unclaimed",
      user_provider_id: "ACoAA-x",
    });
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
    expect(hoist.findAuditByProviderId).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([]);
  });

  it("NEGATIVE: never calls global.fetch (no outbound HTTP from the handler — scope guard)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-Z");
    hoist.findAuditByProviderId.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      await handleNewRelation({
        account_id: "acct_9",
        user_provider_id: "ACoAA-x",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
