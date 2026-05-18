/**
 * Phase 68 / Plan 04 / Task 1 — KV-backed audit log writer + dedup checker.
 *
 * Coverage:
 *  - generateAuditId: UUIDv4 shape, distinct values
 *  - computeParamsHash (D-05): 16-hex lowercase, deterministic, key-order independent,
 *    note-content-sensitive (1 char change = new hash), tool-sensitive,
 *    empty-vs-whitespace distinct
 *  - writeAuditRow (D-07 / D-08): dual KV write (row + hash pointer), TTL value
 *    asserted as 7,776,000 (Pitfall 7 — FilesystemKV ignores TTL, tests verify
 *    the VALUE PASSED to kv.set), persisted JSON parses back to identical row,
 *    persisted JSON contains NO note / note_text field
 *  - checkDedup: returns row on hit, null on miss, null on corrupt JSON
 *  - API surface (D-06): no `bypassDedup`, no `forceWrite`, no `dedup_key` param;
 *    computeParamsHash takes a single object arg
 *
 * Mocks: getContextKVStore via vi.hoisted() — same canonical pattern as
 * Plan 03's identifiers.test.ts (vitest 4.x mock-factory hoisting).
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
  generateAuditId,
  computeParamsHash,
  writeAuditRow,
  checkDedup,
  AUDIT_TTL_SECONDS,
  type AuditRow,
} from "../audit";

describe("generateAuditId", () => {
  it("returns a UUIDv4-shaped string", () => {
    const id = generateAuditId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns different ids on consecutive calls", () => {
    expect(generateAuditId()).not.toBe(generateAuditId());
  });
});

describe("computeParamsHash (D-05)", () => {
  it("returns 16 lowercase hex chars", () => {
    const h = computeParamsHash({
      tool: "linkedin_send_connection",
      profile_url_normalized: "https://linkedin.com/in/x",
      note: "hi",
    });
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic for the same input", () => {
    const h1 = computeParamsHash({
      tool: "x",
      profile_url_normalized: "y",
      note: "z",
    });
    const h2 = computeParamsHash({
      tool: "x",
      profile_url_normalized: "y",
      note: "z",
    });
    expect(h1).toBe(h2);
  });

  it("is independent of object key insertion order", () => {
    const a = computeParamsHash({
      tool: "t",
      profile_url_normalized: "u",
      note: "n",
    });
    // construct with different insertion order
    const b = computeParamsHash({
      note: "n",
      profile_url_normalized: "u",
      tool: "t",
    });
    expect(a).toBe(b);
  });

  it("different note (even 1 char) produces a different hash (D-05 strict)", () => {
    const base = { tool: "t", profile_url_normalized: "u", note: "hello" };
    const a = computeParamsHash(base);
    const b = computeParamsHash({ ...base, note: "hello!" });
    expect(a).not.toBe(b);
  });

  it("different tool produces a different hash", () => {
    const a = computeParamsHash({
      tool: "linkedin_send_connection",
      profile_url_normalized: "u",
      note: "n",
    });
    const b = computeParamsHash({
      tool: "linkedin_send_message",
      profile_url_normalized: "u",
      note: "n",
    });
    expect(a).not.toBe(b);
  });

  it("different profile_url_normalized produces a different hash", () => {
    const a = computeParamsHash({
      tool: "t",
      profile_url_normalized: "https://linkedin.com/in/alice",
      note: "n",
    });
    const b = computeParamsHash({
      tool: "t",
      profile_url_normalized: "https://linkedin.com/in/bob",
      note: "n",
    });
    expect(a).not.toBe(b);
  });

  it("empty note vs whitespace note produce different hashes", () => {
    const a = computeParamsHash({
      tool: "t",
      profile_url_normalized: "u",
      note: "",
    });
    const b = computeParamsHash({
      tool: "t",
      profile_url_normalized: "u",
      note: " ",
    });
    expect(a).not.toBe(b);
  });
});

describe("AUDIT_TTL_SECONDS (D-08)", () => {
  it("is exactly 90 days in seconds = 7,776,000", () => {
    expect(AUDIT_TTL_SECONDS).toBe(7_776_000);
    expect(AUDIT_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
  });
});

describe("writeAuditRow (D-07 / D-08)", () => {
  beforeEach(() => {
    hoist.kvMock.set.mockReset();
    hoist.kvMock.get.mockReset();
    hoist.kvMock.set.mockResolvedValue();
  });

  it("writes two KV entries (row + hash pointer), both with 90-day TTL", async () => {
    const row: AuditRow = {
      audit_id: "uuid-1",
      actor_user_id: "user-42",
      tool: "linkedin_send_connection",
      account_id: "acct_1",
      params_hash: "abc123def4567890",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-18T12:00:00Z",
    };
    await writeAuditRow(row);
    expect(hoist.kvMock.set).toHaveBeenCalledTimes(2);
    expect(hoist.kvMock.set).toHaveBeenCalledWith(
      "unipile:audit:uuid-1",
      expect.any(String),
      7_776_000
    );
    expect(hoist.kvMock.set).toHaveBeenCalledWith(
      "unipile:audit:hash:abc123def4567890",
      expect.any(String),
      7_776_000
    );
  });

  it("written value is JSON-parseable back into the same row", async () => {
    const row: AuditRow = {
      audit_id: "uuid-2",
      actor_user_id: "user-42",
      tool: "linkedin_send_connection",
      account_id: "acct_1",
      params_hash: "deadbeef00000000",
      result: "unverified_timeout",
      verified: false,
      dedup_hit: false,
      timestamp: "2026-05-18T12:00:00Z",
    };
    await writeAuditRow(row);
    const writtenValue = hoist.kvMock.set.mock.calls[0]?.[1] as string;
    expect(JSON.parse(writtenValue)).toEqual(row);
  });

  it("hash-pointer value is JSON-parseable back into the same row (one-shot dedup design)", async () => {
    const row: AuditRow = {
      audit_id: "uuid-3a",
      actor_user_id: "user-42",
      tool: "linkedin_send_connection",
      account_id: "acct_1",
      params_hash: "feedbeef12345678",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-18T12:00:00Z",
    };
    await writeAuditRow(row);
    // The 2nd call is the hash pointer
    const pointerValue = hoist.kvMock.set.mock.calls[1]?.[1] as string;
    expect(JSON.parse(pointerValue)).toEqual(row);
  });

  it("row JSON does NOT contain a 'note' or 'note_text' field (D-07 GDPR)", async () => {
    const row: AuditRow = {
      audit_id: "uuid-3",
      actor_user_id: "u",
      tool: "linkedin_send_connection",
      account_id: "a",
      params_hash: "x",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-18T12:00:00Z",
    };
    await writeAuditRow(row);
    const v = hoist.kvMock.set.mock.calls[0]?.[1] as string;
    expect(v).not.toMatch(/note/i);
    expect(v).not.toContain("note_text");
  });
});

describe("checkDedup", () => {
  beforeEach(() => {
    hoist.kvMock.get.mockReset();
  });

  it("returns the prior row on hit", async () => {
    const row: AuditRow = {
      audit_id: "uuid-prev",
      actor_user_id: "u",
      tool: "linkedin_send_connection",
      account_id: "a",
      params_hash: "hash-1",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-01T12:00:00Z",
    };
    hoist.kvMock.get.mockResolvedValue(JSON.stringify(row));
    const out = await checkDedup("hash-1");
    expect(out).toEqual(row);
    expect(hoist.kvMock.get).toHaveBeenCalledWith("unipile:audit:hash:hash-1");
  });

  it("returns null on miss", async () => {
    hoist.kvMock.get.mockResolvedValue(null);
    expect(await checkDedup("missing-hash")).toBeNull();
  });

  it("returns null on corrupt JSON", async () => {
    hoist.kvMock.get.mockResolvedValue("not-json{");
    expect(await checkDedup("hash-bad")).toBeNull();
  });

  it("returns null when parsed value is missing audit_id field", async () => {
    // Defensive: a corrupt-but-parseable row that does not match AuditRow shape
    hoist.kvMock.get.mockResolvedValue(JSON.stringify({ foo: "bar" }));
    expect(await checkDedup("hash-shape")).toBeNull();
  });
});

describe("API surface (D-06: NO dedup bypass parameter)", () => {
  it("audit module exports do NOT include a dedup_key or bypass function", async () => {
    const mod = await import("../audit");
    const exportNames = Object.keys(mod);
    expect(exportNames).not.toContain("bypassDedup");
    expect(exportNames).not.toContain("forceWrite");
    // computeParamsHash takes a single object arg — Function.length counts named
    // parameters before any defaults / rest. 1 = single object literal.
    expect(computeParamsHash.length).toBeLessThanOrEqual(1);
  });
});
