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
  connected_account_id: z
    .string()
    .optional()
    .describe(
      "Connected account ID (from Composio dashboard). Optional if only one account per app."
    ),
};

export async function handleComposioAction(params: {
  action: string;
  params?: Record<string, unknown>;
  connected_account_id?: string;
}) {
  const result = await executeAction(
    params.action,
    params.params || {},
    params.connected_account_id
  );

  return {
    content: [{ type: "text" as const, text: result }],
  };
}
