/**
 * Backup / restore logic for KV store data.
 *
 * Shared between:
 * - CLI: scripts/backup.ts
 * - Admin tools: mcp_backup_export, mcp_backup_import
 *
 * Export format:
 * {
 *   version: 1,
 *   exportedAt: ISO string,
 *   entries: { key: value, ... }
 * }
 *
 * Only KV data is exported — no env vars or secrets.
 */

import { getKVStore } from "./kv-store";

export const BACKUP_VERSION = 1;

export interface BackupData {
  version: number;
  exportedAt: string;
  entries: Record<string, string>;
}

/**
 * Export all KV entries as a BackupData object.
 */
export async function exportBackup(): Promise<BackupData> {
  const kv = getKVStore();
  const keys = await kv.list();
  const entries: Record<string, string> = {};

  for (const key of keys) {
    const value = await kv.get(key);
    if (value !== null) {
      entries[key] = value;
    }
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  };
}

/**
 * Import a backup into the KV store.
 * Validates schema version before writing.
 */
export async function importBackup(
  data: unknown
): Promise<{ ok: boolean; message: string; count?: number }> {
  if (!data || typeof data !== "object") {
    return { ok: false, message: "Invalid backup: expected a JSON object" };
  }

  const backup = data as Record<string, unknown>;

  if (backup.version !== BACKUP_VERSION) {
    return {
      ok: false,
      message: `Unsupported backup version: ${backup.version} (expected ${BACKUP_VERSION})`,
    };
  }

  if (!backup.entries || typeof backup.entries !== "object" || Array.isArray(backup.entries)) {
    return { ok: false, message: "Invalid backup: missing or malformed entries" };
  }

  const entries = backup.entries as Record<string, unknown>;
  const kv = getKVStore();
  let count = 0;

  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string") {
      await kv.set(key, value);
      count++;
    }
  }

  return { ok: true, message: `Imported ${count} entries`, count };
}
