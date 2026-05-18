/**
 * Phase 70 / Plan 02 / Task 2 — `message_received` handler tests (D-63 / D-64 / D-78).
 *
 * Coverage:
 *  - is_sender:true → defense-in-depth log.warn + early return (no KV, no audit).
 *    Dispatcher already filters these (D-63) — handler double-checks.
 *  - is_sender:false + matching audit row → enrich with last_replied_at.
 *  - is_sender:false + no matching row → insert standalone
 *    inbound_message_unknown_origin row with content_hash (NEVER raw body).
 *  - Missing account_id / message_id → warn + early return.
 *  - Missing tenant mapping → warn + early return.
 *  - Body NEVER appears in the persisted row (D-64) — only the 16-char hash.
 *  - NEGATIVE: no global.fetch.
 *  - All KV access inside runWithTenant.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
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

import { handleMessageReceived } from "../new-message";

function expectedHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

describe("handleMessageReceived (D-63 / D-64 / D-78)", () => {
  beforeEach(() => {
    hoist.findAuditByProviderId.mockReset();
    hoist.writeAuditRow.mockReset().mockResolvedValue();
    hoist.generateAuditId.mockReset().mockReturnValue("uuid-msg-generated");
    hoist.resolveTenantFromAccountId.mockReset();
    hoist.runWithTenant.mockClear();
    hoist.runWithTenantCalls.length = 0;
  });

  it("is_sender:true is dropped defensively (warn + return, no KV interaction)", async () => {
    await handleMessageReceived({
      is_sender: true,
      account_id: "acct_1",
      message_id: "msg_1",
      body: "hello",
    });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([]);
  });

  it("enriches matching audit row with last_replied_at (re-writes under same audit_id)", async () => {
    const existing: AuditRow = {
      audit_id: "uuid-original",
      actor_user_id: "user-42",
      tool: "linkedin_send_message",
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

    await handleMessageReceived({
      account_id: "acct_1",
      message_id: "msg_1",
      attendee_provider_id: "ACoAA-target",
      body: "hi back",
      is_sender: false,
    });

    expect(hoist.writeAuditRow).toHaveBeenCalledTimes(1);
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    expect(written.audit_id).toBe("uuid-original");
    expect(written.last_replied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written.result).toBe("success");
    expect(hoist.generateAuditId).not.toHaveBeenCalled();
    expect(hoist.runWithTenantCalls).toEqual([{ tenantId: "tenant-A" }]);
  });

  it("inserts standalone inbound_message_unknown_origin row when no audit row matches (with content_hash, NOT body)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-B");
    hoist.findAuditByProviderId.mockResolvedValue(null);

    const body = "Hey, are you available for a call next week?";
    await handleMessageReceived({
      account_id: "acct_2",
      message_id: "msg_2",
      attendee_provider_id: "ACoAA-stranger",
      body,
      is_sender: false,
    });

    expect(hoist.writeAuditRow).toHaveBeenCalledTimes(1);
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    expect(written).toMatchObject({
      audit_id: "uuid-msg-generated",
      tool: "webhook:message_received",
      account_id: "acct_2",
      result: "inbound_message_unknown_origin",
      verified: true,
      dedup_hit: false,
      recipient_provider_id: "ACoAA-stranger",
    });
    expect(written.last_replied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // D-64 — content_hash present in params_hash
    expect(written.params_hash).toBe(`inbound:${expectedHash(body)}`);
  });

  it("D-64: persisted row JSON does NOT contain the raw body text (only the hash)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-C");
    hoist.findAuditByProviderId.mockResolvedValue(null);

    const body = "VERY_SECRET_MESSAGE_TEXT_ABCDEF";
    await handleMessageReceived({
      account_id: "acct_3",
      message_id: "msg_3",
      attendee_provider_id: "ACoAA-x",
      body,
      is_sender: false,
    });
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain("VERY_SECRET");
    // hash IS present
    expect(serialized).toContain(expectedHash(body));
  });

  it("falls back to payload.message when payload.body is absent (still hashed)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-D");
    hoist.findAuditByProviderId.mockResolvedValue(null);

    const msg = "fallback message text";
    await handleMessageReceived({
      account_id: "acct_4",
      message_id: "msg_4",
      attendee_provider_id: "ACoAA-y",
      message: msg,
      is_sender: false,
    });
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    expect(written.params_hash).toBe(`inbound:${expectedHash(msg)}`);
    expect(JSON.stringify(written)).not.toContain(msg);
  });

  it("warns + early returns on missing account_id", async () => {
    await handleMessageReceived({ message_id: "msg_x", is_sender: false });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
  });

  it("warns + early returns on missing message_id", async () => {
    await handleMessageReceived({ account_id: "acct_x", is_sender: false });
    expect(hoist.resolveTenantFromAccountId).not.toHaveBeenCalled();
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
  });

  it("warns + early returns when no tenant mapping is found (fail-CLOSED)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue(null);
    await handleMessageReceived({
      account_id: "unclaimed",
      message_id: "msg_z",
      attendee_provider_id: "ACoAA-x",
      body: "hi",
      is_sender: false,
    });
    expect(hoist.writeAuditRow).not.toHaveBeenCalled();
    expect(hoist.findAuditByProviderId).not.toHaveBeenCalled();
  });

  it("when sender attendee id is absent, still inserts standalone row (recipient_provider_id undefined)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-E");
    // No senderProviderId → findAuditByProviderId should NOT be called
    await handleMessageReceived({
      account_id: "acct_5",
      message_id: "msg_5",
      body: "anonymous reply",
      is_sender: false,
    });
    expect(hoist.findAuditByProviderId).not.toHaveBeenCalled();
    expect(hoist.writeAuditRow).toHaveBeenCalledTimes(1);
    const written = hoist.writeAuditRow.mock.calls[0]![0];
    expect(written.result).toBe("inbound_message_unknown_origin");
    expect(written.recipient_provider_id).toBeUndefined();
  });

  it("NEGATIVE: never calls global.fetch (no outbound HTTP, no Slack POST, no CRM POST)", async () => {
    hoist.resolveTenantFromAccountId.mockResolvedValue("tenant-Z");
    hoist.findAuditByProviderId.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      await handleMessageReceived({
        account_id: "acct_9",
        message_id: "msg_9",
        attendee_provider_id: "ACoAA-x",
        body: "hi",
        is_sender: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
