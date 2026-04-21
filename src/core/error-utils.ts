/**
 * Phase 49 / TYPE-02 — error-message unwrapping helper.
 *
 * Canonical replacement for the 63 `err instanceof Error ? err.message :
 * String(err)` ternary callsites across `src/` + `app/` (pre-codemod).
 *
 * Semantics match the legacy ternary EXACTLY:
 *   - `Error` instance (incl. subclasses) → returns `.message`
 *   - anything else → routed through `String()`, which for objects
 *     yields `"[object Object]"` (unless a custom `toString()` is
 *     defined), for `null` yields `"null"`, for `undefined` yields
 *     `"undefined"`, for primitives (number/string/boolean/symbol)
 *     yields their string representation.
 *
 * The TYPE-04 contract test (`tests/contract/no-err-ternary.test.ts`)
 * prevents the ternary pattern from reappearing under `src/` + `app/`;
 * test files are grandfathered.
 *
 * Why `toMsg` and not `toMessage` (roadmap D-03): shorter, matches the
 * existing `msg` variable naming convention across the codebase.
 */
export function toMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
