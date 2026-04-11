import { z } from "zod";
import { updatePage } from "../lib/notion-api";

export const notionUpdateSchema = {
  page_id: z.string().describe("Notion page ID to update"),
  properties: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Properties to update as key-value pairs. Example: {"Status": "Done", "Priority": "High"}'
    ),
  append_content: z
    .string()
    .optional()
    .describe("Text to append to the page (paragraphs separated by double newlines)"),
};

export async function handleNotionUpdate(params: {
  page_id: string;
  properties?: Record<string, string | number | boolean>;
  append_content?: string;
}) {
  const result = await updatePage(params.page_id, params.properties, params.append_content);

  const actions: string[] = [];
  if (params.properties)
    actions.push(`${Object.keys(params.properties).length} properties updated`);
  if (params.append_content) actions.push("content appended");

  return {
    content: [
      {
        type: "text" as const,
        text: `Page updated: ${result.url}\n${actions.join(", ")}`,
      },
    ],
  };
}
