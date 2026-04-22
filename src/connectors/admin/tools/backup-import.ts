import { z } from "zod";
import { importBackup } from "@/core/backup";
import { getContextKVStore } from "@/core/request-context";

export const backupImportSchema = {
  data: z.string().describe("JSON string of backup data to import (version 1 format)"),
  mode: z
    .enum(["merge", "replace"])
    .optional()
    .describe(
      'Import mode: "merge" (default) adds/overwrites keys from backup; "replace" deletes all existing keys not in the backup first'
    ),
};

export async function handleBackupImport(args: {
  data: string;
  mode?: "merge" | "replace" | undefined;
}) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.data);
  } catch {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid JSON" }) }],
      isError: true,
    };
  }

  const result = await importBackup(parsed, { mode: args.mode, kv: getContextKVStore() });

  if (!result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: result.message }) }],
      isError: true,
    };
  }

  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ ok: true, message: result.message }) },
    ],
  };
}
