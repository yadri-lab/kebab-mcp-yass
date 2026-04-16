import { z } from "zod";
import { importBackup } from "@/core/backup";

export const backupImportSchema = {
  data: z.string().describe("JSON string of backup data to import (version 1 format)"),
};

export async function handleBackupImport(args: { data: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.data);
  } catch {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid JSON" }) }],
      isError: true,
    };
  }

  const result = await importBackup(parsed);

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
