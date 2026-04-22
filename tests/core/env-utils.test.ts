/**
 * Phase 49 / TYPE-03 — env-utils unit coverage.
 *
 * Validates `getRequiredEnv(key, connectorName)`:
 *   - returns the string value when the key is present
 *   - throws McpConfigError naming BOTH the env var and the connector
 *   - treats empty-string the same as missing (both throw)
 *   - surfaces `connector` + `key` via the thrown error's structured fields
 *
 * Integration with the config-facade: `getRequiredEnv` delegates to
 * `getConfig()` under the hood so request-context credential overrides
 * and the SEC-02 concurrency guarantee continue to apply.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRequiredEnv } from "@/core/env-utils";
import { McpConfigError } from "@/core/errors";

const TEST_KEY = "__TEST_PHASE49_ENV_UTILS__";

describe("getRequiredEnv(key, connectorName) — Phase 49 TYPE-03", () => {
  beforeEach(() => {
    delete process.env[TEST_KEY];
  });
  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  it("returns the value when the env var is present", () => {
    process.env[TEST_KEY] = "live-value";
    expect(getRequiredEnv(TEST_KEY, "testconnector")).toBe("live-value");
  });

  it("throws McpConfigError when the env var is missing", () => {
    expect(() => getRequiredEnv(TEST_KEY, "testconnector")).toThrow(McpConfigError);
  });

  it("throws McpConfigError when the env var is empty string", () => {
    process.env[TEST_KEY] = "";
    expect(() => getRequiredEnv(TEST_KEY, "testconnector")).toThrow(McpConfigError);
  });

  it("thrown error message names both the env var and the connector", () => {
    try {
      getRequiredEnv(TEST_KEY, "testconnector");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigError);
      const e = err as McpConfigError;
      expect(e.message).toContain(TEST_KEY);
      expect(e.message).toContain("testconnector");
    }
  });

  it("thrown error's `key` field equals the passed key", () => {
    try {
      getRequiredEnv(TEST_KEY, "testconnector");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigError);
      expect((err as McpConfigError).key).toBe(TEST_KEY);
    }
  });

  it("thrown error's `connector` field equals the passed connectorName", () => {
    try {
      getRequiredEnv(TEST_KEY, "browser");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigError);
      expect((err as McpConfigError).connector).toBe("browser");
    }
  });

  it("the thrown message is actionable (names where to set the var)", () => {
    try {
      getRequiredEnv(TEST_KEY, "testconnector");
      throw new Error("should not reach");
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      // Expected pattern mentions the dashboard or .env
      expect(msg).toMatch(/dashboard|\.env|set it/);
    }
  });

  it("handles whitespace-only values as present (not empty)", () => {
    // Whitespace is a valid (non-empty) value; getConfig only coerces
    // undefined + "" to missing. A whitespace value is unusual but
    // legitimate and must not throw — callers who care can trim later.
    process.env[TEST_KEY] = " ";
    expect(getRequiredEnv(TEST_KEY, "testconnector")).toBe(" ");
  });
});
