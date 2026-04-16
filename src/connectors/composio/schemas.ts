/**
 * Composio connector schemas — separated from handlers to enable lazy
 * loading of heavy deps (@composio/core ~2.3 MB).
 *
 * The manifest imports only this file at registration time; the actual
 * handler code (and its heavy imports) is loaded on first tool call
 * via dynamic `import()`.
 */
import { z } from "zod";

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

export const composioListSchema = {
  app: z
    .string()
    .describe(
      "App name to list actions for (e.g., github, jira, hubspot, salesforce, airtable, linear, figma, trello)"
    ),
};
