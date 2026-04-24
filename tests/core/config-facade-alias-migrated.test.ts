/**
 * Verifies that the config-facade resolveAlias logic correctly handles:
 *   1. KEBAB_* keys are honoured directly.
 *   2. The legacy MYMCP_* fallback still works (for existing deployments).
 *   3. KEBAB_* takes priority when both are set.
 *
 * This test locks the alias behaviour introduced in Phase 50 (BRAND-01)
 * and ensures it survives future refactors of config-facade.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getConfig } from "@/core/config-facade";

const TEST_KEY = "KEBAB_TOOL_TIMEOUT";
const LEGACY_KEY = "MYMCP_TOOL_TIMEOUT";

afterEach(() => {
  delete process.env[TEST_KEY];
  delete process.env[LEGACY_KEY];
});

describe("config-facade KEBAB_* / MYMCP_* alias", () => {
  it("reads a KEBAB_TOOL_TIMEOUT env var directly", () => {
    process.env[TEST_KEY] = "9999";
    expect(getConfig(TEST_KEY)).toBe("9999");
  });

  it("falls back to MYMCP_TOOL_TIMEOUT when only legacy key is set", () => {
    delete process.env[TEST_KEY];
    process.env[LEGACY_KEY] = "7777";
    expect(getConfig(TEST_KEY)).toBe("7777");
  });

  it("KEBAB_* takes priority over MYMCP_* when both are set", () => {
    process.env[TEST_KEY] = "primary";
    process.env[LEGACY_KEY] = "legacy";
    expect(getConfig(TEST_KEY)).toBe("primary");
  });

  it("reads KEBAB_WEBHOOKS directly", () => {
    process.env["KEBAB_WEBHOOKS"] = "stripe,github";
    expect(getConfig("KEBAB_WEBHOOKS")).toBe("stripe,github");
    delete process.env["KEBAB_WEBHOOKS"];
  });

  it("falls back KEBAB_WEBHOOKS to MYMCP_WEBHOOKS", () => {
    delete process.env["KEBAB_WEBHOOKS"];
    process.env["MYMCP_WEBHOOKS"] = "legacy-stripe";
    expect(getConfig("KEBAB_WEBHOOKS")).toBe("legacy-stripe");
    delete process.env["MYMCP_WEBHOOKS"];
  });

  it("reads KEBAB_DURABLE_LOGS directly", () => {
    process.env["KEBAB_DURABLE_LOGS"] = "true";
    expect(getConfig("KEBAB_DURABLE_LOGS")).toBe("true");
    delete process.env["KEBAB_DURABLE_LOGS"];
  });

  it("falls back KEBAB_DURABLE_LOGS to MYMCP_DURABLE_LOGS", () => {
    delete process.env["KEBAB_DURABLE_LOGS"];
    process.env["MYMCP_DURABLE_LOGS"] = "false";
    expect(getConfig("KEBAB_DURABLE_LOGS")).toBe("false");
    delete process.env["MYMCP_DURABLE_LOGS"];
  });
});
