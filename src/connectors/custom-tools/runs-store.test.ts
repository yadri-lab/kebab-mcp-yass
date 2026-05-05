import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRun,
  listRuns,
  _MAX_ENTRIES_FOR_TESTS,
  _TTL_SECONDS_FOR_TESTS,
  _KEY_PREFIX_FOR_TESTS,
  type RunRecord,
} from "./runs-store";
import { resetKVStoreCache } from "@/core/kv-store";

/**
 * runs-store unit tests.
 *
 * Covers:
 *  - recordRun + listRuns roundtrip on the filesystem KV (default
 *    backend in tests — `lpushCapped`/`lrange` not available, so the
 *    code exercises the JSON-array fallback path)
 *  - 100-entry cap is enforced (oldest entries fall off the head)
 *  - listRuns clamps `limit` and returns newest-first
 *  - recordRun NEVER throws — KV explosion is swallowed
 *  - Upstash path: lpushCapped is called with the right key, line, cap,
 *    and TTL
 */

function mk(toolId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    toolId,
    ok: true,
    totalMs: 12,
    stepCount: 1,
    stepResults: [
      {
        index: 0,
        kind: "transform",
        label: "<transform>",
        ok: true,
        durationMs: 12,
      },
    ],
    committedSteps: [],
    inputsPreview: '{"x":1}',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    source: "test",
    tokenIdShort: "abc12345",
    ...overrides,
  };
}

describe("runs-store — filesystem KV roundtrip (fallback path)", () => {
  let kvDir: string;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    kvDir = mkdtempSync(join(tmpdir(), "kebab-runs-store-"));
    process.chdir(kvDir);
    resetKVStoreCache();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    resetKVStoreCache();
    try {
      rmSync(kvDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("records a single run and reads it back", async () => {
    await recordRun(mk("todo_add", { ok: true, totalMs: 42 }));
    const runs = await listRuns("todo_add");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.toolId).toBe("todo_add");
    expect(runs[0]?.ok).toBe(true);
    expect(runs[0]?.totalMs).toBe(42);
    expect(runs[0]?.tokenIdShort).toBe("abc12345");
  });

  it("returns runs newest-first", async () => {
    await recordRun(mk("t", { totalMs: 1, error: "first" }));
    await recordRun(mk("t", { totalMs: 2, error: "second" }));
    await recordRun(mk("t", { totalMs: 3, error: "third" }));
    const runs = await listRuns("t");
    expect(runs.map((r) => r.error)).toEqual(["third", "second", "first"]);
  });

  it("isolates runs by toolId (different keys)", async () => {
    await recordRun(mk("tool_a"));
    await recordRun(mk("tool_b"));
    expect(await listRuns("tool_a")).toHaveLength(1);
    expect(await listRuns("tool_b")).toHaveLength(1);
    expect(await listRuns("tool_c")).toHaveLength(0);
  });

  it("returns [] for an unknown tool", async () => {
    const runs = await listRuns("never_recorded");
    expect(runs).toEqual([]);
  });

  it("caps the stored history at 100 entries (oldest evicted)", async () => {
    // Push 105 records — the first 5 should fall off the tail.
    for (let i = 0; i < _MAX_ENTRIES_FOR_TESTS + 5; i++) {
      await recordRun(mk("capped", { totalMs: i }));
    }
    const runs = await listRuns("capped", _MAX_ENTRIES_FOR_TESTS);
    expect(runs).toHaveLength(_MAX_ENTRIES_FOR_TESTS);
    // Newest first → totalMs goes from 104 down to 5 (the first 5 were
    // pushed-then-evicted).
    expect(runs[0]?.totalMs).toBe(_MAX_ENTRIES_FOR_TESTS + 4);
    expect(runs[runs.length - 1]?.totalMs).toBe(5);
  });

  it("clamps the limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await recordRun(mk("clamp", { totalMs: i }));
    }
    // limit=0 → clamped to 1
    const one = await listRuns("clamp", 0);
    expect(one.length).toBe(1);
    // limit > MAX_ENTRIES → clamped to MAX_ENTRIES (we only have 10, so 10)
    const all = await listRuns("clamp", 9999);
    expect(all.length).toBe(10);
    // Default limit is 50 → all 10 visible
    const def = await listRuns("clamp");
    expect(def.length).toBe(10);
  });

  it("preserves committedSteps + step breakdown across roundtrip", async () => {
    const record = mk("with_committed", {
      ok: false,
      error: "step[2] (vault_write): boom",
      stepResults: [
        {
          index: 0,
          kind: "transform",
          label: "<transform>",
          ok: true,
          durationMs: 1,
        },
        {
          index: 1,
          kind: "tool",
          label: "vault_write",
          ok: true,
          durationMs: 5,
        },
        {
          index: 2,
          kind: "tool",
          label: "vault_write",
          ok: false,
          durationMs: 7,
          error: "boom",
        },
      ],
      committedSteps: [{ index: 1, toolName: "vault_write" }],
    });
    await recordRun(record);
    const [back] = await listRuns("with_committed");
    expect(back?.committedSteps).toEqual([{ index: 1, toolName: "vault_write" }]);
    expect(back?.stepResults).toHaveLength(3);
    expect(back?.stepResults[2]?.error).toBe("boom");
  });
});

describe("runs-store — Upstash path (mocked KV)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses lpushCapped with the correct key, cap, and TTL when available", async () => {
    const lpushCapped = vi.fn<
      (
        key: string,
        value: string,
        maxLength: number,
        opts?: { ttlSeconds?: number | undefined }
      ) => Promise<void>
    >(async () => undefined);
    const lrange = vi.fn<(key: string, start: number, stop: number) => Promise<string[]>>(
      async () => [] as string[]
    );
    const mockKv = {
      kind: "upstash" as const,
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      lpushCapped,
      lrange,
    };
    vi.spyOn(await import("@/core/request-context"), "getContextKVStore").mockReturnValue(mockKv);

    const rec = mk("native");
    await recordRun(rec);

    expect(lpushCapped).toHaveBeenCalledTimes(1);
    const args = lpushCapped.mock.calls[0]!;
    expect(args[0]).toBe(`${_KEY_PREFIX_FOR_TESTS}native`);
    // The serialized line is the second arg
    expect(typeof args[1]).toBe("string");
    expect(JSON.parse(String(args[1]))).toMatchObject({ toolId: "native" });
    expect(args[2]).toBe(_MAX_ENTRIES_FOR_TESTS);
    expect(args[3]).toEqual({ ttlSeconds: _TTL_SECONDS_FOR_TESTS });
    // set() must NOT be used when lpushCapped is available
    expect(mockKv.set).not.toHaveBeenCalled();
  });

  it("uses lrange to read with the correct range when available", async () => {
    const stored: RunRecord[] = [
      mk("read_native", { totalMs: 1 }),
      mk("read_native", { totalMs: 2 }),
    ];
    const lrange = vi.fn(async () => stored.map((r) => JSON.stringify(r)));
    const mockKv = {
      kind: "upstash" as const,
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      lpushCapped: vi.fn(),
      lrange,
    };
    vi.spyOn(await import("@/core/request-context"), "getContextKVStore").mockReturnValue(mockKv);

    const out = await listRuns("read_native", 25);
    expect(lrange).toHaveBeenCalledWith(`${_KEY_PREFIX_FOR_TESTS}read_native`, 0, 24);
    expect(out).toHaveLength(2);
    expect(mockKv.get).not.toHaveBeenCalled();
  });
});

describe("runs-store — fire-and-forget contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordRun NEVER throws even when KV explodes", async () => {
    const mockKv = {
      kind: "upstash" as const,
      get: vi.fn(),
      set: vi.fn(async () => {
        throw new Error("KV down");
      }),
      delete: vi.fn(),
      list: vi.fn(),
      lpushCapped: vi.fn(async () => {
        throw new Error("Upstash 503");
      }),
      lrange: vi.fn(),
    };
    vi.spyOn(await import("@/core/request-context"), "getContextKVStore").mockReturnValue(mockKv);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Must resolve, not reject.
    await expect(recordRun(mk("boom"))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("listRuns returns [] when KV explodes (graceful degrade)", async () => {
    const mockKv = {
      kind: "upstash" as const,
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      lpushCapped: vi.fn(),
      lrange: vi.fn(async () => {
        throw new Error("Upstash timeout");
      }),
    };
    vi.spyOn(await import("@/core/request-context"), "getContextKVStore").mockReturnValue(mockKv);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await listRuns("never");
    expect(out).toEqual([]);
    warnSpy.mockRestore();
  });

  it("listRuns drops corrupt JSON entries silently", async () => {
    const validRecord = mk("mixed");
    const mockKv = {
      kind: "upstash" as const,
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      lpushCapped: vi.fn(),
      lrange: vi.fn(async () => [
        JSON.stringify(validRecord),
        "not valid json",
        JSON.stringify({ wrong: "shape" }),
      ]),
    };
    vi.spyOn(await import("@/core/request-context"), "getContextKVStore").mockReturnValue(mockKv);

    const out = await listRuns("mixed");
    expect(out).toHaveLength(1);
    expect(out[0]?.toolId).toBe("mixed");
  });
});
