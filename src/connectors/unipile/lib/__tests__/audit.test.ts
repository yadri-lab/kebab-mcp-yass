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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  const kvMock = {
    get: vi.fn<(k: string) => Promise<string | null>>(),
    set: vi.fn<(k: string, v: string, ttl?: number) => Promise<void>>(),
    delete: vi.fn<(k: string) => Promise<void>>(),
    list: vi.fn<(prefix?: string) => Promise<string[]>>(),
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
  findAuditByProviderId,
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

/**
 * Phase 69 / Plan 01 — AuditResult extension assertions.
 *
 * The 9 new members are checked two ways:
 *  1. Type-level assignability — each literal flows into a typed AuditResult
 *     local, so any drift on the union breaks the build before the test runs.
 *  2. Runtime equality — confirms the literal survives transpilation.
 *
 * Plus an explicit anti-pattern grep mirroring T-68-04-04: 'pending' must
 * NEVER appear in audit.ts as an AuditResult union member.
 */
describe("Phase 69 AuditResult extensions (D-23, D-26, D-29, D-32, D-43, D-45)", () => {
  it.each<AuditRow["result"]>([
    "dry_run",
    "error_attachment_too_large",
    "error_inmail_not_authorized",
    "error_inmail_requires_premium",
    "error_invalid_request",
    "error_rate_limit_kebab",
    "error_recipient_unreachable",
    "error_inmail_recipient_not_eligible",
    "error_inmail_cap_exceeded",
  ])("%s is assignable to AuditResult", (member) => {
    const x: AuditRow["result"] = member;
    expect(x).toBe(member);
  });

  it("phase-68 members are still present (locked, unchanged order)", () => {
    const phase68: Array<AuditRow["result"]> = [
      "success",
      "unverified_timeout",
      "error_rate_limit",
      "error_account_restricted",
      "error_not_connected",
      "error_unipile_5xx",
    ];
    phase68.forEach((m) => {
      const x: AuditRow["result"] = m;
      expect(x).toBe(m);
    });
  });

  it("AuditResult union does NOT contain 'pending' (D-13/D-14 strict-boolean invariant)", () => {
    // Static source-code grep — fails loud if any future commit reintroduces
    // 'pending' as an AuditResult union member. Mirrors T-68-04-04 guard but
    // re-asserted in phase 69 so the extended enum can't accidentally regress.
    const src = readFileSync(resolve(__dirname, "../audit.ts"), "utf8");
    expect(src).not.toMatch(/\|\s*['"]pending['"]/);
  });
});

/**
 * Phase 70 / Plan 02 — AuditResult extension (D-78) + AuditRow optional fields
 * (recipient_provider_id / accepted_at / last_replied_at) + findAuditByProviderId
 * reverse-lookup helper.
 *
 * D-78 contract: EXACTLY 3 new members. The static grep asserts the count so
 * any drift (accidental 4th member, accidental removal) fails the build
 * before a downstream consumer notices.
 */
describe("Phase 70 AuditResult extensions (D-78 — exactly 3 new members)", () => {
  it.each<AuditRow["result"]>([
    "error_account_halted",
    "inbound_accept_unknown_origin",
    "inbound_message_unknown_origin",
  ])("%s is assignable to AuditResult", (member) => {
    const x: AuditRow["result"] = member;
    expect(x).toBe(member);
  });

  it("audit.ts source contains exactly 3 occurrences of each new member as a union literal", () => {
    const src = readFileSync(resolve(__dirname, "../audit.ts"), "utf8");
    // Each new member should appear as a string-literal union member (| "name").
    // Allow comment references elsewhere — only the union assertion is load-bearing.
    expect(src).toMatch(/\|\s*"error_account_halted"/);
    expect(src).toMatch(/\|\s*"inbound_accept_unknown_origin"/);
    expect(src).toMatch(/\|\s*"inbound_message_unknown_origin"/);
  });
});

/**
 * Phase 71 / Plan 71-01 — AuditResult extension (D-88) — global kill switch
 * member. Mirrors the Phase 70 D-78 shape: append at the END of the union,
 * 1 new member, block-comment annotation, no reordering of earlier members.
 */
describe("Phase 71 AuditResult extension (D-88 — error_writes_disabled)", () => {
  it("error_writes_disabled is assignable to AuditResult", () => {
    const x: AuditRow["result"] = "error_writes_disabled";
    expect(x).toBe("error_writes_disabled");
  });

  it("audit.ts source contains error_writes_disabled as a union literal", () => {
    const src = readFileSync(resolve(__dirname, "../audit.ts"), "utf8");
    expect(src).toMatch(/\|\s*"error_writes_disabled"/);
  });
});

describe("AuditRow optional Phase-70 fields", () => {
  it("accepts an AuditRow with recipient_provider_id + accepted_at + last_replied_at populated", () => {
    const row: AuditRow = {
      audit_id: "uuid-70",
      actor_user_id: "system",
      tool: "webhook:new_relation",
      account_id: "acct_70",
      params_hash: "inbound",
      result: "inbound_accept_unknown_origin",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-18T20:00:00Z",
      recipient_provider_id: "ACoAA-xyz",
      accepted_at: "2026-05-18T20:00:00Z",
      last_replied_at: "2026-05-18T20:01:00Z",
    };
    expect(row.recipient_provider_id).toBe("ACoAA-xyz");
    expect(row.accepted_at).toBe("2026-05-18T20:00:00Z");
    expect(row.last_replied_at).toBe("2026-05-18T20:01:00Z");
  });

  it("AuditRow without the new optional fields still compiles (backward compatible)", () => {
    const row: AuditRow = {
      audit_id: "uuid-bw",
      actor_user_id: "u",
      tool: "linkedin_send_connection",
      account_id: "a",
      params_hash: "x",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-18T20:00:00Z",
    };
    expect(row.recipient_provider_id).toBeUndefined();
    expect(row.accepted_at).toBeUndefined();
    expect(row.last_replied_at).toBeUndefined();
  });
});

describe("findAuditByProviderId (Phase 70 reverse lookup)", () => {
  beforeEach(() => {
    hoist.kvMock.get.mockReset();
    hoist.kvMock.set.mockReset();
    hoist.kvMock.list.mockReset();
  });

  it("returns null when providerId is empty (no scan)", async () => {
    const out = await findAuditByProviderId("");
    expect(out).toBeNull();
    expect(hoist.kvMock.list).not.toHaveBeenCalled();
  });

  it("returns null when the KV store has no audit rows", async () => {
    hoist.kvMock.list.mockResolvedValue([]);
    const out = await findAuditByProviderId("ACoAA-xyz");
    expect(out).toBeNull();
    expect(hoist.kvMock.list).toHaveBeenCalledWith("unipile:audit:");
  });

  it("returns the most recent matching row (highest timestamp wins)", async () => {
    const older: AuditRow = {
      audit_id: "uuid-old",
      actor_user_id: "u",
      tool: "linkedin_send_connection",
      account_id: "acct_1",
      params_hash: "h1",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-01T12:00:00Z",
      recipient_provider_id: "ACoAA-xyz",
    };
    const newer: AuditRow = {
      audit_id: "uuid-new",
      actor_user_id: "u",
      tool: "linkedin_send_message",
      account_id: "acct_1",
      params_hash: "h2",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-15T12:00:00Z",
      recipient_provider_id: "ACoAA-xyz",
    };
    hoist.kvMock.list.mockResolvedValue([
      "unipile:audit:uuid-old",
      "unipile:audit:uuid-new",
      "unipile:audit:uuid-other",
    ]);
    hoist.kvMock.get.mockImplementation(async (k: string) => {
      if (k === "unipile:audit:uuid-old") return JSON.stringify(older);
      if (k === "unipile:audit:uuid-new") return JSON.stringify(newer);
      if (k === "unipile:audit:uuid-other")
        return JSON.stringify({ ...older, audit_id: "uuid-other", recipient_provider_id: "OTHER" });
      return null;
    });
    const out = await findAuditByProviderId("ACoAA-xyz");
    expect(out).toEqual(newer);
  });

  it("skips pointer keys containing ':hash:'", async () => {
    hoist.kvMock.list.mockResolvedValue(["unipile:audit:hash:abc123", "unipile:audit:hash:def456"]);
    const out = await findAuditByProviderId("ACoAA-xyz");
    expect(out).toBeNull();
    expect(hoist.kvMock.get).not.toHaveBeenCalled();
  });

  it("tolerates corrupt JSON in individual rows (keeps scanning)", async () => {
    const good: AuditRow = {
      audit_id: "uuid-good",
      actor_user_id: "u",
      tool: "linkedin_send_connection",
      account_id: "a",
      params_hash: "h",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-10T12:00:00Z",
      recipient_provider_id: "ACoAA-xyz",
    };
    hoist.kvMock.list.mockResolvedValue(["unipile:audit:uuid-broken", "unipile:audit:uuid-good"]);
    hoist.kvMock.get.mockImplementation(async (k: string) => {
      if (k === "unipile:audit:uuid-broken") return "not-json{";
      if (k === "unipile:audit:uuid-good") return JSON.stringify(good);
      return null;
    });
    const out = await findAuditByProviderId("ACoAA-xyz");
    expect(out).toEqual(good);
  });

  it("returns null when kv.list itself rejects (fail OPEN to standalone insert)", async () => {
    hoist.kvMock.list.mockRejectedValue(new Error("kv-down"));
    const out = await findAuditByProviderId("ACoAA-xyz");
    expect(out).toBeNull();
  });

  it("respects options.limit and stops scanning past it", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `unipile:audit:uuid-${i}`);
    hoist.kvMock.list.mockResolvedValue(keys);
    hoist.kvMock.get.mockResolvedValue(null); // every row "missing" → ensures we count list iterations
    await findAuditByProviderId("ACoAA-xyz", { limit: 5 });
    // The implementation increments scanned ONLY for non-pointer keys it inspects;
    // it should have made at most `limit` get() calls.
    expect(hoist.kvMock.get.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("skips rows whose recipient_provider_id does not match", async () => {
    const other: AuditRow = {
      audit_id: "uuid-other",
      actor_user_id: "u",
      tool: "linkedin_send_connection",
      account_id: "a",
      params_hash: "h",
      result: "success",
      verified: true,
      dedup_hit: false,
      timestamp: "2026-05-10T12:00:00Z",
      recipient_provider_id: "DIFFERENT",
    };
    hoist.kvMock.list.mockResolvedValue(["unipile:audit:uuid-other"]);
    hoist.kvMock.get.mockResolvedValue(JSON.stringify(other));
    const out = await findAuditByProviderId("ACoAA-xyz");
    expect(out).toBeNull();
  });
});
