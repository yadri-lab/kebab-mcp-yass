/**
 * Tests for `extractTokenFromInput` — the paste-token / paste-URL
 * helper that feeds the Already-Initialized panel on /welcome.
 *
 * Phase 45 Task 1 (UX-02a): extracted from the module-scope closure
 * in `app/welcome/welcome-client.tsx:2083` to `src/core/welcome-url-parser.ts`
 * so tests can import it directly instead of maintaining a parallel
 * re-implementation inside `tests/regression/welcome-flow.test.ts`.
 *
 * Contract (from the original JSDoc at the extraction site):
 *   Accept either the bare token OR the full MCP URL that the welcome
 *   Connect step hands out (`https://…/api/mcp?token=…`). Users save
 *   whichever is most convenient and shouldn't have to remember which
 *   form the field wants.
 */
import { describe, it, expect } from "vitest";
import { extractTokenFromInput } from "@/core/welcome-url-parser";

describe("extractTokenFromInput", () => {
  it("passes bare token through unchanged", () => {
    const bare = "ej1fZhGP7cthQmfTuSAjhNe4e6uIo0y-MQfNnie-7Ss";
    expect(extractTokenFromInput(bare)).toBe(bare);
  });

  it("extracts ?token= from a full MCP URL", () => {
    const token = "abc123_TOKEN-with.safe~chars";
    const url = `https://example.vercel.app/api/mcp?token=${token}`;
    expect(extractTokenFromInput(url)).toBe(token);
  });

  it("trims whitespace on both sides of a bare token", () => {
    const bare = "abc-token";
    expect(extractTokenFromInput(`  ${bare}  `)).toBe(bare);
    expect(extractTokenFromInput(`\t${bare}\n`)).toBe(bare);
  });

  it("returns empty string for empty / whitespace-only input (no throw)", () => {
    expect(extractTokenFromInput("")).toBe("");
    expect(extractTokenFromInput("   ")).toBe("");
    expect(extractTokenFromInput("\n\t")).toBe("");
  });

  it("returns the literal input when a URL lacks ?token=", () => {
    // Current contract: fall through to the literal input. The UI
    // renders an amber "no ?token= parameter found" hint based on a
    // separate heuristic (`inputLooksLikeUrl && !extracted`, where
    // "extracted" means the post-extraction value differs from the
    // input). Returning the literal keeps this helper behavior-stable;
    // the UI decision belongs in the component.
    const noTokenUrl = "https://example.com/welcome";
    expect(extractTokenFromInput(noTokenUrl)).toBe(noTokenUrl);
  });

  it("returns the literal input when the URL is malformed (no throw)", () => {
    // `new URL("http://")` throws under Node; the catch block should
    // fall through and return the original trimmed string. Tests the
    // robustness of the error path.
    const garbage = "http://";
    expect(extractTokenFromInput(garbage)).toBe(garbage);
  });

  it("preserves URL-encoded tokens (caller is responsible for decoding)", () => {
    // `searchParams.get()` already decodes percent-encoding once. A
    // token that was originally `abc%20def` would arrive on the server
    // as `abc def`. Assert the value we hand back matches what
    // `searchParams.get("token")` would produce — i.e. the DECODED form.
    const url = "https://example.com/api/mcp?token=foo%2Bbar";
    expect(extractTokenFromInput(url)).toBe("foo+bar");
  });

  it("prefers ?token= over #token= when both are present", () => {
    // Matches the current behavior at welcome-client.tsx:2083 — the
    // helper only reads `searchParams.get("token")`. A fragment
    // `#token=X` is never examined, so the query-param value wins.
    const token = "queryParamWinner";
    const url = `https://example.com/api/mcp?token=${token}#token=fragmentLoser`;
    expect(extractTokenFromInput(url)).toBe(token);
  });
});
