import { z } from "zod";
import { listAvailableActions } from "../lib/composio-client";

export const composioListSchema = {
  app: z
    .string()
    .describe(
      "App name to list actions for (e.g., github, jira, hubspot, salesforce, airtable, linear, figma, trello)"
    ),
};

export async function handleComposioList(params: { app: string }) {
  const actions = await listAvailableActions(params.app);

  if (actions.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No actions found for "${params.app}". Check the app name or verify the connection in Composio dashboard.`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `${actions.length} actions available for ${params.app}:\n\n${actions.join("\n")}`,
      },
    ],
  };
}
