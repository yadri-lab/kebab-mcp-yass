/**
 * Phase 68 / Plan 02 / Task 1 — UnipileClient lazy singleton tests.
 *
 * Mirrors src/connectors/apify/lib/__tests__/client.test.ts (env mutation +
 * vi.resetModules between cases) and uses the vi.hoisted() pattern that
 * Plan 01 manifest tests established for shared mock state in vitest 4.x.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const hoist = vi.hoisted(() => {
  // ctorCalls captures every `new UnipileClient(dsn, token)` invocation across
  // the suite. We re-create the array via `length = 0` in beforeEach so we
  // never re-import the helper (re-imports would break the hoist binding).
  const ctorCalls: Array<[string, string]> = [];
  class UnipileClientMock {
    public dsn: string;
    public token: string;
    constructor(dsn: string, token: string) {
      this.dsn = dsn;
      this.token = token;
      ctorCalls.push([dsn, token]);
    }
  }
  return { ctorCalls, UnipileClientMock };
});

vi.mock("unipile-node-sdk", () => ({
  UnipileClient: hoist.UnipileClientMock,
  // Plan 02 errors.ts will import UnsuccessfulRequestError from the same
  // module — provide a class stub so any incidental cross-import (errors
  // module pulled in via client transitively) doesn't blow up.
  UnsuccessfulRequestError: class extends Error {
    body: unknown = {};
  },
}));

async function loadClient() {
  return await import("../client");
}

describe("Phase 68 / Plan 02 — unipile/lib/client.ts singleton", () => {
  beforeEach(() => {
    hoist.ctorCalls.length = 0;
    process.env.UNIPILE_DSN = "api.unipile.com";
    process.env.UNIPILE_TOKEN = "fake-token";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.UNIPILE_DSN;
    delete process.env.UNIPILE_TOKEN;
  });

  it("returns the same instance on repeated calls (warm-lambda memoization)", async () => {
    const { getUnipileClient } = await loadClient();
    const a = getUnipileClient();
    const b = getUnipileClient();
    expect(a).toBe(b);
    expect(hoist.ctorCalls).toHaveLength(1);
  });

  it("constructs UnipileClient with https://<dsn> and token (SDK base URL convention)", async () => {
    const { getUnipileClient } = await loadClient();
    getUnipileClient();
    expect(hoist.ctorCalls).toEqual([["https://api.unipile.com", "fake-token"]]);
  });

  it("passes through DSN already containing https:// (Unipile dashboard format)", async () => {
    process.env.UNIPILE_DSN = "https://api41.unipile.com:17153";
    const { getUnipileClient } = await loadClient();
    getUnipileClient();
    expect(hoist.ctorCalls).toEqual([["https://api41.unipile.com:17153", "fake-token"]]);
  });

  it("passes through DSN already containing http:// (no double-prefix)", async () => {
    process.env.UNIPILE_DSN = "http://localhost:8080";
    const { getUnipileClient } = await loadClient();
    getUnipileClient();
    expect(hoist.ctorCalls).toEqual([["http://localhost:8080", "fake-token"]]);
  });

  it("throws when UNIPILE_DSN is missing AND does NOT invoke SDK constructor", async () => {
    delete process.env.UNIPILE_DSN;
    const { getUnipileClient } = await loadClient();
    expect(() => getUnipileClient()).toThrow(/UNIPILE_DSN/);
    expect(hoist.ctorCalls).toHaveLength(0);
  });

  it("throws when UNIPILE_TOKEN is missing AND does NOT invoke SDK constructor", async () => {
    delete process.env.UNIPILE_TOKEN;
    const { getUnipileClient } = await loadClient();
    expect(() => getUnipileClient()).toThrow(/UNIPILE_TOKEN/);
    expect(hoist.ctorCalls).toHaveLength(0);
  });

  it("__resetUnipileClientForTests clears the cache (next call re-constructs)", async () => {
    const { getUnipileClient, __resetUnipileClientForTests } = await loadClient();
    getUnipileClient();
    __resetUnipileClientForTests();
    getUnipileClient();
    expect(hoist.ctorCalls).toHaveLength(2);
  });

  it("sanitizeUnipileText redacts the token value from error strings", async () => {
    const { sanitizeUnipileText } = await loadClient();
    expect(sanitizeUnipileText("auth=fake-token failed")).toBe("auth=<redacted> failed");
  });

  it("sanitizeUnipileText returns input unchanged when token is unset", async () => {
    delete process.env.UNIPILE_TOKEN;
    const { sanitizeUnipileText } = await loadClient();
    expect(sanitizeUnipileText("nothing to redact here")).toBe("nothing to redact here");
  });
});
