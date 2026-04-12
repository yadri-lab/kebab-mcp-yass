/**
 * KVStore — pluggable key/value storage abstraction.
 *
 * Two implementations:
 * - FilesystemKV: writes to `./data/kv.json` (or `/tmp/mymcp-kv.json` on Vercel
 *   when Upstash is not configured). Atomic write via tmp + rename. All keys
 *   live in a single JSON map for simplicity.
 * - UpstashKV: optional production backend using Upstash Redis REST API.
 *   Activates only if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 *   Uses raw fetch() — no @upstash/redis dep (keeps bundle small).
 *
 * Selection rules:
 * - If Upstash env vars present → UpstashKV
 * - Else if process.env.VERCEL === "1" → FilesystemKV at /tmp (ephemeral, warned)
 * - Else → FilesystemKV at ./data/kv.json
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface KVStore {
  kind: "filesystem" | "upstash";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

// ── FilesystemKV ────────────────────────────────────────────────────

class FilesystemKV implements KVStore {
  kind = "filesystem" as const;
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const buf = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(buf);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      return {};
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      return {};
    }
  }

  private async writeAll(map: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => fn());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async get(key: string): Promise<string | null> {
    const map = await this.readAll();
    return map[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.readAll();
      map[key] = value;
      await this.writeAll(map);
    });
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.readAll();
      if (key in map) {
        delete map[key];
        await this.writeAll(map);
      }
    });
  }

  async list(prefix?: string): Promise<string[]> {
    const map = await this.readAll();
    const keys = Object.keys(map);
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

// ── UpstashKV ───────────────────────────────────────────────────────

class UpstashKV implements KVStore {
  kind = "upstash" as const;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async call(command: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash ${command[0]} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.call(["GET", key]);
    return typeof result === "string" ? result : result == null ? null : String(result);
  }

  async set(key: string, value: string): Promise<void> {
    await this.call(["SET", key, value]);
  }

  async delete(key: string): Promise<void> {
    await this.call(["DEL", key]);
  }

  async list(prefix?: string): Promise<string[]> {
    const pattern = prefix ? `${prefix}*` : "*";
    const result = await this.call(["KEYS", pattern]);
    return Array.isArray(result) ? (result as string[]) : [];
  }
}

// ── Factory ──────────────────────────────────────────────────────────

let cached: KVStore | null = null;

export function getKVStore(): KVStore {
  if (cached) return cached;

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (upstashUrl && upstashToken) {
    cached = new UpstashKV(upstashUrl, upstashToken);
    return cached;
  }

  // Vercel detected, but no Upstash: fall back to /tmp with a warning.
  if (process.env.VERCEL === "1") {
    console.warn(
      "[MyMCP] KVStore: running on Vercel without UPSTASH_REDIS_REST_URL/TOKEN — " +
        "using /tmp filesystem (ephemeral, data lost on cold start). " +
        "Set Upstash env vars for persistence."
    );
    cached = new FilesystemKV("/tmp/mymcp-kv.json");
    return cached;
  }

  cached = new FilesystemKV(path.resolve(process.cwd(), "data", "kv.json"));
  return cached;
}

/** Reset the cached instance. Test-only. */
export function resetKVStoreCache(): void {
  cached = null;
}
