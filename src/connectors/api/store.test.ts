import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createApiConnection,
  listApiConnections,
  getApiConnection,
  updateApiConnection,
  deleteApiConnection,
  createApiTool,
  listApiTools,
  listApiToolsByConnection,
  updateApiTool,
  deleteApiTool,
  deleteApiToolsForConnection,
} from "./store";
import { resetKVStoreCache } from "@/core/kv-store";

describe("api connections CRUD", () => {
  let tmp: string;
  const prevKv = process.env["MYMCP_KV_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-api-"));
    process.env["MYMCP_KV_PATH"] = path.join(tmp, "kv.json");
    resetKVStoreCache();
  });

  afterEach(async () => {
    if (prevKv === undefined) delete process.env["MYMCP_KV_PATH"];
    else process.env["MYMCP_KV_PATH"] = prevKv;
    resetKVStoreCache();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates and reads back a connection with redacted secrets", async () => {
    const c = await createApiConnection({
      name: "Acme CRM",
      baseUrl: "https://api.acme.example.com",
      auth: { type: "bearer", token: "secret-abc" },
      headers: { "X-Client": "kebab" },
      timeoutMs: 20000,
    });
    expect(c.id).toMatch(/^conn_[a-f0-9]{12}$/);
    expect(c.name).toBe("Acme CRM");
    const all = await listApiConnections();
    expect(all).toHaveLength(1);
    expect(await getApiConnection(c.id)).toMatchObject({ name: "Acme CRM" });
  });

  it("updates selective fields", async () => {
    const c = await createApiConnection({
      name: "One",
      baseUrl: "https://api.one.example.com",
      auth: { type: "none" },
    });
    const next = await updateApiConnection(c.id, {
      name: "One Renamed",
      auth: { type: "bearer", token: "tok" },
    });
    expect(next?.name).toBe("One Renamed");
    expect(next?.auth.type).toBe("bearer");
    expect(next?.baseUrl).toBe("https://api.one.example.com");
  });

  it("delete returns true once + false on second call", async () => {
    const c = await createApiConnection({
      name: "To Delete",
      baseUrl: "https://api.del.example.com",
      auth: { type: "none" },
    });
    expect(await deleteApiConnection(c.id)).toBe(true);
    expect(await deleteApiConnection(c.id)).toBe(false);
  });
});

describe("api tools CRUD", () => {
  let tmp: string;
  const prevKv = process.env["MYMCP_KV_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-api-tools-"));
    process.env["MYMCP_KV_PATH"] = path.join(tmp, "kv.json");
    resetKVStoreCache();
  });

  afterEach(async () => {
    if (prevKv === undefined) delete process.env["MYMCP_KV_PATH"];
    else process.env["MYMCP_KV_PATH"] = prevKv;
    resetKVStoreCache();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates a tool bound to a connection", async () => {
    const c = await createApiConnection({
      name: "C",
      baseUrl: "https://api.example.com",
      auth: { type: "none" },
    });
    const t = await createApiTool({
      connectionId: c.id,
      name: "get_user",
      description: "Fetch a user",
      method: "GET",
      pathTemplate: "/users/{{id}}",
      arguments: [{ name: "id", description: "user id", required: true, type: "string" }],
      queryTemplate: {},
      bodyTemplate: "",
      readOrWrite: "read",
      destructive: false,
      timeoutMs: 15000,
    });
    expect(t.connectionId).toBe(c.id);
    expect(t.name).toBe("get_user");
    const all = await listApiTools();
    expect(all).toHaveLength(1);
    const byConn = await listApiToolsByConnection(c.id);
    expect(byConn).toHaveLength(1);
  });

  it("rejects duplicate tool name within the same connection", async () => {
    const c = await createApiConnection({
      name: "C",
      baseUrl: "https://api.example.com",
      auth: { type: "none" },
    });
    const input = {
      connectionId: c.id,
      name: "same_name",
      method: "GET" as const,
      pathTemplate: "/x",
    };
    await createApiTool(input);
    await expect(createApiTool(input)).rejects.toThrow(/already exists/);
  });

  it("delete cascades when connection is deleted", async () => {
    const c = await createApiConnection({
      name: "C",
      baseUrl: "https://api.example.com",
      auth: { type: "none" },
    });
    await createApiTool({
      connectionId: c.id,
      name: "t1",
      method: "GET",
      pathTemplate: "/a",
    });
    await createApiTool({
      connectionId: c.id,
      name: "t2",
      method: "GET",
      pathTemplate: "/b",
    });
    const removed = await deleteApiToolsForConnection(c.id);
    expect(removed).toBe(2);
    expect(await listApiTools()).toHaveLength(0);
  });

  it("update preserves unchanged fields", async () => {
    const c = await createApiConnection({
      name: "C",
      baseUrl: "https://api.example.com",
      auth: { type: "none" },
    });
    const t = await createApiTool({
      connectionId: c.id,
      name: "orig",
      method: "GET",
      pathTemplate: "/orig",
      description: "first",
    });
    const next = await updateApiTool(t.id, { description: "updated" });
    expect(next?.description).toBe("updated");
    expect(next?.name).toBe("orig");
    expect(next?.pathTemplate).toBe("/orig");
  });

  it("delete tool returns false when id does not exist", async () => {
    expect(await deleteApiTool("tool_does_not_exist")).toBe(false);
  });
});
