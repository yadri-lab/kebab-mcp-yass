import { z } from "zod";
import { getContextKVStore } from "@/core/request-context";

export const webhookLastSchema = {
  name: z.string().describe("Webhook name to retrieve the last payload for"),
};

export async function handleWebhookLast(args: { name: string }) {
  const kv = getContextKVStore();
  const raw = await kv.get(`webhook:last:${args.name}`);

  if (!raw) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `No webhook payload found for "${args.name}"` }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: "text" as const, text: raw }],
  };
}
