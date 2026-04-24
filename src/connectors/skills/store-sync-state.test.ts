import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeSkillContentHash, createSkill, recordSkillSyncState, getSkill } from "./store";

describe("computeSkillContentHash", () => {
  it("produces a stable sha256 over name + description + content", () => {
    const h = computeSkillContentHash({
      name: "A",
      description: "desc",
      content: "body",
    });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    const h2 = computeSkillContentHash({
      name: "A",
      description: "desc",
      content: "body",
    });
    expect(h2).toBe(h);
  });

  it("differs when content differs", () => {
    const a = computeSkillContentHash({ name: "A", description: "", content: "x" });
    const b = computeSkillContentHash({ name: "A", description: "", content: "y" });
    expect(a).not.toBe(b);
  });

  it("collision-resistant between name and description boundary", () => {
    // Without the 0x1f separator, these two inputs would hash identically.
    const a = computeSkillContentHash({ name: "foo", description: "barbaz", content: "" });
    const b = computeSkillContentHash({ name: "foobar", description: "baz", content: "" });
    expect(a).not.toBe(b);
  });
});

describe("recordSkillSyncState", () => {
  let tmp: string;
  const originalSkillsPath = process.env["MYMCP_SKILLS_PATH"];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-skills-store-"));
    process.env["MYMCP_SKILLS_PATH"] = path.join(tmp, "skills.json");
  });

  afterEach(async () => {
    if (originalSkillsPath === undefined) delete process.env["MYMCP_SKILLS_PATH"];
    else process.env["MYMCP_SKILLS_PATH"] = originalSkillsPath;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("persists sync state onto a skill", async () => {
    const skill = await createSkill({
      name: "Alpha",
      description: "a",
      content: "body",
      arguments: [],
      toolsAllowed: [],
      source: { type: "inline" },
    });

    const updated = await recordSkillSyncState(skill.id, {
      target: "claude-code",
      lastSyncedHash: "abc123",
      lastSyncedAt: "2026-04-24T01:00:00.000Z",
      lastSyncStatus: "ok",
    });

    expect(updated).not.toBeNull();
    expect(updated!.syncState["claude-code"]).toEqual({
      target: "claude-code",
      lastSyncedHash: "abc123",
      lastSyncedAt: "2026-04-24T01:00:00.000Z",
      lastSyncStatus: "ok",
    });

    const reread = await getSkill(skill.id);
    expect(reread?.syncState["claude-code"]?.lastSyncedHash).toBe("abc123");
  });

  it("preserves other-target state when updating one target", async () => {
    const skill = await createSkill({
      name: "Beta",
      description: "",
      content: "body",
      arguments: [],
      toolsAllowed: [],
      source: { type: "inline" },
    });
    await recordSkillSyncState(skill.id, {
      target: "first",
      lastSyncedHash: "hash-1",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      lastSyncStatus: "ok",
    });
    const updated = await recordSkillSyncState(skill.id, {
      target: "second",
      lastSyncedHash: "hash-2",
      lastSyncedAt: "2026-01-02T00:00:00.000Z",
      lastSyncStatus: "ok",
    });

    expect(Object.keys(updated!.syncState).sort()).toEqual(["first", "second"]);
    expect(updated!.syncState["first"]?.lastSyncedHash).toBe("hash-1");
    expect(updated!.syncState["second"]?.lastSyncedHash).toBe("hash-2");
  });

  it("returns null when skill does not exist", async () => {
    const result = await recordSkillSyncState("nonexistent", {
      target: "t",
      lastSyncedHash: "h",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      lastSyncStatus: "ok",
    });
    expect(result).toBeNull();
  });
});
