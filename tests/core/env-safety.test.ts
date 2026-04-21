/**
 * SAFE-01 + SAFE-04 regression tests.
 *
 * Closes .planning/milestones/v0.10-durability-ROADMAP.md Phase 38 requirements:
 * - SAFE-01: typed destructive env-var registry
 * - SAFE-04: startup validation refuses to boot in prod on reject-severity misconfig
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("env-safety (SAFE-01)", () => {
  const saved: Record<string, string | undefined> = {};
  const keysToSnapshot = [
    "NODE_ENV",
    "MYMCP_RECOVERY_RESET",
    "MYMCP_ALLOW_EPHEMERAL_SECRET",
    "MYMCP_DEBUG_LOG_SECRETS",
    "MYMCP_RATE_LIMIT_INMEMORY",
    "MYMCP_SKIP_TOOL_TOGGLE_CHECK",
  ];

  beforeEach(() => {
    for (const k of keysToSnapshot) saved[k] = process.env[k];
    for (const k of keysToSnapshot) delete process.env[k];
  });

  afterEach(() => {
    for (const k of keysToSnapshot) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("DESTRUCTIVE_ENV_VARS has the 5 documented entries", async () => {
    const { DESTRUCTIVE_ENV_VARS } = await import("@/core/env-safety");
    const names = DESTRUCTIVE_ENV_VARS.map((v) => v.name).sort();
    expect(names).toEqual(
      [
        "MYMCP_ALLOW_EPHEMERAL_SECRET",
        "MYMCP_DEBUG_LOG_SECRETS",
        "MYMCP_RATE_LIMIT_INMEMORY",
        "MYMCP_RECOVERY_RESET",
        "MYMCP_SKIP_TOOL_TOGGLE_CHECK",
      ].sort()
    );
    // Every entry has the required shape
    for (const v of DESTRUCTIVE_ENV_VARS) {
      expect(typeof v.name).toBe("string");
      expect(v.name.length).toBeGreaterThan(0);
      expect(typeof v.effect).toBe("string");
      expect(v.effect.length).toBeGreaterThan(30);
      expect(Array.isArray(v.allowedEnvs)).toBe(true);
      expect(["warn", "reject"]).toContain(v.severity);
    }
  });

  it("getActiveDestructiveVars returns [] when no destructive vars are set", async () => {
    const { getActiveDestructiveVars } = await import("@/core/env-safety");
    expect(getActiveDestructiveVars()).toEqual([]);
  });

  it("getActiveDestructiveVars returns one entry per active var with value hidden", async () => {
    process.env.MYMCP_RECOVERY_RESET = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { getActiveDestructiveVars } = await import("@/core/env-safety");
    const active = getActiveDestructiveVars();
    expect(active.length).toBe(1);
    expect(active[0].var.name).toBe("MYMCP_RECOVERY_RESET");
    expect(active[0].value).toBe("<set>");
    expect(active[0].allowed).toBe(false);
  });

  it("allowed === true when NODE_ENV is in allowedEnvs", async () => {
    process.env.MYMCP_RECOVERY_RESET = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    const { getActiveDestructiveVars } = await import("@/core/env-safety");
    const active = getActiveDestructiveVars();
    expect(active.length).toBe(1);
    expect(active[0].allowed).toBe(true);
  });

  it("ignores '0', 'false', '' as active values", async () => {
    const { getActiveDestructiveVars } = await import("@/core/env-safety");
    process.env.MYMCP_RECOVERY_RESET = "0";
    expect(getActiveDestructiveVars()).toEqual([]);
    process.env.MYMCP_RECOVERY_RESET = "false";
    expect(getActiveDestructiveVars()).toEqual([]);
    process.env.MYMCP_RECOVERY_RESET = "";
    expect(getActiveDestructiveVars()).toEqual([]);
  });

  it("getEnvPresence returns only booleans — no env values leak", async () => {
    process.env.MCP_AUTH_TOKEN = "super-secret-value";
    const { getEnvPresence } = await import("@/core/env-safety");
    const presence = getEnvPresence();
    expect(presence.MCP_AUTH_TOKEN).toBe(true);
    // Ensure no value in the map equals the secret or a substring of it
    for (const [, v] of Object.entries(presence)) {
      expect(typeof v).toBe("boolean");
    }
    const serialized = JSON.stringify(presence);
    expect(serialized).not.toContain("super-secret-value");
  });
});

describe("validateDestructiveVarsAtStartup (SAFE-04)", () => {
  const saved: Record<string, string | undefined> = {};
  const keysToSnapshot = [
    "NODE_ENV",
    "MYMCP_RECOVERY_RESET",
    "MYMCP_DEBUG_LOG_SECRETS",
    "MYMCP_SKIP_TOOL_TOGGLE_CHECK",
  ];

  beforeEach(() => {
    for (const k of keysToSnapshot) saved[k] = process.env[k];
    for (const k of keysToSnapshot) delete process.env[k];
  });

  afterEach(() => {
    for (const k of keysToSnapshot) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("clean state → no warnings, no rejections", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { validateDestructiveVarsAtStartup } = await import("@/core/env-safety");
    const { warnings, rejections } = validateDestructiveVarsAtStartup();
    expect(warnings).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it("MYMCP_RECOVERY_RESET=1 in production → warning", async () => {
    process.env.MYMCP_RECOVERY_RESET = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { validateDestructiveVarsAtStartup } = await import("@/core/env-safety");
    const { warnings, rejections } = validateDestructiveVarsAtStartup();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("MYMCP_RECOVERY_RESET");
    expect(warnings[0]).toContain("NODE_ENV=production");
    expect(rejections).toEqual([]);
  });

  it("MYMCP_DEBUG_LOG_SECRETS=1 in production → rejection (severity=reject)", async () => {
    process.env.MYMCP_DEBUG_LOG_SECRETS = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { validateDestructiveVarsAtStartup } = await import("@/core/env-safety");
    const { warnings, rejections } = validateDestructiveVarsAtStartup();
    expect(rejections.length).toBe(1);
    expect(rejections[0]).toContain("MYMCP_DEBUG_LOG_SECRETS");
    expect(warnings).toEqual([]);
  });

  it("MYMCP_RECOVERY_RESET=1 in development → no warning (allowed)", async () => {
    process.env.MYMCP_RECOVERY_RESET = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    const { validateDestructiveVarsAtStartup } = await import("@/core/env-safety");
    const { warnings, rejections } = validateDestructiveVarsAtStartup();
    expect(warnings).toEqual([]);
    expect(rejections).toEqual([]);
  });
});

describe("runStartupValidation boot hook (SAFE-04)", () => {
  const saved: Record<string, string | undefined> = {};
  const keysToSnapshot = ["NODE_ENV", "MYMCP_RECOVERY_RESET", "MYMCP_DEBUG_LOG_SECRETS"];

  beforeEach(() => {
    for (const k of keysToSnapshot) saved[k] = process.env[k];
    for (const k of keysToSnapshot) delete process.env[k];
  });

  afterEach(() => {
    for (const k of keysToSnapshot) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    vi.restoreAllMocks();
  });

  it("runs once — subsequent calls are no-op", async () => {
    const { runStartupValidation, __resetStartupValidationForTests } =
      await import("@/core/config");
    __resetStartupValidationForTests();
    process.env.MYMCP_RECOVERY_RESET = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runStartupValidation();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second call — idempotent
    runStartupValidation();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("clean state → does not exit or log errors", async () => {
    const { runStartupValidation, __resetStartupValidationForTests } =
      await import("@/core/config");
    __resetStartupValidationForTests();
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);
    runStartupValidation();
    expect(errSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
