import { z } from "zod";
import { executeAction } from "../lib/composio-client";

export const composioActionSchema = {
  action: z
    .string()
    .describe(
      "Composio action name (e.g., GITHUB_CREATE_ISSUE, JIRA_GET_ISSUE, HUBSPOT_CREATE_CONTACT). Use composio_list to discover available actions."
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Action parameters as key-value pairs. Depends on the action."),
  entity_id: z
    .string()
    .optional()
    .describe("Entity ID for the connected account (default: from COMPOSIO_ENTITY_ID env var)"),
};

export async function handleComposioAction(params: {
  action: string;
  params?: Record<string, unknown>;
  entity_id?: string;
}) {
  const result = await executeAction(params.action, params.params || {}, params.entity_id);

  return {
    content: [{ type: "text" as const, text: result }],
  };
}
