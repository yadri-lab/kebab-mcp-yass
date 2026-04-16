/**
 * Tests for backup/restore roundtrip and version validation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockKV: Record<string, string> = {};

const mockKVInstance = {
  kind: "filesystem" as const,
  get: vi.fn(async (key: string) => mockKV[key] ?? null),
  set: vi.fn(async (key: string, value: string) => {
    mockKV[key] = value;
  }),
  delete: vi.fn(async (key: string) => {
    delete mockKV[key];
  }),
  list: vi.fn(async (prefix?: string) => {
    const keys = Object.keys(mockKV);
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }),
};

vi.mock("@/core/kv-store", () => ({
  getKVStore: () => mockKVInstance,
  getTenantKVStore: () => mockKVInstance,
}));

import { exportBackup, importBackup, BACKUP_VERSION } from "@/core/backup";

describe("backup export/import", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
  });

  it("exports all KV entries", async () => {
    mockKV["settings:name"] = "TestUser";
    mockKV["webhook:last:stripe"] = '{"payload":"test"}';

    const data = await exportBackup();
    expect(data.version).toBe(BACKUP_VERSION);
    expect(data.exportedAt).toBeTruthy();
    expect(data.entries["settings:name"]).toBe("TestUser");
    expect(data.entries["webhook:last:stripe"]).toBe('{"payload":"test"}');
  });

  it("roundtrip preserves data", async () => {
    mockKV["key1"] = "value1";
    mockKV["key2"] = "value2";
    mockKV["nested:key"] = '{"deep":true}';

    const exported = await exportBackup();

    // Clear KV
    for (const key of Object.keys(mockKV)) delete mockKV[key];
    expect(Object.keys(mockKV)).toHaveLength(0);

    // Import
    const result = await importBackup(exported);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);

    // Verify
    expect(mockKV["key1"]).toBe("value1");
    expect(mockKV["key2"]).toBe("value2");
    expect(mockKV["nested:key"]).toBe('{"deep":true}');
  });

  it("rejects wrong version", async () => {
    const result = await importBackup({ version: 999, entries: {} });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unsupported backup version");
  });

  it("rejects non-object input", async () => {
    const result = await importBackup("not an object");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected a JSON object");
  });

  it("rejects missing entries", async () => {
    const result = await importBackup({ version: 1 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("missing or malformed entries");
  });

  it("skips non-string values in entries", async () => {
    const result = await importBackup({
      version: 1,
      entries: { valid: "ok", invalid: 123 },
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(mockKV["valid"]).toBe("ok");
  });

  it("merge mode (default) preserves existing keys not in backup", async () => {
    mockKV["existing"] = "keep-me";
    mockKV["overwrite"] = "old";

    const result = await importBackup(
      { version: 1, entries: { overwrite: "new", added: "fresh" } },
      { mode: "merge" }
    );
    expect(result.ok).toBe(true);
    expect(mockKV["existing"]).toBe("keep-me");
    expect(mockKV["overwrite"]).toBe("new");
    expect(mockKV["added"]).toBe("fresh");
  });

  it("replace mode deletes keys not in backup", async () => {
    mockKV["existing"] = "remove-me";
    mockKV["keep"] = "old-value";

    const result = await importBackup(
      { version: 1, entries: { keep: "new-value", added: "fresh" } },
      { mode: "replace" }
    );
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(mockKV["existing"]).toBeUndefined();
    expect(mockKV["keep"]).toBe("new-value");
    expect(mockKV["added"]).toBe("fresh");
    expect(result.message).toContain("Replaced");
  });
});

describe("backup admin tools", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockKV)) delete mockKV[key];
  });

  it("mcp_backup_export returns JSON", async () => {
    mockKV["test"] = "data";
    const { handleBackupExport } = await import("@/connectors/admin/tools/backup-export");
    const result = await handleBackupExport();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version).toBe(1);
    expect(parsed.entries.test).toBe("data");
  });

  it("mcp_backup_import writes to KV", async () => {
    const { handleBackupImport } = await import("@/connectors/admin/tools/backup-import");
    const backup = JSON.stringify({ version: 1, entries: { k: "v" } });
    const result = await handleBackupImport({ data: backup });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockKV["k"]).toBe("v");
  });

  it("mcp_backup_import rejects invalid JSON", async () => {
    const { handleBackupImport } = await import("@/connectors/admin/tools/backup-import");
    const result = await handleBackupImport({ data: "not json" });
    expect(result.isError).toBe(true);
  });
});
