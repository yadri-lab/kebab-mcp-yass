import type { InstanceConfig } from "./types";

/**
 * Reads instance configuration from environment variables.
 * All values have sensible defaults — zero config required for basic operation.
 *
 * Framework-level: this module defines WHAT config exists.
 * Instance-level: values come from env vars set by the user.
 */
export function getInstanceConfig(): InstanceConfig {
  return {
    timezone: process.env.MYMCP_TIMEZONE || "UTC",
    locale: process.env.MYMCP_LOCALE || "en-US",
    displayName: process.env.MYMCP_DISPLAY_NAME || "User",
    contextPath: process.env.MYMCP_CONTEXT_PATH || "System/context.md",
  };
}

/** Default tool timeout in ms. Override via MYMCP_TOOL_TIMEOUT env var. */
export function getToolTimeout(): number {
  const raw = process.env.MYMCP_TOOL_TIMEOUT;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 30_000; // 30s default
}

/** Webhook URL for error notifications. If set, POST is sent on tool failure. */
export function getErrorWebhookUrl(): string | undefined {
  return process.env.MYMCP_ERROR_WEBHOOK_URL || undefined;
}

/**
 * Parse MYMCP_ENABLED_PACKS if set.
 * Returns undefined if not set (all packs auto-activate by env vars).
 * Returns Set of pack IDs if set (only listed packs are considered).
 */
export function getEnabledPacksOverride(): Set<string> | undefined {
  const raw = process.env.MYMCP_ENABLED_PACKS;
  if (!raw) return undefined;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
