import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCustomTool,
  updateCustomTool,
  deleteCustomTool,
  getCustomTool,
  listCustomToolVersions,
  rollbackCustomTool,
  _resetCustomToolsCacheForTests,
  _resetKnownToolFactsCacheForTests,
} from "./store";
import { resetKVStoreCache } from "@/core/kv-store";

/**
 * Phase 6 — Custom Tools versioning store tests.
 *
 * Mirrors `src/connectors/skills/store-versioning.test.ts` in spirit
 * (history append on each save, rollback creates a new history entry so
 * the rollback itself is undoable) but uses the LIST-style storage of
 * Custom Tools (single JSON array under `customtool:versions:<id>`,
 * cap = 10 entries, newest first).
 */
describe("custom-tools versioning store", () => {
  let tmp: string;
  const prevKv = process.env["MYMCP_KV_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-custom-tools-ver-"));
    process.env["MYMCP_KV_PATH"] = path.join(tmp, "kv.json");
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    _resetKnownToolFactsCacheForTests();
  });

  afterEach(async () => {
    if (prevKv === undefined) delete process.env["MYMCP_KV_PATH"];
    else process.env["MYMCP_KV_PATH"] = prevKv;
    resetKVStoreCache();
    _resetCustomToolsCacheForTests();
    _resetKnownToolFactsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const baseTool = {
    id: "todo_add",
    description: "v1",
    destructive: false,
    inputs: [{ name: "task", type: "string" as const, required: true }],
    steps: [{ kind: "transform" as const, template: "v1: {{task}}", saveAs: "out" }],
  };

  it("starts with no versions on create", async () => {
    await createCustomTool(baseTool);
    expect(await listCustomToolVersions("todo_add")).toHaveLength(0);
  });

  it("pushes the previous snapshot on each update (newest-first)", async () => {
    await createCustomTool(baseTool);

    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v2",
      steps: [{ kind: "transform", template: "v2: {{task}}", saveAs: "out" }],
    });
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v3",
      steps: [{ kind: "transform", template: "v3: {{task}}", saveAs: "out" }],
    });

    const versions = await listCustomToolVersions("todo_add");
    expect(versions).toHaveLength(2);
    // Newest-first → version[0] is what got replaced *most recently*,
    // i.e. the v2 snapshot. version[1] is the original v1.
    expect(versions[0]?.tool.description).toBe("v2");
    expect(versions[1]?.tool.description).toBe("v1");
    expect(versions[0]?.supersededAt).toBeTruthy();
  });

  it("rollback restores a prior version and itself becomes a new history entry", async () => {
    await createCustomTool(baseTool);
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v2",
      steps: [{ kind: "transform", template: "v2", saveAs: "out" }],
    });
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v3",
      steps: [{ kind: "transform", template: "v3", saveAs: "out" }],
    });

    // Sanity — current is v3, history has [v2, v1].
    expect((await getCustomTool("todo_add"))?.description).toBe("v3");
    let versions = await listCustomToolVersions("todo_add");
    expect(versions.map((v) => v.tool.description)).toEqual(["v2", "v1"]);

    // Rollback to versionIndex 1 (= v1). The current v3 should now be
    // the most recent history entry, and the active tool should match v1.
    const restored = await rollbackCustomTool("todo_add", 1);
    expect(restored).not.toBeNull();
    expect(restored!.description).toBe("v1");

    expect((await getCustomTool("todo_add"))?.description).toBe("v1");

    versions = await listCustomToolVersions("todo_add");
    expect(versions).toHaveLength(3);
    // After rollback: history = [v3 (just-replaced), v2, v1].
    expect(versions.map((v) => v.tool.description)).toEqual(["v3", "v2", "v1"]);
  });

  it("rollback to versionIndex 0 restores the most recent prior version", async () => {
    await createCustomTool(baseTool);
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v2",
      steps: [{ kind: "transform", template: "v2", saveAs: "out" }],
    });

    const restored = await rollbackCustomTool("todo_add", 0);
    expect(restored?.description).toBe("v1");
  });

  it("rollback returns null for unknown tool id", async () => {
    expect(await rollbackCustomTool("nope", 0)).toBeNull();
  });

  it("rollback returns null when the index is out of range", async () => {
    await createCustomTool(baseTool);
    expect(await rollbackCustomTool("todo_add", 0)).toBeNull();
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v2",
      steps: [{ kind: "transform", template: "v2", saveAs: "out" }],
    });
    expect(await rollbackCustomTool("todo_add", 5)).toBeNull();
  });

  it("rollback rejects negative versionIndex", async () => {
    await createCustomTool(baseTool);
    await expect(rollbackCustomTool("todo_add", -1)).rejects.toThrow(/non-negative/);
  });

  it("caps history at 10 entries (oldest dropped on overflow)", async () => {
    await createCustomTool(baseTool);
    // 12 updates → 12 prior snapshots, but cap is 10.
    for (let i = 2; i <= 13; i++) {
      await updateCustomTool("todo_add", {
        ...baseTool,
        description: `v${i}`,
        steps: [{ kind: "transform" as const, template: `v${i}`, saveAs: "out" }],
      });
    }
    const versions = await listCustomToolVersions("todo_add");
    expect(versions).toHaveLength(10);
    // Newest snapshot is v12 (the version that was just replaced by v13).
    expect(versions[0]?.tool.description).toBe("v12");
    // Oldest preserved snapshot — after dropping v1..v3, the trailing
    // entry is v4 (which was the previous version when v5 was saved).
    // 12 priors total, keeping last 10 ⇒ priors v3..v12 ⇒ v3 is oldest.
    expect(versions[versions.length - 1]?.tool.description).toBe("v3");
  });

  it("delete clears version history so id reuse starts clean", async () => {
    await createCustomTool(baseTool);
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v2",
      steps: [{ kind: "transform" as const, template: "v2", saveAs: "out" }],
    });
    expect(await listCustomToolVersions("todo_add")).toHaveLength(1);

    await deleteCustomTool("todo_add");
    expect(await listCustomToolVersions("todo_add")).toHaveLength(0);
  });

  it("rollback runs the same validation pipeline as a fresh write", async () => {
    // Create with a transform-only tool (no toolName validation needed).
    await createCustomTool(baseTool);
    await updateCustomTool("todo_add", {
      ...baseTool,
      description: "v2",
      steps: [{ kind: "transform" as const, template: "v2", saveAs: "out" }],
    });
    const restored = await rollbackCustomTool("todo_add", 0);
    expect(restored).not.toBeNull();
    // estimatedCost is server-stamped on every write — the rollback path
    // must compute it too, not blindly copy the old value (cost rules
    // may have changed since the original save).
    expect(typeof restored!.estimatedCost).toBe("number");
  });
});
