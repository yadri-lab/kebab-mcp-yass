/**
 * Welcome-flow paste-token / paste-URL parser.
 *
 * Extracted in Phase 45 Task 1 (UX-02a) from the module-scope closure
 * at `app/welcome/welcome-client.tsx:2083` so the helper is directly
 * testable (see `tests/core/welcome-url-parser.test.ts`) and imported
 * once from both the welcome UI (AlreadyInitializedPanel) and the
 * regression suite (tests/regression/welcome-flow.test.ts) — replacing
 * a parallel re-implementation that the Phase 40 audit filed as
 * FOLLOW-UP A.
 *
 * Contract:
 *   - Bare token → returned verbatim (whitespace trimmed).
 *   - `https://…?token=X` → returns `X` (URL-decoded, since
 *     `URLSearchParams.get()` decodes once).
 *   - URL without `?token=` → returns the literal trimmed input (the
 *     UI surfaces an amber "no token param found" hint via a separate
 *     heuristic).
 *   - Malformed URL → returns the literal trimmed input (catch block).
 *   - Empty / whitespace-only → returns empty string.
 *   - `?token=` wins over `#token=` fragment (historical behavior; the
 *     UI path handing out URLs only uses `?token=`).
 *
 * This helper is intentionally pure — no side effects, no logger, no
 * clipboard access. It is safe to call from SSR render paths and from
 * tests.
 */
export function extractTokenFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const t = parsed.searchParams.get("token")?.trim();
      if (t) return t;
    } catch {
      // Malformed URL — fall through and treat as a literal token.
      // Users sometimes paste partial URLs during a copy hiccup; a
      // throw would break the "Open dashboard" button without an
      // actionable error.
    }
  }
  return trimmed;
}
