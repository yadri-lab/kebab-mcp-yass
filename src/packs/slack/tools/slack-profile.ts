import { z } from "zod";
import { getUserProfile } from "../lib/slack-api";

export const slackProfileSchema = {
  user: z.string().describe("User ID (e.g., U01ABCDEF). Found in slack_read message results."),
};

export async function handleSlackProfile(params: { user: string }) {
  const profile = await getUserProfile(params.user);

  const lines = [
    `**${profile.realName}** (@${profile.displayName})`,
    profile.title ? `Title: ${profile.title}` : null,
    profile.email ? `Email: ${profile.email}` : null,
    profile.phone ? `Phone: ${profile.phone}` : null,
    `Timezone: ${profile.tz}`,
    `Status: ${profile.statusEmoji ? `${profile.statusEmoji} ` : ""}${profile.statusText || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    content: [{ type: "text" as const, text: lines }],
  };
}
