import { exportBackup } from "@/core/backup";

export const backupExportSchema = {};

export async function handleBackupExport() {
  const data = await exportBackup();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
