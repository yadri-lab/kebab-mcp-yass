/**
 * Phase 68 / Plan 06 / Task 2 — linkedin_get_relationship_status coverage.
 *
 * Verifies the D-21 locked envelope ({degree, connection_status} only),
 * the Pitfall 3 mapping rule (missing network_distance → null, NEVER 3),
 * and that error/D-20 paths yield a graceful degraded envelope rather
 * than throwing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getProfileMock, accountGetAllMock, kvMock, FakeUnsuccessful } = vi.hoisted(() => {
  const getProfileMock = vi.fn();
  const accountGetAllMock = vi.fn();
  const kvMock = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };
  class FakeUnsuccessful extends Error {
    body: { status?: number };
    constructor(status: number) {
      super("");
      this.body = { status };
      this.name = "UnsuccessfulRequestError";
    }
  }
  return { getProfileMock, accountGetAllMock, kvMock, FakeUnsuccessful };
});

vi.mock("../../lib/client", () => ({
  getUnipileClient: () => ({
    users: { getProfile: getProfileMock },
    account: { getAll: accountGetAllMock },
  }),
  __resetUnipileClientForTests: () => {},
  sanitizeUnipileText: (s: string) => s,
}));

vi.mock("@/core/request-context", () => ({
  getContextKVStore: () => kvMock,
  getCurrentTenantId: () => "test-tenant",
}));

vi.mock("unipile-node-sdk", () => ({
  UnsuccessfulRequestError: FakeUnsuccessful,
}));

import { handleLinkedinGetRelationshipStatus } from "../linkedin-get-relationship-status";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]!.text) as {
    degree: 1 | 2 | 3 | null;
    connection_status: string;
    error?: string;
    available_accounts?: string[];
  };
}

describe("linkedin_get_relationship_status — D-21 envelope", () => {
  beforeEach(() => {
    getProfileMock.mockReset();
    accountGetAllMock.mockReset();
    kvMock.get.mockReset();
    kvMock.set.mockReset();
    kvMock.delete.mockReset();
    kvMock.get.mockResolvedValue(null);
    kvMock.set.mockResolvedValue(undefined);
    accountGetAllMock.mockResolvedValue({ items: [{ id: "acct_1", type: "LINKEDIN" }] });
  });

  it.each([
    ["FIRST_DEGREE", 1],
    ["SECOND_DEGREE", 2],
    ["THIRD_DEGREE", 3],
    ["OUT_OF_NETWORK", null],
  ] as const)("maps network_distance=%s → degree=%s", async (nd, expected) => {
    // First call: resolveProviderId's getProfile (cache miss path).
    // Second call: the relationship-check getProfile.
    getProfileMock
      .mockResolvedValueOnce({ provider_id: "urn:x", network_distance: nd })
      .mockResolvedValueOnce({ provider_id: "urn:x", network_distance: nd });
    const env = parse(
      await handleLinkedinGetRelationshipStatus({
        profile_url: "https://linkedin.com/in/x",
      })
    );
    expect(env.degree).toBe(expected);
    expect(env.connection_status).toBe(nd);
  });

  it("missing network_distance maps to degree: null + connection_status: 'unknown' (Pitfall 3)", async () => {
    getProfileMock
      .mockResolvedValueOnce({ provider_id: "urn:x" /* no nd */ })
      .mockResolvedValueOnce({ provider_id: "urn:x" /* no nd */ });
    const env = parse(
      await handleLinkedinGetRelationshipStatus({
        profile_url: "https://linkedin.com/in/x",
      })
    );
    expect(env.degree).toBeNull();
    expect(env.connection_status).toBe("unknown");
  });

  it("envelope does NOT contain last_message_at or has_replied (D-21)", async () => {
    getProfileMock
      .mockResolvedValueOnce({ provider_id: "urn:x", network_distance: "FIRST_DEGREE" })
      .mockResolvedValueOnce({
        provider_id: "urn:x",
        network_distance: "FIRST_DEGREE",
        last_message_at: "ignored",
        has_replied: true,
      });
    const env = parse(
      await handleLinkedinGetRelationshipStatus({
        profile_url: "https://linkedin.com/in/x",
      })
    );
    expect(env).not.toHaveProperty("last_message_at");
    expect(env).not.toHaveProperty("has_replied");
  });

  it("propagates 429 as error: error_rate_limit", async () => {
    getProfileMock.mockRejectedValue(new FakeUnsuccessful(429));
    vi.useFakeTimers();
    try {
      const p = handleLinkedinGetRelationshipStatus({
        profile_url: "https://linkedin.com/in/x",
      });
      // withRetry sleeps on 429; flush its timers.
      await vi.advanceTimersByTimeAsync(5_000);
      const env = parse(await p);
      expect(env.error).toBe("error_rate_limit");
      expect(env.degree).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("D-20: 0 LinkedIn accounts → error_no_linkedin_account", async () => {
    accountGetAllMock.mockResolvedValue({ items: [] });
    const env = parse(
      await handleLinkedinGetRelationshipStatus({
        profile_url: "https://linkedin.com/in/x",
      })
    );
    expect(env.error).toBe("error_no_linkedin_account");
    expect(env.degree).toBeNull();
  });

  it("D-20: ≥2 LinkedIn accounts → error_account_id_required + available_accounts", async () => {
    accountGetAllMock.mockResolvedValue({
      items: [
        { id: "a", type: "LINKEDIN" },
        { id: "b", type: "LINKEDIN" },
      ],
    });
    const env = parse(
      await handleLinkedinGetRelationshipStatus({
        profile_url: "https://linkedin.com/in/x",
      })
    );
    expect(env.error).toBe("error_account_id_required");
    expect(env.available_accounts).toEqual(["a", "b"]);
    expect(env.degree).toBeNull();
  });
});
