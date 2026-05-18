/**
 * Phase 71 / Plan 71-02 / Task 2 — admin audit query route (UNI-22).
 *
 * GET /api/admin/audit/unipile?account_id=&since=&tool=&result=&limit=&cursor=
 *
 * Coverage (10 cases per plan <behavior>):
 *   1. No filters, empty KV → { items: [], cursor: null, total_estimate: 0 }
 *   2. No filters, 3 rows in KV → all 3 returned, sorted DESC by timestamp
 *   3. Filter by account_id → only matching rows
 *   4. Filter by tool → only matching rows
 *   5. Filter by result → only matching rows
 *   6. Filter by since (ISO) → only rows with timestamp >= since
 *   7. Pagination: 75 rows, limit=20, walk cursors until null; total_estimate
 *      stable at 75 across pages
 *   8. Skip dedup pointer keys (containing :hash:)
 *   9. Invalid cursor (garbage base64) → falls back to page 1 (not 500)
 *  10. Cache-Control: private, max-age=10
 *
 * Mock strategy mirrors the quotas summary route test (config-facade is
 * mocked to satisfy kebab/no-direct-process-env; KV is in-memory).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AuditRow } from "@/connectors/unipile/lib/audit";

const hoist = vi.hoisted(() => {
  const store = new Map<string, string>();
  const kvMock = {
    kind: "filesystem" as const,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async (prefix?: string) =>
      Array.from(store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true))
    ),
  };
  return { store, kvMock };
});

vi.mock("@/core/with-admin-auth", () => ({
  withAdminAuth: <F extends (...args: unknown[]) => unknown>(handler: F) => handler,
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => hoist.kvMock,
  getCurrentTenantId: () => "test-tenant",
  requestContext: { getStore: () => undefined },
  getCredential: () => undefined,
}));

vi.mock("@/core/config-facade", () => ({
  getConfig: (_k: string) => undefined,
  getConfigInt: (_k: string, def: number) => def,
}));

import { GET } from "../route";

beforeEach(() => {
  hoist.store.clear();
  vi.clearAllMocks();
  hoist.kvMock.get.mockImplementation(async (k: string) => hoist.store.get(k) ?? null);
  hoist.kvMock.list.mockImplementation(async (prefix?: string) =>
    Array.from(hoist.store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true))
  );
});

function makeReq(qs = ""): { request: Request } {
  return {
    request: new Request(`http://x/api/admin/audit/unipile${qs}`, { method: "GET" }),
  } as { request: Request };
}

function seedRow(row: Partial<AuditRow> & { audit_id: string; timestamp: string }): void {
  const full: AuditRow = {
    audit_id: row.audit_id,
    actor_user_id: row.actor_user_id ?? "u1",
    tool: row.tool ?? "linkedin_send_message",
    account_id: row.account_id ?? "accA",
    params_hash: row.params_hash ?? "abc",
    result: row.result ?? "success",
    verified: row.verified ?? true,
    dedup_hit: row.dedup_hit ?? false,
    timestamp: row.timestamp,
    ...(row.recipient_provider_id !== undefined
      ? { recipient_provider_id: row.recipient_provider_id }
      : {}),
    ...(row.accepted_at !== undefined ? { accepted_at: row.accepted_at } : {}),
    ...(row.last_replied_at !== undefined ? { last_replied_at: row.last_replied_at } : {}),
  };
  hoist.store.set(`unipile:audit:${row.audit_id}`, JSON.stringify(full));
}

describe("GET /api/admin/audit/unipile", () => {
  it("returns empty page when KV is empty (no filters)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], cursor: null, total_estimate: 0 });
  });

  it("returns all rows sorted DESC by timestamp when no filters set", async () => {
    seedRow({ audit_id: "a1", timestamp: "2026-05-17T10:00:00.000Z" });
    seedRow({ audit_id: "a2", timestamp: "2026-05-18T10:00:00.000Z" });
    seedRow({ audit_id: "a3", timestamp: "2026-05-16T10:00:00.000Z" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    const body = await res.json();
    expect(body.total_estimate).toBe(3);
    expect(body.items.map((r: AuditRow) => r.audit_id)).toEqual(["a2", "a1", "a3"]);
    expect(body.cursor).toBeNull(); // single page covers all
  });

  it("filters by account_id (exact match)", async () => {
    seedRow({ audit_id: "a1", account_id: "accA", timestamp: "2026-05-18T10:00:00.000Z" });
    seedRow({ audit_id: "a2", account_id: "accB", timestamp: "2026-05-18T11:00:00.000Z" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq("?account_id=accA"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].audit_id).toBe("a1");
    expect(body.total_estimate).toBe(1);
  });

  it("filters by tool (exact match)", async () => {
    seedRow({
      audit_id: "a1",
      tool: "linkedin_send_connection",
      timestamp: "2026-05-18T10:00:00.000Z",
    });
    seedRow({
      audit_id: "a2",
      tool: "linkedin_send_message",
      timestamp: "2026-05-18T11:00:00.000Z",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq("?tool=linkedin_send_message"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].audit_id).toBe("a2");
  });

  it("filters by result (exact match — e.g., error_writes_disabled)", async () => {
    seedRow({
      audit_id: "a1",
      result: "success",
      timestamp: "2026-05-18T10:00:00.000Z",
    });
    seedRow({
      audit_id: "a2",
      result: "error_writes_disabled",
      timestamp: "2026-05-18T11:00:00.000Z",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq("?result=error_writes_disabled"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].audit_id).toBe("a2");
  });

  it("filters by since (returns only rows with timestamp >= since)", async () => {
    seedRow({ audit_id: "old", timestamp: "2026-05-10T10:00:00.000Z" });
    seedRow({ audit_id: "new1", timestamp: "2026-05-18T10:00:00.000Z" });
    seedRow({ audit_id: "new2", timestamp: "2026-05-19T10:00:00.000Z" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq("?since=2026-05-15T00:00:00.000Z"));
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((r: AuditRow) => r.audit_id).sort()).toEqual(["new1", "new2"]);
  });

  it("paginates with cursor (75 rows, limit=20 — walk pages until cursor null)", async () => {
    // Seed 75 rows with sortable timestamps so DESC sort is deterministic
    for (let i = 0; i < 75; i++) {
      const ts = `2026-05-${String(10 + Math.floor(i / 10)).padStart(2, "0")}T${String(
        i % 24
      ).padStart(2, "0")}:00:00.000Z`;
      seedRow({ audit_id: `a${String(i).padStart(3, "0")}`, timestamp: ts });
    }

    // Page 1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res1 = await (GET as any)(makeReq("?limit=20"));
    const body1 = await res1.json();
    expect(body1.total_estimate).toBe(75);
    expect(body1.items).toHaveLength(20);
    expect(body1.cursor).not.toBeNull();

    // Page 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res2 = await (GET as any)(
      makeReq(`?limit=20&cursor=${encodeURIComponent(body1.cursor)}`)
    );
    const body2 = await res2.json();
    expect(body2.total_estimate).toBe(75);
    expect(body2.items).toHaveLength(20);
    expect(body2.cursor).not.toBeNull();
    expect(body2.items[0].audit_id).not.toBe(body1.items[0].audit_id); // no overlap

    // Page 3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res3 = await (GET as any)(
      makeReq(`?limit=20&cursor=${encodeURIComponent(body2.cursor)}`)
    );
    const body3 = await res3.json();
    expect(body3.items).toHaveLength(20);
    expect(body3.cursor).not.toBeNull();

    // Page 4 (15 rows remaining)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res4 = await (GET as any)(
      makeReq(`?limit=20&cursor=${encodeURIComponent(body3.cursor)}`)
    );
    const body4 = await res4.json();
    expect(body4.items).toHaveLength(15);
    expect(body4.cursor).toBeNull();
  });

  it("skips dedup pointer keys (containing :hash:)", async () => {
    seedRow({ audit_id: "real1", timestamp: "2026-05-18T10:00:00.000Z" });
    // Manually seed a dedup pointer — must be skipped
    hoist.store.set(
      "unipile:audit:hash:abc123",
      JSON.stringify({
        audit_id: "real1",
        actor_user_id: "u1",
        tool: "linkedin_send_message",
        account_id: "accA",
        params_hash: "abc123",
        result: "success",
        verified: true,
        dedup_hit: false,
        timestamp: "2026-05-18T10:00:00.000Z",
      })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total_estimate).toBe(1);
  });

  it("falls back to page 1 on invalid cursor (does NOT return 500)", async () => {
    seedRow({ audit_id: "a1", timestamp: "2026-05-18T10:00:00.000Z" });
    seedRow({ audit_id: "a2", timestamp: "2026-05-18T11:00:00.000Z" });

    // Cursor that decodes to a non-existent audit_id → findIndex === -1 → page 1
    const bogus = Buffer.from("does-not-exist", "utf-8").toString("base64");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq(`?cursor=${encodeURIComponent(bogus)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
  });

  it("sets Cache-Control: private, max-age=10", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (GET as any)(makeReq());
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=10");
  });
});
