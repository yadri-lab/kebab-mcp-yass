import { z } from "zod";
import { queryDatabase } from "../lib/notion-api";

export const notionQuerySchema = {
  database_id: z.string().describe("Notion database ID to query"),
  filter: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Filter as key-value pairs. Example: {"Status": "In Progress", "Priority": "High"}. Values are matched with equals.'
    ),
  sort: z
    .string()
    .optional()
    .describe("Property name to sort by (descending). Default: last_edited_time."),
  limit: z.number().optional().describe("Max results (default: 20)"),
};

export async function handleNotionQuery(params: {
  database_id: string;
  filter?: Record<string, string | number | boolean> | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}) {
  const pages = await queryDatabase(params.database_id, params.filter, params.sort, params.limit);

  if (pages.length === 0) {
    return { content: [{ type: "text" as const, text: "No results found." }] };
  }

  const lines = pages.map((p) => {
    const props = Object.entries(p.properties)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
    return `**${p.title}** (${p.id})\n${p.url}\n${props}`;
  });

  return {
    content: [
      { type: "text" as const, text: `${pages.length} results:\n\n${lines.join("\n\n---\n\n")}` },
    ],
  };
}
