import { z } from "zod";
import { getContextKVStore } from "@/core/request-context";

export const webhookHistorySchema = {
  name: z.string().describe("Webhook name to retrieve history for"),
  limit: z
    .number()
    .default(10)
    .describe("Maximum number of recent payloads to return (default: 10)"),
};

export async function handleWebhookHistory(args: { name: string; limit: number }) {
  const kv = getContextKVStore();
  const prefix = `webhook:history:${args.name}:`;
  const keys = await kv.list(prefix);

  if (keys.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `No webhook history found for "${args.name}"` }),
        },
      ],
      isError: true,
    };
  }

  // Sort by timestamp descending (newest first)
  const sorted = keys
    .map((k) => ({ key: k, ts: parseInt(k.slice(prefix.length), 10) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, args.limit));

  const entries: unknown[] = [];
  for (const { key } of sorted) {
    const raw = await kv.get(key);
    if (raw) {
      try {
        entries.push(JSON.parse(raw));
      } catch {
        entries.push({ raw });
      }
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ name: args.name, count: entries.length, entries }),
      },
    ],
  };
}
