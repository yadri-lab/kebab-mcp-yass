import type { PackManifest } from "@/core/types";
import { composioActionSchema, handleComposioAction } from "./tools/composio-action";
import { composioListSchema, handleComposioList } from "./tools/composio-list";

export const composioPack: PackManifest = {
  id: "composio",
  label: "Composio",
  description: "1000+ app integrations via Composio (Jira, HubSpot, Salesforce, Airtable, etc.)",
  requiredEnvVars: ["COMPOSIO_API_KEY"],
  diagnose: async () => {
    try {
      const { Composio } = await import("@composio/core");
      const client = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
      const accounts = await client.connectedAccounts.list();
      const count = Array.isArray(accounts) ? accounts.length : 0;
      return { ok: true, message: `${count} connected account(s)` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Cannot reach Composio",
      };
    }
  },
  tools: [
    {
      name: "composio_action",
      description:
        "Execute any Composio action on a connected app. Supports 1000+ apps: GitHub, Jira, HubSpot, Salesforce, Airtable, Linear, Figma, Trello, and more. Use composio_list to discover available actions for an app.",
      schema: composioActionSchema,
      handler: async (params) =>
        handleComposioAction(
          params as {
            action: string;
            params?: Record<string, unknown>;
            connected_account_id?: string;
          }
        ),
      destructive: true,
    },
    {
      name: "composio_list",
      description:
        "List available Composio actions for a specific app. Use this to discover what actions you can perform.",
      schema: composioListSchema,
      handler: async (params) => handleComposioList(params as { app: string }),
    },
  ],
};
