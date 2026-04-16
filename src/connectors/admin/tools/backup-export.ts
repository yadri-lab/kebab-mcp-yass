import { exportBackup } from "@/core/backup";
import { getContextKVStore } from "@/core/request-context";

export const backupExportSchema = {};

export async function handleBackupExport() {
  const data = await exportBackup(getContextKVStore());
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
