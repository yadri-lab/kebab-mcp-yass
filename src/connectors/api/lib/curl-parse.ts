/**
 * curl-parse — naive but practical cURL command parser.
 *
 * Scope: POST /api/config/api-tools/parse-curl. Accepts the kind of cURL
 * strings copy-pasted from Postman / Chrome DevTools / API docs, and
 * returns a draft payload the Tool builder UI can fill its form from.
 *
 * Covered flags: -X/--request, -H/--header, -d/--data / --data-raw /
 *   --data-binary, -u/--user. Unknown flags are silently ignored.
 * Escapes: single-quote, double-quote, backslash-space continuations.
 * Out of scope: multipart forms, cookies, --form, --compressed (stripped).
 */

export interface ParsedCurl {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body: string;
  basicAuth: { username: string; password: string } | null;
}

class CurlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurlParseError";
  }
}

/** Tokenize a shell-ish command line into an argv. */
export function tokenizeCurl(input: string): string[] {
  // Strip line-continuations "\ \n" → " "
  const joined = input.replace(/\\\r?\n/g, " ").trim();
  const out: string[] = [];
  let i = 0;
  const n = joined.length;
  while (i < n) {
    // Skip whitespace
    while (i < n && /\s/.test(joined[i]!)) i++;
    if (i >= n) break;
    let token = "";
    while (i < n && !/\s/.test(joined[i]!)) {
      const ch = joined[i]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < n && joined[i] !== quote) {
          if (joined[i] === "\\" && i + 1 < n && quote === '"') {
            token += joined[i + 1];
            i += 2;
          } else {
            token += joined[i];
            i++;
          }
        }
        if (joined[i] === quote) i++;
      } else if (ch === "\\" && i + 1 < n) {
        token += joined[i + 1];
        i += 2;
      } else {
        token += ch;
        i++;
      }
    }
    out.push(token);
  }
  return out;
}

function isUrlish(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function parseCurl(input: string): ParsedCurl {
  const tokens = tokenizeCurl(input);
  if (tokens.length === 0) {
    throw new CurlParseError("Empty cURL command");
  }
  // Skip leading "curl".
  let i = 0;
  if (tokens[i]?.toLowerCase() === "curl") i++;

  let method: ParsedCurl["method"] | null = null;
  let url: string | null = null;
  const headers: Record<string, string> = {};
  let body = "";
  let basicAuth: ParsedCurl["basicAuth"] = null;

  while (i < tokens.length) {
    const t = tokens[i]!;
    // Long form --key=value → split
    if (t.startsWith("--") && t.includes("=")) {
      const eqIdx = t.indexOf("=");
      const key = t.slice(0, eqIdx);
      const val = t.slice(eqIdx + 1);
      tokens.splice(i, 1, key, val);
      continue;
    }
    if (t === "-X" || t === "--request") {
      const v = tokens[++i];
      if (v) {
        const upper = v.toUpperCase();
        if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(upper)) {
          method = upper as ParsedCurl["method"];
        }
      }
      i++;
      continue;
    }
    if (t === "-H" || t === "--header") {
      const v = tokens[++i];
      if (v) {
        const colon = v.indexOf(":");
        if (colon > 0) {
          const name = v.slice(0, colon).trim();
          const value = v.slice(colon + 1).trim();
          if (name) headers[name] = value;
        }
      }
      i++;
      continue;
    }
    if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      const v = tokens[++i];
      if (v !== undefined) {
        body = body ? `${body}&${v}` : v;
      }
      i++;
      continue;
    }
    if (t === "-u" || t === "--user") {
      const v = tokens[++i];
      if (v) {
        const sep = v.indexOf(":");
        if (sep > 0) {
          basicAuth = { username: v.slice(0, sep), password: v.slice(sep + 1) };
        } else {
          basicAuth = { username: v, password: "" };
        }
      }
      i++;
      continue;
    }
    // Flags we ignore silently.
    if (
      t === "--compressed" ||
      t === "-L" ||
      t === "--location" ||
      t === "-s" ||
      t === "--silent" ||
      t === "-v" ||
      t === "--verbose" ||
      t === "-k" ||
      t === "--insecure"
    ) {
      i++;
      continue;
    }
    // Unknown flag with a value → skip value too.
    if (t.startsWith("-") && !isUrlish(t)) {
      i++;
      if (tokens[i] && !tokens[i]!.startsWith("-") && !isUrlish(tokens[i]!)) {
        i++;
      }
      continue;
    }
    // Otherwise: URL or positional arg.
    if (!url && isUrlish(t)) {
      url = t;
    } else if (!url) {
      url = t;
    }
    i++;
  }

  if (!url) {
    throw new CurlParseError("No URL found in cURL command");
  }

  return {
    method: method ?? (body ? "POST" : "GET"),
    url,
    headers,
    body,
    basicAuth,
  };
}

/**
 * Convert a ParsedCurl into a draft tool payload the Tool builder UI
 * can pre-fill. The draft's `connectionId` is left empty — the UI wizard
 * binds it at step 1.
 */
export interface ToolDraftFromCurl {
  baseUrl: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  queryTemplate: Record<string, string>;
  bodyTemplate: string;
  headers: Record<string, string>;
  suggestedAuth:
    | { type: "none" }
    | { type: "bearer"; token: string }
    | { type: "basic"; username: string; password: string };
}

export function curlToDraft(parsed: ParsedCurl): ToolDraftFromCurl {
  const url = new URL(parsed.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const pathTemplate = url.pathname;
  const queryTemplate: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    queryTemplate[k] = v;
  }

  // Extract Authorization → bearer suggestion.
  const headersOut: Record<string, string> = {};
  let suggestedAuth: ToolDraftFromCurl["suggestedAuth"] = { type: "none" };
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (k.toLowerCase() === "authorization" && v.toLowerCase().startsWith("bearer ")) {
      suggestedAuth = { type: "bearer", token: v.slice(7).trim() };
      continue;
    }
    headersOut[k] = v;
  }
  if (parsed.basicAuth) {
    suggestedAuth = {
      type: "basic",
      username: parsed.basicAuth.username,
      password: parsed.basicAuth.password,
    };
  }

  return {
    baseUrl,
    method: parsed.method,
    pathTemplate,
    queryTemplate,
    bodyTemplate: parsed.body,
    headers: headersOut,
    suggestedAuth,
  };
}
