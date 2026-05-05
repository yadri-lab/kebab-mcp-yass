/**
 * Phase 3 — route-level tests for GET /api/admin/custom-tools/:id/runs.
 *
 * Strategy mirrors the existing admin-route tests (admin-devices-route,
 * admin-rate-limits-tenant): mock the KV store + auth at the module
 * boundary so the route's pipeline composes against a deterministic
 * surface, then assert HTTP-level shape (status, body, ordering).
 *
 * Covers:
 *  - 401 for unauthenticated requests (admin auth gate)
 *  - 404 when the tool id doesn't exist
 *  - 200 with `{ ok, runs: [] }` for a tool with no recorded runs
 *  - 200 with newest-first ordering when runs exist
 *  - `?limit=N` clamping
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const kvStore = new Map<string, string>();
let allowAdmin = true;

vi.mock("@/core/request-context", () => {
  const kv = {
    kind: "filesystem" as const,
    get: async (k: string) => kvStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      kvStore.set(k, v);
    },
    delete: async (k: string) => {
      kvStore.delete(k);
    },
    list: async (prefix?: string) =>
      Array.from(kvStore.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true)),
  };
  return {
    getContextKVStore: () => kv,
    getCurrentTenantId: () => null,
    requestContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
    getCredential: (envKey: string) => process.env[envKey],
    runWithCredentials: <T>(_creds: Record<string, string>, fn: () => T) => fn(),
  };
});

vi.mock("@/core/auth", async () => {
  const actual = await vi.importActual<typeof import("@/core/auth")>("@/core/auth");
  return {
    ...actual,
    checkAdminAuth: async () => (allowAdmin ? null : new Response("Unauthorized", { status: 401 })),
    checkCsrf: () => null,
  };
});

// Stub the store / runs-store at module boundary so we control what
// the route sees without writing through KV layers.
//
// vi.mock factories are hoisted to the top of the file, so any state
// they close over must be hoisted alongside via vi.hoisted (a regular
// `const` would TDZ when the hoisted factory call runs).
const { fakeTool, mockListRuns } = vi.hoisted(() => ({
  fakeTool: {
    id: "demo_tool",
    description: "demo",
    destructive: false,
    inputs: [],
    steps: [{ kind: "transform" as const, template: "hi", saveAs: "out" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  mockListRuns: vi.fn<(toolId: string, limit?: number) => Promise<unknown[]>>(async () => []),
}));

vi.mock("@/connectors/custom-tools/store", () => ({
  getCustomTool: vi.fn(async (id: string) => (id === fakeTool.id ? fakeTool : null)),
}));

vi.mock("@/connectors/custom-tools/runs-store", () => ({
  listRuns: mockListRuns,
}));

// Import AFTER mocks so the route picks up our stubs. Use a relative
// path because the `@/*` alias resolves to `src/*` only.
import { GET } from "../../app/api/admin/custom-tools/[id]/runs/route";

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

function makeRouteCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/admin/custom-tools/:id/runs", () => {
  beforeEach(() => {
    kvStore.clear();
    allowAdmin = true;
    mockListRuns.mockReset();
    mockListRuns.mockResolvedValue([]);
  });

  it("401 when unauthenticated", async () => {
    allowAdmin = false;
    const res = await GET(
      makeRequest("http://localhost/api/admin/custom-tools/demo_tool/runs"),
      makeRouteCtx("demo_tool")
    );
    expect(res.status).toBe(401);
    expect(mockListRuns).not.toHaveBeenCalled();
  });

  it("404 when the tool does not exist", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/admin/custom-tools/missing/runs"),
      makeRouteCtx("missing")
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not found/i);
    expect(mockListRuns).not.toHaveBeenCalled();
  });

  it("200 with empty runs array when no runs recorded", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/admin/custom-tools/demo_tool/runs"),
      makeRouteCtx("demo_tool")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.runs).toEqual([]);
    expect(mockListRuns).toHaveBeenCalledWith("demo_tool", 50);
  });

  it("returns runs in the order listRuns provides (newest first)", async () => {
    const newest = {
      toolId: "demo_tool",
      ok: true,
      totalMs: 11,
      stepCount: 1,
      stepResults: [],
      committedSteps: [],
      startedAt: "2026-05-05T12:00:01Z",
      source: "test" as const,
    };
    const older = { ...newest, totalMs: 22, startedAt: "2026-05-05T11:00:00Z" };
    mockListRuns.mockResolvedValue([newest, older]);

    const res = await GET(
      makeRequest("http://localhost/api/admin/custom-tools/demo_tool/runs"),
      makeRouteCtx("demo_tool")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: (typeof newest)[] };
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]?.startedAt).toBe(newest.startedAt);
    expect(body.runs[1]?.startedAt).toBe(older.startedAt);
  });

  it("respects ?limit=N and clamps to MAX (100)", async () => {
    await GET(
      makeRequest("http://localhost/api/admin/custom-tools/demo_tool/runs?limit=10"),
      makeRouteCtx("demo_tool")
    );
    expect(mockListRuns).toHaveBeenLastCalledWith("demo_tool", 10);

    await GET(
      makeRequest("http://localhost/api/admin/custom-tools/demo_tool/runs?limit=99999"),
      makeRouteCtx("demo_tool")
    );
    expect(mockListRuns).toHaveBeenLastCalledWith("demo_tool", 100);

    // Bogus limit → falls back to default 50
    await GET(
      makeRequest("http://localhost/api/admin/custom-tools/demo_tool/runs?limit=abc"),
      makeRouteCtx("demo_tool")
    );
    expect(mockListRuns).toHaveBeenLastCalledWith("demo_tool", 50);
  });
});
