/**
 * Apify / Crawlee documentation search + fetch.
 *
 * Mirrors the `search-apify-docs` / `fetch-apify-docs` helper tools shipped
 * by the official `apify-mcp-server` repo, but consumes the same public
 * Algolia DocSearch indexes directly via REST so we don't need to add an
 * MCP-to-MCP dependency or pull in `algoliasearch` as a runtime dep.
 *
 * Auth: none — Algolia DocSearch credentials are public by design (the
 * exact same `appId`/`apiKey` pair powers the search box on docs.apify.com)
 * and `docs.apify.com` / `crawlee.dev` serve their pages publicly.
 *
 * Source of truth (kept in sync if Apify rotates the public DocSearch keys):
 *   https://github.com/apify/apify-mcp-server/blob/master/src/const.ts
 */

import { fetchWithTimeout } from "@/core/fetch-utils";
import { toMsg } from "@/core/error-utils";

const DOCS_FETCH_TIMEOUT_MS = 15_000;

export type DocSource = "apify" | "crawlee-js" | "crawlee-py";

interface DocSourceConfig {
  id: DocSource;
  label: string;
  appId: string;
  apiKey: string;
  indexName: string;
  filters?: string;
  facetFilters?: (string | string[])[];
  /** When set, restrict results to hits with matching `type` field. */
  typeFilter?: string;
}

export const DOCS_SOURCES: readonly DocSourceConfig[] = [
  {
    id: "apify",
    label: "Apify Platform",
    appId: "N8EOCSBQGH",
    apiKey: "e97714a64e2b4b8b8fe0b01cd8592870",
    indexName: "test_test_apify_sdk",
    filters: "version:latest",
  },
  {
    id: "crawlee-js",
    label: "Crawlee (JavaScript)",
    appId: "5JC94MPMLY",
    apiKey: "267679200b833c2ca1255ab276731869",
    indexName: "crawlee",
    typeFilter: "lvl1",
    facetFilters: ["language:en", ["docusaurus_tag:default", "docusaurus_tag:docs-default-3.15"]],
  },
  {
    id: "crawlee-py",
    label: "Crawlee (Python)",
    appId: "5JC94MPMLY",
    apiKey: "878493fcd7001e3c179b6db6796a999b",
    indexName: "crawlee_python",
    typeFilter: "lvl1",
    facetFilters: ["language:en", ["docusaurus_tag:docs-default-current"]],
  },
] as const;

export const ALLOWED_DOC_DOMAINS = ["https://docs.apify.com", "https://crawlee.dev"] as const;

/**
 * Origins are matched against the parsed URL's `origin`, not via a raw
 * `startsWith` on the URL string. The latter accepts attacker-crafted URLs
 * like `https://docs.apify.com.evil.com/` (the prefix match succeeds), which
 * the upstream Apify MCP server's check is also vulnerable to. We harden it
 * here.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>(ALLOWED_DOC_DOMAINS);

export interface DocSearchResult {
  url: string;
  content?: string;
}

interface AlgoliaHit {
  url_without_anchor?: string;
  anchor?: string;
  content?: string | null;
}

interface AlgoliaResponse {
  results?: { hits?: AlgoliaHit[] }[];
}

function findSource(id: string): DocSourceConfig {
  const cfg = DOCS_SOURCES.find((s) => s.id === id);
  if (!cfg)
    throw new Error(
      `Unknown doc source "${id}". Use one of: ${DOCS_SOURCES.map((s) => s.id).join(", ")}`
    );
  return cfg;
}

/**
 * Build the Algolia search request body. Combines `filters` and an optional
 * `type:<value>` predicate the same way the upstream MCP server does.
 */
function buildAlgoliaRequest(cfg: DocSourceConfig, query: string): Record<string, unknown> {
  const filters: string[] = [];
  if (cfg.filters) filters.push(cfg.filters);
  if (cfg.typeFilter) filters.push(`type:${cfg.typeFilter}`);

  const body: Record<string, unknown> = {
    indexName: cfg.indexName,
    query: query.trim(),
  };
  if (filters.length > 0) body.filters = filters.join(" AND ");
  if (cfg.facetFilters) body.facetFilters = cfg.facetFilters;
  return body;
}

/**
 * Search the Apify or Crawlee documentation via the public Algolia DocSearch
 * index that powers the docs site's own search box.
 *
 * @param source - Documentation index to query (defaults to `apify`)
 * @param query  - Algolia search query (keywords work better than sentences)
 * @param limit  - Max hits to return (Algolia caps at 20)
 * @param offset - Skip the first N hits (for pagination)
 */
export async function searchApifyDocs(
  source: DocSource,
  query: string,
  limit = 5,
  offset = 0
): Promise<DocSearchResult[]> {
  const cfg = findSource(source);
  const url = `https://${cfg.appId}-dsn.algolia.net/1/indexes/*/queries`;
  const body = JSON.stringify({ requests: [buildAlgoliaRequest(cfg, query)] });

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Algolia-Application-Id": cfg.appId,
          "X-Algolia-API-Key": cfg.apiKey,
        },
        body,
      },
      DOCS_FETCH_TIMEOUT_MS
    );
  } catch (err) {
    throw new Error(`Algolia request failed: ${toMsg(err)}`, { cause: err });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Algolia ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as AlgoliaResponse;
  const hits = data.results?.[0]?.hits ?? [];
  const out: DocSearchResult[] = [];
  for (const hit of hits) {
    if (!hit.url_without_anchor) continue;
    let url = hit.url_without_anchor;
    if (hit.anchor && hit.anchor.trim()) url += `#${hit.anchor}`;
    const result: DocSearchResult = { url };
    if (hit.content) result.content = hit.content;
    out.push(result);
  }
  return out.slice(offset, offset + limit);
}

/**
 * Apify's docs (Docusaurus) serve a `.md` twin of every HTML page. We use
 * those for clean Markdown without HTML scraping.
 *
 * Exported so tests can verify the URL-rewrite logic.
 */
export function buildMarkdownUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path ? `${path}.md` : "/index.md";
  return parsed.toString();
}

export function isAllowedDocUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.has(parsed.origin);
}

/**
 * Fetch the full markdown of an Apify or Crawlee documentation page.
 *
 * Restricted to the official docs domains so this can't be misused as a
 * generic SSRF surface. Hash fragments are stripped before fetching.
 */
export async function fetchApifyDoc(url: string): Promise<string> {
  const trimmed = url.trim();
  if (!isAllowedDocUrl(trimmed)) {
    throw new Error(
      `Refusing to fetch "${trimmed}". Only ${ALLOWED_DOC_DOMAINS.join(" or ")} URLs are allowed.`
    );
  }
  const withoutFragment = trimmed.split("#")[0] ?? trimmed;
  const mdUrl = buildMarkdownUrl(withoutFragment);
  const res = await fetchWithTimeout(mdUrl, {}, DOCS_FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Docs fetch ${res.status} ${res.statusText} for ${mdUrl}`);
  }
  return await res.text();
}
