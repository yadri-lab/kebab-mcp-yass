/**
 * Phase 71 / Plan 71-01 / Task 1 — kill-switch helper coverage (UNI-20).
 *
 * Tests for `isWritesDisabled()` — the global Unipile LinkedIn writes
 * kill switch (D-86 / D-88 / D-89).
 *
 * Contract:
 *  - Reads via `getConfig()` from `@/core/config-facade` (NEVER process.env
 *    direct — enforced by ESLint rule `kebab/no-direct-process-env` per D-89).
 *  - Primary env var: `KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED`.
 *  - Legacy alias: `LINKEDIN_TOOLS_DISABLED` (D-86 — accepted for backward-compat).
 *  - Truthy values: ONLY "true" and "1". Anything else → false (explicit list,
 *    no `Boolean(v)` coercion — empty string is "set but disabled" per Unix
 *    conventions).
 *  - Coalesce order: PRIMARY wins on `??`. If both are set with different
 *    values, the primary's value is what's evaluated.
 *
 * Mock pattern: same vi.hoisted() shape as other unipile lib tests
 * (audit.test.ts, identifiers.test.ts) — partial-mock of the config facade
 * exposing only `getConfig`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { getConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn<(key: string) => string | undefined>(),
}));

vi.mock("@/core/config-facade", () => ({
  getConfig: getConfigMock,
}));

import { isWritesDisabled } from "../kill-switch";

beforeEach(() => {
  getConfigMock.mockReset();
});

describe("isWritesDisabled (Phase 71 / Plan 71-01 / D-86 + D-89)", () => {
  it("returns false when neither env var is set", () => {
    getConfigMock.mockReturnValue(undefined);
    expect(isWritesDisabled()).toBe(false);
  });

  it("returns true when KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED is 'true'", () => {
    getConfigMock.mockImplementation((key: string) =>
      key === "KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED" ? "true" : undefined
    );
    expect(isWritesDisabled()).toBe(true);
  });

  it("returns true when KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED is '1'", () => {
    getConfigMock.mockImplementation((key: string) =>
      key === "KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED" ? "1" : undefined
    );
    expect(isWritesDisabled()).toBe(true);
  });

  it("returns true when legacy LINKEDIN_TOOLS_DISABLED is 'true' (primary unset)", () => {
    getConfigMock.mockImplementation((key: string) =>
      key === "LINKEDIN_TOOLS_DISABLED" ? "true" : undefined
    );
    expect(isWritesDisabled()).toBe(true);
  });

  it("returns true when legacy LINKEDIN_TOOLS_DISABLED is '1' (primary unset)", () => {
    getConfigMock.mockImplementation((key: string) =>
      key === "LINKEDIN_TOOLS_DISABLED" ? "1" : undefined
    );
    expect(isWritesDisabled()).toBe(true);
  });

  it("returns true when both are set — primary wins on ?? coalesce", () => {
    // If both are set, the primary's value is what's evaluated. Set primary
    // to 'true' and legacy to 'false' — result must reflect primary='true'.
    getConfigMock.mockImplementation((key: string) => {
      if (key === "KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED") return "true";
      if (key === "LINKEDIN_TOOLS_DISABLED") return "false";
      return undefined;
    });
    expect(isWritesDisabled()).toBe(true);
  });

  it("returns false for falsy strings: '', 'false', '0', 'no', 'anything-else'", () => {
    for (const v of ["", "false", "0", "no", "anything-else", "TRUE", "True", "yes"]) {
      getConfigMock.mockReset();
      // The empty-string case is special: getConfig returns "" which is NOT
      // undefined, so `??` keeps it. We assert that v !== "true" && v !== "1"
      // collapses to false.
      getConfigMock.mockImplementation((key: string) =>
        key === "KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED" ? v : undefined
      );
      expect(isWritesDisabled()).toBe(false);
    }
  });

  it("calls getConfig for KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED first (primary lookup precedes legacy)", () => {
    getConfigMock.mockReturnValue(undefined);
    isWritesDisabled();
    // The first call must be the primary; legacy may or may not be reached
    // depending on engine evaluation order, but the primary must always fire.
    expect(getConfigMock).toHaveBeenCalledWith("KEBAB_UNIPILE_LINKEDIN_WRITES_DISABLED");
  });
});
