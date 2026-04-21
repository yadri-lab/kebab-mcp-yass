/**
 * Tests for src/core/with-bootstrap-rehydrate.ts — DUR-02.
 *
 * Behaviors covered:
 *   1. Wrapped handler runs after rehydrate resolves.
 *   2. Handler is called exactly once per invocation.
 *   3. Rehydrate errors propagate (no swallowing in wrapper).
 *   4. One-shot migration fires on first invocation per process only.
 *   5. __resetBootstrapRehydrateForTests() restores the fire-once behaviour.
 *   6. Migration errors do not reject the wrapped handler (fire-and-forget).
 *   7. Wrapper forwards the `ctx` argument to the inner handler unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rehydrateMock = vi.fn(async () => {});
const migrationMock = vi.fn(async () => {});

vi.mock("@/core/first-run", () => ({
  rehydrateBootstrapAsync: () => rehydrateMock(),
}));

vi.mock("@/core/migrations/v0.10-tenant-prefix", () => ({
  runV010TenantPrefixMigration: () => migrationMock(),
}));

// Import after mocks so the HOC picks up the mocked dependencies.
import {
  withBootstrapRehydrate,
  __resetBootstrapRehydrateForTests,
  BOOTSTRAP_EXEMPT_MARKER,
} from "@/core/with-bootstrap-rehydrate";

function makeRequest(): Request {
  return new Request("https://test.local/api/x", { method: "GET" });
}

describe("withBootstrapRehydrate (DUR-02)", () => {
  beforeEach(() => {
    rehydrateMock.mockReset();
    rehydrateMock.mockResolvedValue(undefined);
    migrationMock.mockReset();
    migrationMock.mockResolvedValue(undefined);
    __resetBootstrapRehydrateForTests();
  });

  afterEach(() => {
    __resetBootstrapRehydrateForTests();
  });

  it("awaits rehydrateBootstrapAsync before invoking the inner handler", async () => {
    const calls: string[] = [];
    rehydrateMock.mockImplementation(async () => {
      calls.push("rehydrate");
    });
    const inner = vi.fn(async (_req: Request) => {
      calls.push("handler");
      return new Response("ok");
    });
    const wrapped = withBootstrapRehydrate(inner);

    const res = await wrapped(makeRequest());
    expect(res).toBeInstanceOf(Response);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["rehydrate", "handler"]);
  });

  it("re-throws rehydrate errors (no swallowing)", async () => {
    rehydrateMock.mockRejectedValueOnce(new Error("kv-down"));
    const inner = vi.fn(async (_req: Request) => new Response("ok"));
    const wrapped = withBootstrapRehydrate(inner);

    await expect(wrapped(makeRequest())).rejects.toThrow("kv-down");
    expect(inner).not.toHaveBeenCalled();
  });

  it("fires the one-shot migration on first invocation only", async () => {
    const inner = vi.fn(async (_req: Request) => new Response("ok"));
    const wrapped = withBootstrapRehydrate(inner);

    await wrapped(makeRequest());
    await wrapped(makeRequest());
    await wrapped(makeRequest());

    // Wait one tick so the fire-and-forget has a chance to land.
    await new Promise((r) => setImmediate(r));

    expect(migrationMock).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("__resetBootstrapRehydrateForTests re-arms the one-shot flag", async () => {
    const inner = vi.fn(async (_req: Request) => new Response("ok"));
    const wrapped = withBootstrapRehydrate(inner);

    await wrapped(makeRequest());
    await new Promise((r) => setImmediate(r));
    expect(migrationMock).toHaveBeenCalledTimes(1);

    __resetBootstrapRehydrateForTests();
    await wrapped(makeRequest());
    await new Promise((r) => setImmediate(r));
    expect(migrationMock).toHaveBeenCalledTimes(2);
  });

  it("migration failure does not reject the wrapped handler", async () => {
    migrationMock.mockRejectedValueOnce(new Error("migration-boom"));
    const inner = vi.fn(async (_req: Request) => new Response("ok"));
    const wrapped = withBootstrapRehydrate(inner);

    // Wrapped should succeed; migration error is swallowed by the .catch.
    const res = await wrapped(makeRequest());
    expect(res).toBeInstanceOf(Response);
    // Allow the fire-and-forget to settle.
    await new Promise((r) => setImmediate(r));
    expect(migrationMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the ctx argument unchanged", async () => {
    const inner = vi.fn(
      async (_req: Request, ctx?: unknown) =>
        new Response(JSON.stringify(ctx ?? null), {
          headers: { "Content-Type": "application/json" },
        })
    );
    const wrapped = withBootstrapRehydrate(inner);
    const ctx = { params: Promise.resolve({ id: "abc" }) };

    const res = await wrapped(makeRequest(), ctx);
    expect(inner).toHaveBeenCalledWith(expect.any(Request), ctx);
    expect(res).toBeInstanceOf(Response);
  });

  it("exports BOOTSTRAP_EXEMPT_MARKER string for the contract test", () => {
    expect(BOOTSTRAP_EXEMPT_MARKER).toBe("BOOTSTRAP_EXEMPT:");
  });
});
