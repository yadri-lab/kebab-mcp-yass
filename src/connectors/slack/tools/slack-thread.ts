import { z } from "zod";
import { readThread } from "../lib/slack-api";

export const slackThreadSchema = {
  channel: z.string().describe("Channel ID where the thread lives (e.g., C01ABCDEF)"),
  thread_ts: z.string().describe("Timestamp of the parent message (from slack_read results)"),
  limit: z.number().optional().describe("Max replies to return (default: 50)"),
};

export async function handleSlackThread(params: {
  channel: string;
  thread_ts: string;
  limit?: number | undefined;
}) {
  const messages = await readThread(params.channel, params.thread_ts, params.limit);

  if (messages.length === 0) {
    return { content: [{ type: "text" as const, text: "No replies in this thread." }] };
  }

  const lines = messages.map((m) => `[${m.date.slice(0, 16)}] ${m.user}: ${m.text}`);

  return {
    content: [
      {
        type: "text" as const,
        text: `Thread (${messages.length} replies):\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}
