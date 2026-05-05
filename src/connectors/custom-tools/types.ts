import { z } from "zod";

/**
 * Custom Tools — declarative composition of existing Kebab MCP tools.
 *
 * A Custom Tool is a JSON-defined sequence of steps that calls existing
 * internal tools (vault_*, slack_*, etc.) and shapes data with strict
 * Mustache transforms — no user-supplied JS, no eval. The result is
 * exposed as a first-class MCP tool, indistinguishable to the LLM from
 * a hand-coded connector tool.
 *
 * Distinct from:
 *  - Skills (markdown prompt templates rendered for the LLM to execute)
 *  - API Tools (a single outbound HTTP call to a third-party API)
 *
 * A Custom Tool is an *internal* orchestration: each step either invokes
 * another Kebab tool by name or applies a Mustache transform to the
 * accumulating context object.
 */

// ── Inputs ────────────────────────────────────────────────────────────

/**
 * Custom-tool input names follow the same identifier rule as Skills /
 * API Tools so they round-trip through Mustache + JSON Schema cleanly.
 */
const inputNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const baseInput = {
  name: z.string().min(1).regex(inputNamePattern, "input name must be a valid identifier"),
  description: z.string().default(""),
  required: z.boolean().default(false),
};

export const customToolInputSchema = z.discriminatedUnion("type", [
  z.object({ ...baseInput, type: z.literal("string") }),
  z.object({ ...baseInput, type: z.literal("number") }),
  z.object({ ...baseInput, type: z.literal("boolean") }),
  z.object({
    ...baseInput,
    type: z.literal("enum"),
    values: z.array(z.string().min(1)).min(1, "enum must list at least one value"),
  }),
]);

export type CustomToolInput = z.infer<typeof customToolInputSchema>;

// ── Steps ─────────────────────────────────────────────────────────────

/**
 * `tool` step — invoke an existing Kebab MCP tool. `args` is a JSON object
 * whose string leaves are Mustache-expanded against the current context
 * (inputs + prior `saveAs` results). Non-string leaves pass through
 * unchanged.
 *
 * `saveAs`, when present, stores the tool's textual response under that
 * key in the context. Reserved names (`inputs`, `_`) are rejected at
 * parse time to prevent clashes.
 */
export const customToolStepToolSchema = z.object({
  kind: z.literal("tool"),
  toolName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "tool name must be a lowercase slug"),
  args: z.record(z.string(), z.unknown()).default({}),
  saveAs: z.string().min(1).regex(inputNamePattern, "saveAs must be a valid identifier").optional(),
});

/**
 * `transform` step — render a Mustache template against the context and
 * store the result under `saveAs`. Transforms never touch the network.
 */
export const customToolStepTransformSchema = z.object({
  kind: z.literal("transform"),
  template: z.string(),
  saveAs: z.string().min(1).regex(inputNamePattern, "saveAs must be a valid identifier"),
});

export const customToolStepSchema = z.discriminatedUnion("kind", [
  customToolStepToolSchema,
  customToolStepTransformSchema,
]);

export type CustomToolStep = z.infer<typeof customToolStepSchema>;
export type CustomToolToolStep = z.infer<typeof customToolStepToolSchema>;
export type CustomToolTransformStep = z.infer<typeof customToolStepTransformSchema>;

// ── Tool ──────────────────────────────────────────────────────────────

/**
 * The id pattern intentionally matches a full MCP tool name — the Custom
 * Tool is exposed verbatim under this name. Lowercase slug, snake_case.
 */
export const customToolIdPattern = /^[a-z][a-z0-9_]{0,63}$/;

export const customToolSchema = z.object({
  id: z.string().regex(customToolIdPattern, "id must be a lowercase snake_case slug, max 64 chars"),
  description: z.string().min(1).max(500),
  destructive: z.boolean().default(false),
  inputs: z.array(customToolInputSchema).default([]),
  steps: z.array(customToolStepSchema).min(1, "a Custom Tool needs at least one step"),
  /**
   * Per-step timeout override (milliseconds). When set, replaces the
   * env-driven default `CUSTOM_TOOLS_MAX_STEP_MS` (which itself falls
   * back to 15_000ms). Capped at 120_000ms so a misconfigured tool
   * cannot lock the Vercel function for the full 5 min.
   *
   * Leave `undefined` to inherit the env default — that's the correct
   * choice for ~95% of tools. Only override when a step is known to
   * legitimately take longer (paywall_read, web_agent) or shorter
   * (cheap local transforms where you want hard fail-fast).
   */
  maxStepMs: z.number().int().positive().max(120_000).optional(),
  /**
   * Total run timeout override (milliseconds). When set, replaces the
   * env-driven default `CUSTOM_TOOLS_MAX_TOTAL_MS` (fallback 45_000ms).
   * Capped at 300_000ms (5 min — Vercel hard ceiling for Pro plans).
   *
   * Total timeout aborts the entire run, not just the slowest step;
   * the in-flight step is marked timed-out and the run reports a
   * `total timeout exceeded` error so the author can distinguish it
   * from a single-step stall.
   */
  maxTotalMs: z.number().int().positive().max(300_000).optional(),
  /**
   * Server-computed cost estimate (write-time, see cost.ts).
   * 0 for transform-only tools, summed across `tool` steps using a
   * coarse per-pack heuristic. Surfaced in the dashboard list so
   * authors can spot expensive compositions at a glance. Always
   * stamped server-side on create/update; ignored on the write path
   * (any client-supplied value is overwritten with the freshly-
   * computed estimate). Optional for read-back compatibility with
   * tools persisted before this field existed — those round-trip
   * with `undefined` until the next update.
   */
  estimatedCost: z.number().int().nonnegative().optional(),
  /** ISO timestamps — populated by the store. */
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CustomTool = z.infer<typeof customToolSchema>;

/**
 * Authoring schema — what the dashboard / API accepts on POST/PUT.
 * Timestamps are stamped server-side; everything else mirrors the stored
 * schema.
 */
export const customToolWriteSchema = customToolSchema.omit({
  createdAt: true,
  updatedAt: true,
  // estimatedCost is server-computed; any client-supplied value is
  // ignored, so we drop it from the write schema entirely.
  estimatedCost: true,
});

export type CustomToolWriteInput = z.input<typeof customToolWriteSchema>;

// ── Runner result ─────────────────────────────────────────────────────

export interface StepRunResult {
  index: number;
  kind: CustomToolStep["kind"];
  /** Tool name for `tool` steps; "<transform>" for transforms. */
  label: string;
  ok: boolean;
  durationMs: number;
  /** Stringified preview of what was saved (truncated for transport). */
  preview?: string;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  /** Final value rendered to the MCP caller (last step's text). */
  result: string;
  stepResults: StepRunResult[];
  totalDurationMs: number;
  error?: string;
  /**
   * Phase 3 telemetry — destructive `tool` steps that successfully
   * committed BEFORE any later failure aborted the run. Surfaced so
   * operators (and the dashboard "Recent runs" tab) can see what side
   * effects landed before the crash and decide whether manual rollback
   * is required. Empty for fully-successful runs and for runs that
   * failed before any destructive step landed.
   */
  committedSteps: { index: number; toolName: string }[];
}
