import { z } from "zod";
import { searchApifyDocs, type DocSource } from "../lib/docs";

export const apifySearchDocsSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Keywords to search Apify/Crawlee docs (full-text Algolia search — prefer keywords over full sentences, e.g. 'standby actor' or 'proxy rotation')."
    ),
  source: z
    .enum(["apify", "crawlee-js", "crawlee-py"])
    .optional()
    .default("apify")
    .describe(
      "Which docs index to search. 'apify' covers the platform, SDKs, CLI, REST API, and Academy. 'crawlee-js' / 'crawlee-py' target the Crawlee scraping libraries."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Max results to return (Algolia caps at 20)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Skip the first N results — useful for paginating through hits."),
};

export async function handleApifySearchDocs(params: {
  query: string;
  source?: DocSource;
  limit?: number;
  offset?: number;
}) {
  const source = params.source ?? "apify";
  const limit = params.limit ?? 5;
  const offset = params.offset ?? 0;
  const results = await searchApifyDocs(source, params.query, limit, offset);
  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No results for "${params.query}" in ${source} docs. Try different keywords or another source ('apify' / 'crawlee-js' / 'crawlee-py').`,
        },
      ],
    };
  }
  const text = results
    .map((r) => (r.content ? `- ${r.url}\n  ${r.content}` : `- ${r.url}`))
    .join("\n\n");
  return {
    content: [
      {
        type: "text" as const,
        text: `Search results for "${params.query}" in ${source}:\n\n${text}\n\nUse apify_fetch_doc with one of the URLs above to read the full page.`,
      },
    ],
  };
}
