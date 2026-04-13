import type { ConnectorManifest } from "@/core/types";
import { notionSearchSchema, handleNotionSearch } from "./tools/notion-search";
import { notionReadSchema, handleNotionRead } from "./tools/notion-read";
import { notionCreateSchema, handleNotionCreate } from "./tools/notion-create";
import { notionUpdateSchema, handleNotionUpdate } from "./tools/notion-update";
import { notionQuerySchema, handleNotionQuery } from "./tools/notion-query";

export const notionConnector: ConnectorManifest = {
  id: "notion",
  label: "Notion",
  description: "Search, read, create, update, and query databases in Notion",
  requiredEnvVars: ["NOTION_API_KEY"],
  diagnose: async () => {
    try {
      const res = await fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
        },
      });
      if (res.ok) return { ok: true, message: "Notion API connected" };
      return { ok: false, message: `Notion API ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot reach Notion" };
    }
  },
  tools: [
    {
      name: "notion_search",
      description:
        "Search Notion pages by title or content. Returns page title, URL, last edited date, and properties.",
      schema: notionSearchSchema,
      handler: async (params) => handleNotionSearch(params as { query: string; limit?: number }),
    },
    {
      name: "notion_read",
      description:
        "Read the full content of a Notion page. Returns title and content as markdown (headings, paragraphs, lists, code blocks).",
      schema: notionReadSchema,
      handler: async (params) => handleNotionRead(params as { page_id: string }),
    },
    {
      name: "notion_create",
      description:
        "Create a new page in a Notion database. Provide the database ID, title, and optional content.",
      schema: notionCreateSchema,
      handler: async (params) =>
        handleNotionCreate(params as { database_id: string; title: string; content?: string }),
      destructive: true,
    },
    {
      name: "notion_update",
      description:
        "Update an existing Notion page. Can update properties (Status, Priority, etc.) and/or append content to the page body.",
      schema: notionUpdateSchema,
      handler: async (params) =>
        handleNotionUpdate(
          params as {
            page_id: string;
            properties?: Record<string, string | number | boolean>;
            append_content?: string;
          }
        ),
      destructive: true,
    },
    {
      name: "notion_query",
      description:
        "Query a Notion database with optional filters and sorting. Use notion_search to find the database ID first.",
      schema: notionQuerySchema,
      handler: async (params) =>
        handleNotionQuery(
          params as {
            database_id: string;
            filter?: Record<string, string | number | boolean>;
            sort?: string;
            limit?: number;
          }
        ),
    },
  ],
};
