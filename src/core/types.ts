import { z } from "zod";

/**
 * Core types for MyMCP framework.
 * These are framework-level types — no instance-specific values.
 */

/** Result shape returned by all tool handlers — index signature for MCP SDK compatibility */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Single tool definition — the unit of functionality */
export interface ToolDefinition {
  /** MCP tool name (e.g., "gmail_inbox") */
  name: string;
  /** MCP tool description shown to the LLM */
  description: string;
  /** Zod schema for input validation */
  schema: Record<string, z.ZodTypeAny>;
  /** Handler function */
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
  /** Short one-line summary (optional, for docs/dashboard) */
  summary?: string;
  /** Usage example (optional, for docs/dashboard) */
  example?: string;
  /** Deprecation notice — if set, tool is marked deprecated in dashboard + MCP description */
  deprecated?: string;
}

/** Pack manifest — groups related tools */
export interface PackManifest {
  /** Pack identifier (e.g., "google", "vault") */
  id: string;
  /** Human-readable label (e.g., "Google Workspace") */
  label: string;
  /** Short description of what this pack provides */
  description: string;
  /** Env vars that MUST be present to activate this pack */
  requiredEnvVars: string[];
  /** All tools in this pack */
  tools: ToolDefinition[];
  /** Optional async health check — verifies credentials actually work */
  diagnose?: () => Promise<{ ok: boolean; message: string }>;
}

/** Resolved state of a pack at runtime */
export interface PackState {
  manifest: PackManifest;
  enabled: boolean;
  reason: string;
}

/** Instance-level configuration from env vars */
export interface InstanceConfig {
  timezone: string;
  locale: string;
  displayName: string;
  contextPath: string;
}
