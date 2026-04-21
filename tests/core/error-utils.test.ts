/**
 * Phase 49 / TYPE-02 — error-utils unit coverage.
 *
 * Validates that `toMsg(e)` has the same behavior as the legacy
 *   `err instanceof Error ? err.message : String(err)`
 * ternary pattern it replaces, across Error / string / number / null /
 * undefined / object / Symbol inputs.
 *
 * 63 production callsites were codemodded to `toMsg()` in Task 1; the
 * semantic equivalence with the pre-codemod ternary is tested here.
 */

import { describe, it, expect } from "vitest";
import { toMsg } from "@/core/error-utils";

describe("toMsg(e) — Phase 49 TYPE-02", () => {
  it("unwraps Error.message from a real Error instance", () => {
    expect(toMsg(new Error("boom"))).toBe("boom");
  });

  it("unwraps Error.message from subclasses", () => {
    class MyErr extends Error {
      constructor() {
        super("subclass-boom");
      }
    }
    expect(toMsg(new MyErr())).toBe("subclass-boom");
  });

  it("returns the string unchanged for a string input (matches String() on string)", () => {
    expect(toMsg("boom")).toBe("boom");
  });

  it("coerces number via String()", () => {
    expect(toMsg(42)).toBe("42");
  });

  it("returns 'undefined' for undefined (matches String(undefined))", () => {
    expect(toMsg(undefined)).toBe("undefined");
  });

  it("returns 'null' for null (matches String(null))", () => {
    expect(toMsg(null)).toBe("null");
  });

  it("returns '[object Object]' for a plain object with a message property (NOT the message — intentional divergence from a naive .message accessor)", () => {
    // Legacy ternary only unwrapped .message for `instanceof Error`;
    // plain objects went through String() and yielded "[object Object]".
    // This divergence from a naive `.message` accessor is intentional — see
    // roadmap TYPE-02 notes + test 5 in the plan's behavior spec.
    expect(toMsg({ message: "x" })).toBe("[object Object]");
  });

  it("does NOT throw for a Symbol input (String(Symbol) is defined; the Error-branch check is safe)", () => {
    expect(() => toMsg(Symbol("s"))).not.toThrow();
    expect(toMsg(Symbol("s"))).toBe("Symbol(s)");
  });

  it("handles an object with a custom toString()", () => {
    const obj = {
      toString() {
        return "custom-str";
      },
    };
    expect(toMsg(obj)).toBe("custom-str");
  });

  it("handles a boolean", () => {
    expect(toMsg(true)).toBe("true");
    expect(toMsg(false)).toBe("false");
  });

  it("preserves Error.message with special characters + newlines", () => {
    const e = new Error("line1\nline2 — unicode: ✓");
    expect(toMsg(e)).toBe("line1\nline2 — unicode: ✓");
  });

  it("preserves an empty Error message as empty string", () => {
    expect(toMsg(new Error(""))).toBe("");
  });
});
