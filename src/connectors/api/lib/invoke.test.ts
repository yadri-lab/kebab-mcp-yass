import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { interpolate, invokeApiTool, testApiConnection, __resetAllowLocalWarn } from "./invoke";
import type { ApiConnection, ApiTool } from "../store";

function makeConn(partial: Partial<ApiConnection> = {}): ApiConnection {
  return {
    id: "conn_123",
    name: "Test",
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
    headers: {},
    timeoutMs: 10000,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function makeTool(partial: Partial<ApiTool> = {}): ApiTool {
  return {
    id: "tool_123",
    connectionId: "conn_123",
    name: "demo",
    description: "Demo tool",
    method: "GET",
    pathTemplate: "",
    arguments: [],
    queryTemplate: {},
    bodyTemplate: "",
    readOrWrite: "read",
    destructive: false,
    timeoutMs: 10000,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("interpolate", () => {
  it("replaces {{name}} tokens", () => {
    expect(interpolate("/users/{{id}}", { id: "42" })).toBe("/users/42");
  });
  it("missing args become empty string", () => {
    expect(interpolate("/x/{{missing}}/y", {})).toBe("/x//y");
  });
  it("ignores malformed tokens", () => {
    expect(interpolate("/x/{{ 1bad }}/y", { ok: "v" })).toBe("/x/{{ 1bad }}/y");
  });
});

describe("invokeApiTool", () => {
  beforeEach(() => {
    // Allow localhost for the mock fetch target.
    process.env["KEBAB_API_CONN_ALLOW_LOCAL"] = "1";
  });
  afterEach(() => {
    delete process.env["KEBAB_API_CONN_ALLOW_LOCAL"];
    vi.restoreAllMocks();
  });

  it("issues a GET with interpolated path + query + headers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const conn = makeConn({
      baseUrl: "http://127.0.0.1:5000",
      auth: { type: "bearer", token: "tok-xyz" },
      headers: { "X-Custom": "1" },
    });
    const tool = makeTool({
      pathTemplate: "/users/{{id}}",
      queryTemplate: { limit: "{{limit}}" },
      arguments: [
        { name: "id", description: "", required: true, type: "string" },
        { name: "limit", description: "", required: false, type: "string" },
      ],
    });

    const result = await invokeApiTool(conn, tool, { id: "42", limit: "10" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain("ok");

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [calledUrl, init] = call!;
    expect(String(calledUrl)).toBe("http://127.0.0.1:5000/users/42?limit=10");
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-xyz");
    expect(headers["X-Custom"]).toBe("1");
  });

  it("sends body on POST + guesses JSON content-type when body parses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 201 }));

    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool({
      method: "POST",
      pathTemplate: "/widgets",
      bodyTemplate: '{"name":"{{name}}"}',
      arguments: [{ name: "name", description: "", required: true, type: "string" }],
    });

    await invokeApiTool(conn, tool, { name: "foo" });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBe('{"name":"foo"}');
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("rejects private IPs when local is not allowed", async () => {
    delete process.env["KEBAB_API_CONN_ALLOW_LOCAL"];
    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool();
    await expect(invokeApiTool(conn, tool, {})).rejects.toThrow(/URL rejected|loopback|private/i);
  });

  it("truncates bodies over 512 KB", async () => {
    const big = "a".repeat(600 * 1024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(big, { status: 200 }));
    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool();
    const res = await invokeApiTool(conn, tool, {});
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(512 * 1024);
  });
});

describe("SEC-A-02: KEBAB_API_CONN_ALLOW_LOCAL ignored in production", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origVercel = process.env.VERCEL;

  beforeEach(() => {
    __resetAllowLocalWarn();
    process.env.KEBAB_API_CONN_ALLOW_LOCAL = "1";
  });
  afterEach(() => {
    delete process.env.KEBAB_API_CONN_ALLOW_LOCAL;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = origVercel;
    vi.restoreAllMocks();
  });

  it("rejects loopback in production even when KEBAB_API_CONN_ALLOW_LOCAL=1", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.VERCEL;
    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool();
    await expect(invokeApiTool(conn, tool, {})).rejects.toThrow(/URL rejected|loopback|private/i);
  });

  it("rejects loopback on Vercel even when KEBAB_API_CONN_ALLOW_LOCAL=1", async () => {
    delete process.env.NODE_ENV;
    process.env.VERCEL = "1";
    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool();
    await expect(invokeApiTool(conn, tool, {})).rejects.toThrow(/URL rejected|loopback|private/i);
  });

  it("logs an error to stderr (once) when flag is forced in production", async () => {
    process.env.NODE_ENV = "production";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool();
    await expect(invokeApiTool(conn, tool, {})).rejects.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("KEBAB_API_CONN_ALLOW_LOCAL is ignored in production")
    );
  });

  it("still allows loopback in dev (NODE_ENV unset, no VERCEL)", async () => {
    delete process.env.NODE_ENV;
    delete process.env.VERCEL;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const conn = makeConn({ baseUrl: "http://127.0.0.1:5000" });
    const tool = makeTool();
    const res = await invokeApiTool(conn, tool, {});
    expect(res.ok).toBe(true);
  });
});

describe("testApiConnection", () => {
  beforeEach(() => {
    process.env["KEBAB_API_CONN_ALLOW_LOCAL"] = "1";
  });
  afterEach(() => {
    delete process.env["KEBAB_API_CONN_ALLOW_LOCAL"];
    vi.restoreAllMocks();
  });

  it("returns ok + status on a 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("pong", { status: 200 }));
    const res = await testApiConnection(makeConn({ baseUrl: "http://127.0.0.1:5000" }), "/ping");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it("returns ok:false on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await testApiConnection(makeConn({ baseUrl: "http://127.0.0.1:5000" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });
});
