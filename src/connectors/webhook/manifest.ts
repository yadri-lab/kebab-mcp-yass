import { defineTool, type ConnectorManifest } from "@/core/types";
import { webhookLastSchema, handleWebhookLast } from "./tools/webhook-last";
import { webhookListSchema, handleWebhookList } from "./tools/webhook-list";

export const webhookConnector: ConnectorManifest = {
  id: "webhook",
  label: "Webhook Receiver",
  description: "Receive and store external webhook payloads for retrieval via MCP tools",
  requiredEnvVars: [],
  isActive: (env) => {
    const webhooks = env.MYMCP_WEBHOOKS?.trim();
    if (!webhooks) {
      return { active: false, reason: "MYMCP_WEBHOOKS not set" };
    }
    return { active: true };
  },
  tools: [
    defineTool({
      name: "webhook_last",
      description:
        "Retrieve the most recent payload received for a named webhook. Returns the payload, timestamp, and content type.",
      schema: webhookLastSchema,
      handler: async (args) => handleWebhookLast(args),
      destructive: false,
    }),
    defineTool({
      name: "webhook_list",
      description:
        "List all named webhooks that have received at least one payload. Returns webhook names and last-received timestamps.",
      schema: webhookListSchema,
      handler: async () => handleWebhookList(),
      destructive: false,
    }),
  ],
};
