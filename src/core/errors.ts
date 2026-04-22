/**
 * Structured error system for Kebab MCP tool handlers.
 * All packs should use McpToolError for machine-readable diagnostics.
 */

export const ErrorCode = {
  AUTH_FAILED: "AUTH_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  INVALID_INPUT: "INVALID_INPUT",
  EXTERNAL_API_ERROR: "EXTERNAL_API_ERROR",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Thrown by `getRequiredConfig()` (src/core/config-facade.ts) and
 * `getRequiredEnv()` (src/core/env-utils.ts) when a mandatory config
 * key is missing / empty. Distinct from McpToolError — this is a wiring
 * error, not a tool runtime error. Catchable at the pipeline layer to
 * surface a 500 with a generic message while logging the env var name
 * server-side.
 *
 * Phase 48 / FACADE-01 introduced the (message, key?) shape.
 * Phase 49 / TYPE-03 added the optional `connector` third arg so
 * connector-scoped callers (via `getRequiredEnv`) can surface which
 * connector owns the missing env var — enables richer 500 responses and
 * actionable logs without losing backward compatibility with existing
 * `getRequiredConfig()` callers.
 */
export class McpConfigError extends Error {
  constructor(
    message: string,
    public readonly key?: string,
    public readonly connector?: string
  ) {
    super(message);
    this.name = "McpConfigError";
  }
}

export class McpToolError extends Error {
  readonly code: ErrorCodeType;
  readonly toolName: string;
  readonly userMessage: string;
  readonly retryable: boolean;
  /** Generic recovery hint safe to surface to the MCP client / LLM. */
  readonly recovery: string | undefined;
  /**
   * Detailed recovery hint containing env var names or internal details.
   * Logged server-side only — never sent to the MCP client.
   */
  readonly internalRecovery: string | undefined;

  // Phase 49 / exactOptionalPropertyTypes: the optional opts fields are
  // widened to `| undefined` because callers (connector-errors.ts +
  // tool handlers) legitimately pass `cause: opts?.cause` where
  // opts?.cause is `Error | undefined`. Widening preserves the
  // "undefined is a meaningful no-value signal" semantic for these
  // fields. The class itself ALWAYS stores a union (string | undefined),
  // not an optional property — downstream consumers that check presence
  // via `!== undefined` keep working identically.
  constructor(opts: {
    code: ErrorCodeType;
    toolName: string;
    message: string;
    userMessage?: string | undefined;
    retryable?: boolean | undefined;
    cause?: Error | undefined;
    recovery?: string | undefined;
    internalRecovery?: string | undefined;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "McpToolError";
    this.code = opts.code;
    this.toolName = opts.toolName;
    this.userMessage = opts.userMessage ?? opts.message;
    this.retryable = opts.retryable ?? false;
    this.recovery = opts.recovery;
    this.internalRecovery = opts.internalRecovery;
  }
}
