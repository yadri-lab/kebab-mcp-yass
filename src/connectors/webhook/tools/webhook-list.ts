import { getKVStore } from "@/core/kv-store";

export const webhookListSchema = {};

export async function handleWebhookList() {
  const kv = getKVStore();
  const keys = await kv.list("webhook:last:");

  const entries: Array<{ name: string; receivedAt?: string }> = [];
  for (const key of keys) {
    const name = key.replace(/^webhook:last:/, "");
    const raw = await kv.get(key);
    let receivedAt: string | undefined;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        receivedAt = parsed.receivedAt;
      } catch {
        // ignore parse errors
      }
    }
    entries.push({ name, receivedAt });
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ webhooks: entries, count: entries.length }),
      },
    ],
  };
}
