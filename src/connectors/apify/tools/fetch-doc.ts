import { z } from "zod";
import { fetchApifyDoc, ALLOWED_DOC_DOMAINS } from "../lib/docs";

export const apifyFetchDocSchema = {
  url: z
    .string()
    .url()
    .describe(
      `Full URL of the Apify or Crawlee documentation page to fetch. Must start with ${ALLOWED_DOC_DOMAINS.join(" or ")}. Find URLs via apify_search_docs.`
    ),
};

export async function handleApifyFetchDoc(params: { url: string }) {
  const markdown = await fetchApifyDoc(params.url);
  return {
    content: [
      {
        type: "text" as const,
        text: `Content of ${params.url}:\n\n${markdown}`,
      },
    ],
  };
}
