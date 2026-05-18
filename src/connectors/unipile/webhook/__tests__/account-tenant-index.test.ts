/**
 * Phase 70 / Plan 01 / Task 1 — account-tenant reverse index tests (TDD RED).
 *
 * Coverage (D-56):
 *  - writeAccountTenantMapping writes `unipile:account-tenant:<account_id>` via
 *    getKVStore() (ROOT scope — webhook ingress has no tenant context)
 *  - getAccountTenant returns the tenant_id when present, null when missing
 *  - empty/whitespace tenant_id is treated as missing on both write and read
 *  - empty account_id is treated as missing on both write and read
 *  - tenant_id is trimmed on write (`"  t1  "` → stored as `"t1"`)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
    list: vi.fn<(p?: string) => Promise<string[]>>(),
    kind: "filesystem" as const,
  };
  return { kvMock };
});

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => hoist.kvMock,
}));

import { writeAccountTenantMapping, getAccountTenant } from "../account-tenant-index";

beforeEach(() => {
  hoist.kvMock.get.mockReset();
  hoist.kvMock.set.mockReset();
  hoist.kvMock.delete.mockReset();
  hoist.kvMock.set.mockResolvedValue();
});

describe("writeAccountTenantMapping", () => {
  it("writes tenant_id under unipile:account-tenant:<account_id> (root scope)", async () => {
    await writeAccountTenantMapping("acct_abc", "tenant_xyz");
    expect(hoist.kvMock.set).toHaveBeenCalledTimes(1);
    expect(hoist.kvMock.set).toHaveBeenCalledWith("unipile:account-tenant:acct_abc", "tenant_xyz");
  });

  it("trims tenant_id before writing", async () => {
    await writeAccountTenantMapping("acct_abc", "   tenant_xyz  ");
    expect(hoist.kvMock.set).toHaveBeenCalledWith("unipile:account-tenant:acct_abc", "tenant_xyz");
  });

  it("no-ops when tenant_id is empty / whitespace-only", async () => {
    await writeAccountTenantMapping("acct_abc", "");
    await writeAccountTenantMapping("acct_abc", "   ");
    expect(hoist.kvMock.set).not.toHaveBeenCalled();
  });

  it("no-ops when account_id is empty", async () => {
    await writeAccountTenantMapping("", "tenant_xyz");
    expect(hoist.kvMock.set).not.toHaveBeenCalled();
  });
});

describe("getAccountTenant", () => {
  it("returns the tenant_id when stored", async () => {
    hoist.kvMock.get.mockResolvedValue("tenant_xyz");
    const out = await getAccountTenant("acct_abc");
    expect(hoist.kvMock.get).toHaveBeenCalledWith("unipile:account-tenant:acct_abc");
    expect(out).toBe("tenant_xyz");
  });

  it("trims the stored value (defensive against legacy writes)", async () => {
    hoist.kvMock.get.mockResolvedValue("   tenant_xyz   ");
    expect(await getAccountTenant("acct_abc")).toBe("tenant_xyz");
  });

  it("returns null when missing", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    expect(await getAccountTenant("acct_abc")).toBeNull();
  });

  it("returns null when stored value is empty / whitespace-only", async () => {
    hoist.kvMock.get.mockResolvedValue("");
    expect(await getAccountTenant("acct_abc")).toBeNull();
    hoist.kvMock.get.mockResolvedValue("   ");
    expect(await getAccountTenant("acct_abc")).toBeNull();
  });

  it("returns null when account_id is empty (no KV read)", async () => {
    const out = await getAccountTenant("");
    expect(out).toBeNull();
    expect(hoist.kvMock.get).not.toHaveBeenCalled();
  });
});
