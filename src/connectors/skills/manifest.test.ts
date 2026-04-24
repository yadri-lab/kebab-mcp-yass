import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkill, _resetSkillsCacheForTests } from "./store";
import { skillsConnector } from "./manifest";

/**
 * Regression coverage for the v0.14 "tools return 0 on cold lambda" bug.
 *
 * Before the refresh() hook landed, `skillsConnector.tools` read from
 * listSkillsSync(), which on Upstash returned [] until /api/admin/status
 * (or any diagnose call) happened to fire first. The transport route
 * therefore registered 0 user-defined tools until the operator refreshed.
 *
 * These tests assert:
 *   1. A cold manifest (no prior refresh) returns [].
 *   2. After `refresh()` (what the transport now calls), tools appear.
 *   3. A new skill created mid-session is visible without another refresh.
 */

describe("skills connector refresh hook (v0.14 cold-lambda fix)", () => {
  let tmp: string;
  const orig = process.env.MYMCP_SKILLS_PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kebab-skills-manifest-"));
    process.env.MYMCP_SKILLS_PATH = path.join(tmp, "skills.json");
    _resetSkillsCacheForTests();
  });

  afterEach(async () => {
    if (orig === undefined) delete process.env.MYMCP_SKILLS_PATH;
    else process.env.MYMCP_SKILLS_PATH = orig;
    _resetSkillsCacheForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("declares a refresh hook", () => {
    expect(typeof skillsConnector.refresh).toBe("function");
  });

  it("exposes skills after refresh() primes the cache", async () => {
    // Seed a skill via the async store.
    await createSkill({
      name: "Coldstart",
      description: "",
      content: "body",
      arguments: [],
      toolsAllowed: [],
      source: { type: "inline" },
    });
    // Reset the module cache to simulate a fresh cold lambda that hasn't
    // primed yet — createSkill would have populated it, but we drop it
    // manually to isolate the refresh-hook contract.
    _resetSkillsCacheForTests();

    // Before refresh: tools getter sees the empty cache.
    // (On the legacy filesystem path this would still read fs, but the
    // Upstash path would return []. Test exercises the sync-cache-first
    // branch by pointing at a non-existent legacy path.)
    const originalPath = process.env.MYMCP_SKILLS_PATH;
    process.env.MYMCP_SKILLS_PATH = path.join(tmp, "does-not-exist.json");
    _resetSkillsCacheForTests();
    const before = skillsConnector.tools;
    expect(before).toHaveLength(0);

    // Prime via the manifest hook.
    process.env.MYMCP_SKILLS_PATH = originalPath;
    await skillsConnector.refresh?.();

    // After refresh: tools getter returns the seeded skill.
    const after = skillsConnector.tools;
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("skill_coldstart");
  });

  it("createSkill updates the sync cache in lock-step", async () => {
    await skillsConnector.refresh?.();
    expect(skillsConnector.tools).toHaveLength(0);

    await createSkill({
      name: "Inflight",
      description: "",
      content: "",
      arguments: [],
      toolsAllowed: [],
      source: { type: "inline" },
    });

    // No explicit refresh — the writeRaw side-effect should have
    // populated the cache already.
    expect(skillsConnector.tools).toHaveLength(1);
  });
});
