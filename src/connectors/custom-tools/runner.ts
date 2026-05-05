import { getEnabledPacksLazy } from "@/core/registry";
import { runWithCredentials } from "@/core/request-context";
import { getHydratedCredentialSnapshot } from "@/core/credential-store";
import { getConfigInt } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";
import type { ToolDefinition, ToolResult } from "@/core/types";
import type { CustomTool, CustomToolStep, RunResult, StepRunResult } from "./types";
import { expandArgs, renderTemplate } from "./expression";
import { getActiveCustomToolIds, runWithActiveCustomToolIds } from "./context";

/**
 * Custom Tool runner.
 *
 * Executes a tool's `steps[]` sequentially, accumulating results into a
 * single context object that subsequent steps can read via Mustache.
 *
 * Step semantics:
 *  - `tool`      → look up `toolName` in the loaded registry, expand
 *                  `args` against the context, invoke the handler in
 *                  process (no MCP round-trip), optionally save the
 *                  string result under `saveAs`.
 *  - `transform` → render `template`, save under `saveAs`.
 *
 * Output: the LAST step's textual contribution becomes the MCP-facing
 * result. Per-step results are returned alongside so the dashboard can
 * show a stack-trace-style breakdown.
 *
 * Recursion guard (CR-01): a Custom Tool can call other Custom Tools,
 * but never itself (direct or transitive). The set of active tool ids
 * is carried through an AsyncLocalStorage (`./context`) so transitive
 * calls (A→B→A) see the full call-stack regardless of how the inner
 * invocation is triggered (manifest wrapper, direct runner call, …).
 */

const MAX_STEPS = 32;
const PREVIEW_LIMIT = 240;

/**
 * Default per-step timeout. A single Custom Tool step (one tool call
 * or one Mustache render) may not exceed this without timing out.
 * Override with `CUSTOM_TOOLS_MAX_STEP_MS` env var or per-tool
 * `maxStepMs` field.
 */
const DEFAULT_MAX_STEP_MS = 15_000;

/**
 * Default total run timeout. The whole sequence of steps must complete
 * within this window or the runner aborts with a `total timeout
 * exceeded` error. Override with `CUSTOM_TOOLS_MAX_TOTAL_MS` env var
 * or per-tool `maxTotalMs` field.
 */
const DEFAULT_MAX_TOTAL_MS = 45_000;

function resolveMaxStepMs(tool: CustomTool): number {
  if (typeof tool.maxStepMs === "number" && tool.maxStepMs > 0) return tool.maxStepMs;
  const fromEnv = getConfigInt("CUSTOM_TOOLS_MAX_STEP_MS", DEFAULT_MAX_STEP_MS);
  return fromEnv > 0 ? fromEnv : DEFAULT_MAX_STEP_MS;
}

function resolveMaxTotalMs(tool: CustomTool): number {
  if (typeof tool.maxTotalMs === "number" && tool.maxTotalMs > 0) return tool.maxTotalMs;
  const fromEnv = getConfigInt("CUSTOM_TOOLS_MAX_TOTAL_MS", DEFAULT_MAX_TOTAL_MS);
  return fromEnv > 0 ? fromEnv : DEFAULT_MAX_TOTAL_MS;
}

/**
 * Symbol thrown by the per-step timeout race so the runner can
 * distinguish a real handler error from a timeout we induced.
 */
class StepTimeoutError extends Error {
  constructor(ms: number) {
    super(`step timed out after ${ms}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Symbol thrown by the total-run timeout race. Caught at the runner
 * top level so the error message can mention which step was in flight.
 */
class TotalTimeoutError extends Error {
  constructor(ms: number) {
    super(`total timeout exceeded after ${ms}ms`);
    this.name = "TotalTimeoutError";
  }
}

/**
 * CR-02 — Allowlist of connectors callable from Custom Tools.
 *
 * Custom Tools run inside an admin-authored definition but are exposed
 * to *any* MCP client (Claude.ai, Cline, …). A Custom Tool that calls
 * `mcp_backup_export` would dump every KV key — including credentials —
 * back through the standard MCP channel, escalating an LLM client to
 * effective admin. We therefore restrict the callable surface to the
 * connectors whose tools are designed for MCP-client consumption.
 *
 * Excluded explicitly:
 *  - `admin`       — privilege escalation (backup export, raw KV access).
 *  - `skills`      — prompt injection vector; skills are LLM-rendered
 *                    instructions, not deterministic operations.
 *  - `custom-tools` — recursion vector handled by activeIds, but kept
 *                    out of the lookup here as a defense-in-depth: an
 *                    enabled Custom Tool can still be referenced; the
 *                    activeIds guard catches A→B→A cycles regardless.
 */
const CALLABLE_FROM_CUSTOM_TOOLS = new Set([
  "google",
  "vault",
  "slack",
  "notion",
  "composio",
  "api-connections",
  "apify",
  "github",
  "linear",
  "airtable",
  "paywall",
  "webhook",
  "browser",
  "custom-tools",
]);

/**
 * Look up a tool in the merged registry, refusing any tool whose owning
 * pack is not in CALLABLE_FROM_CUSTOM_TOOLS.
 *
 * Returns `{ tool, packId }` on hit so the caller can surface a clear
 * "pack X is not in allowlist" message when the lookup matched a tool
 * but the pack was filtered.
 */
async function findToolByName(
  name: string
): Promise<{ tool: ToolDefinition; packId: string } | { blockedPackId: string } | null> {
  const packs = await getEnabledPacksLazy();
  for (const p of packs) {
    const found = p.manifest.tools.find((t) => t.name === name);
    if (!found) continue;
    if (!CALLABLE_FROM_CUSTOM_TOOLS.has(p.manifest.id)) {
      return { blockedPackId: p.manifest.id };
    }
    return { tool: found, packId: p.manifest.id };
  }
  return null;
}

export { CALLABLE_FROM_CUSTOM_TOOLS };

/**
 * Build the input bag the runner exposes to Mustache. Optional inputs
 * default to undefined (rendered as empty string by the expression
 * engine). Required-but-missing inputs are caught here, not at first
 * Mustache use, so the error message is more helpful.
 */
function buildInitialContext(
  tool: CustomTool,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const def of tool.inputs) {
    const raw = inputs[def.name];
    if (raw === undefined || raw === null || raw === "") {
      if (def.required) {
        throw new Error(`missing required input "${def.name}"`);
      }
      ctx[def.name] = undefined;
      continue;
    }
    if (def.type === "enum" && !def.values.includes(String(raw))) {
      throw new Error(
        `input "${def.name}" must be one of ${def.values.join(", ")} (got "${String(raw)}")`
      );
    }
    ctx[def.name] = raw;
  }
  return ctx;
}

/**
 * Run a custom tool. Throws only on programmer errors (unknown step
 * kind, internal invariants); all author-facing errors are folded into
 * the returned `RunResult` with `ok: false`.
 *
 * The recursion guard relies on an AsyncLocalStorage-backed set of
 * active ids (`./context`). When the manifest wrapper invokes
 * `runCustomTool` for tool B from inside A's step, B inherits the set
 * of active ids from the outer A context automatically — so A→B→A is
 * caught at the second `tool_a` lookup, not after a stack overflow.
 *
 * ## Timeouts
 *
 * Two layered timeouts protect against slow / hung steps:
 *  - **Per-step** (`CUSTOM_TOOLS_MAX_STEP_MS` or `tool.maxStepMs`,
 *    default 15s, max 120s): each individual step must resolve in
 *    this window. The step is marked `ok: false, error: "timed out"`
 *    and the run aborts on the first timeout.
 *  - **Total** (`CUSTOM_TOOLS_MAX_TOTAL_MS` or `tool.maxTotalMs`,
 *    default 45s, max 300s): the full sequence of steps must complete
 *    within this window. If hit, the in-flight step is marked
 *    timed-out and the run error is `total timeout exceeded`.
 *
 * For `tool` steps, an `AbortController` is created and an abort is
 * signalled on timeout — but the underlying handler signature is a
 * single `(args)` argument (see `ToolDefinition.handler` in core), so
 * the signal is **not** propagated to the handler. The handler keeps
 * running in the background; the runner moves on. This is acceptable
 * for an MVP: the operator gets a clear error and the lambda will
 * tear down the orphaned promise. A future iteration may widen the
 * handler signature to `(args, opts?)` so handlers can opt into
 * cooperative cancellation.
 */
export async function runCustomTool(
  tool: CustomTool,
  inputs: Record<string, unknown>
): Promise<RunResult> {
  const startedAt = Date.now();
  const stepResults: StepRunResult[] = [];
  const maxStepMs = resolveMaxStepMs(tool);
  const maxTotalMs = resolveMaxTotalMs(tool);

  // Recursion guard — direct or transitive. Read the set already on the
  // call stack (empty Set if we're the outermost invocation), reject if
  // the current tool is in it, then push our own id and propagate the
  // extended set to nested invocations via the ALS.
  const previousActive = getActiveCustomToolIds();
  if (previousActive.has(tool.id)) {
    const chain = [...previousActive, tool.id].join(" → ");
    return {
      ok: false,
      result: "",
      stepResults,
      totalDurationMs: 0,
      error: `recursion detected: ${chain}`,
    };
  }
  const activeIds = new Set(previousActive);
  activeIds.add(tool.id);

  if (tool.steps.length > MAX_STEPS) {
    return {
      ok: false,
      result: "",
      stepResults,
      totalDurationMs: 0,
      error: `too many steps (max ${MAX_STEPS}, got ${tool.steps.length})`,
    };
  }

  // Build the initial context from the inputs.
  let context: Record<string, unknown>;
  try {
    context = buildInitialContext(tool, inputs);
  } catch (err) {
    return {
      ok: false,
      result: "",
      stepResults,
      totalDurationMs: Date.now() - startedAt,
      error: toMsg(err),
    };
  }

  // Wrap the whole sequence in runWithCredentials so child tools that
  // depend on hydrated credentials (vault_*, slack_*, …) see them. The
  // snapshot is the same one resolveRegistryAsync uses to gate
  // connectors, so a tool that's enabled is necessarily callable here.
  const credSnapshot = getHydratedCredentialSnapshot();

  let lastSaved = "";
  let lastError: string | undefined;
  let lastFinalText = "";

  // Total-run timeout — racing the entire step loop against a wall
  // clock. On timeout, the in-flight step is patched to `ok: false`
  // (it would otherwise be missing from stepResults entirely, since
  // the loop body hasn't pushed a result for it yet).
  const runStepsLoop = async (): Promise<void> => {
    for (let i = 0; i < tool.steps.length; i++) {
      const step = tool.steps[i]!;
      const stepStarted = Date.now();
      const label = step.kind === "tool" ? step.toolName : "<transform>";
      // Pre-register a placeholder so a total-timeout fired DURING
      // this step still produces a row for it. Replaced below on
      // success / step-error.
      const placeholder: StepRunResult = {
        index: i,
        kind: step.kind,
        label,
        ok: false,
        durationMs: 0,
        error: "in-flight",
      };
      stepResults.push(placeholder);
      try {
        const { saved, finalText } = await runStep(step, context, activeIds, maxStepMs);
        if (step.kind === "tool" && step.saveAs) {
          context[step.saveAs] = saved;
        } else if (step.kind === "transform") {
          context[step.saveAs] = saved;
        }
        lastSaved = String(saved ?? "");
        lastFinalText = finalText;
        stepResults[i] = {
          index: i,
          kind: step.kind,
          label,
          ok: true,
          durationMs: Date.now() - stepStarted,
          preview: previewOf(saved),
        };
      } catch (err) {
        const msg = toMsg(err);
        const isStepTimeout = err instanceof StepTimeoutError;
        lastError = `step[${i}] (${label}): ${msg}`;
        stepResults[i] = {
          index: i,
          kind: step.kind,
          label,
          ok: false,
          durationMs: isStepTimeout ? maxStepMs : Date.now() - stepStarted,
          error: isStepTimeout ? "timed out" : msg,
        };
        return; // abort on first error — explicit, no continue-on-error
      }
    }
  };

  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimeoutPromise = new Promise<never>((_, reject) => {
    totalTimer = setTimeout(() => reject(new TotalTimeoutError(maxTotalMs)), maxTotalMs);
  });

  try {
    await runWithCredentials(credSnapshot, () =>
      runWithActiveCustomToolIds(activeIds, () =>
        Promise.race([runStepsLoop(), totalTimeoutPromise])
      )
    );
  } catch (err) {
    if (err instanceof TotalTimeoutError) {
      // Find the in-flight step (the last placeholder still marked
      // `error: "in-flight"`) and patch it to `timed out`. If no
      // placeholder is in flight (e.g. the loop hadn't entered yet),
      // we just report the total timeout without a per-step row.
      const inFlight = stepResults.findIndex((s) => s.error === "in-flight");
      let inFlightLabel = "?";
      if (inFlight >= 0) {
        const existing = stepResults[inFlight]!;
        inFlightLabel = existing.label;
        stepResults[inFlight] = {
          ...existing,
          ok: false,
          durationMs: maxTotalMs,
          error: "timed out",
        };
      }
      lastError = `step[${inFlight >= 0 ? inFlight : "?"}] (${inFlightLabel}): ${err.message}`;
    } else {
      // Programmer error inside the inner runners — surface as a
      // run-level failure rather than letting it bubble to the caller.
      lastError = toMsg(err);
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
  }

  // Drop any placeholder rows still marked "in-flight" — only happens
  // if the inner runner was stopped mid-step. The patched row above
  // already replaced the in-flight step the operator cares about.
  for (let i = stepResults.length - 1; i >= 0; i--) {
    if (stepResults[i]?.error === "in-flight") stepResults.splice(i, 1);
  }

  const totalDurationMs = Date.now() - startedAt;
  if (lastError) {
    return {
      ok: false,
      result: lastSaved,
      stepResults,
      totalDurationMs,
      error: lastError,
    };
  }
  return {
    ok: true,
    result: lastFinalText || lastSaved,
    stepResults,
    totalDurationMs,
  };
}

/**
 * Race a promise against a per-step timeout. On timeout, signals the
 * abort controller (best-effort cooperative cancellation — current
 * `ToolDefinition.handler` signature does not accept a signal, but the
 * controller is created anyway so a future widening can propagate it
 * without API churn) and rejects with a `StepTimeoutError`.
 *
 * The underlying `inner` keeps running in the background after a
 * timeout — there's no way to truly cancel a Promise. The Vercel
 * function will reap it on tear-down.
 */
async function withStepTimeout<T>(
  inner: (signal: AbortSignal) => Promise<T>,
  maxStepMs: number
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new StepTimeoutError(maxStepMs));
    }, maxStepMs);
  });
  try {
    return await Promise.race([inner(ctrl.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runStep(
  step: CustomToolStep,
  context: Record<string, unknown>,
  activeIds: Set<string>,
  maxStepMs: number
): Promise<{ saved: unknown; finalText: string }> {
  if (step.kind === "transform") {
    // Transforms are sync but we still race them against the per-step
    // timeout — guards against a pathological Mustache template (huge
    // partial recursion) locking the event loop. In practice the
    // template engine is fast and this race is a no-op.
    return await withStepTimeout(async () => {
      const rendered = renderTemplate(step.template, context);
      return { saved: rendered, finalText: rendered };
    }, maxStepMs);
  }

  // tool step
  // Recursion guard at the lookup site too — defense in depth in case a
  // future code path bypasses the ALS-based guard above (e.g. a manifest
  // wrapper that doesn't go through runWithActiveCustomToolIds).
  if (activeIds.has(step.toolName)) {
    const chain = [...activeIds, step.toolName].join(" → ");
    throw new Error(`recursion detected: ${chain}`);
  }
  const lookup = await findToolByName(step.toolName);
  if (!lookup) {
    throw new Error(`tool "${step.toolName}" is not registered or its connector is disabled`);
  }
  if ("blockedPackId" in lookup) {
    throw new Error(
      `tool "${step.toolName}" is not callable from custom tools (pack "${lookup.blockedPackId}" is not in allowlist)`
    );
  }
  const expanded = expandArgs(step.args, context);
  const argsObj = (expanded ?? {}) as Record<string, unknown>;
  // NB: we intentionally do NOT pass the signal to `handler(argsObj)`.
  // The current `ToolDefinition.handler` signature is single-argument
  // (`Record<string, unknown>`); widening it would touch 80+ tools.
  // The signal is created and the timeout fires correctly — handlers
  // that exceed the budget are abandoned in the background and the
  // step is reported as timed out.
  const result: ToolResult = await withStepTimeout(() => lookup.tool.handler(argsObj), maxStepMs);

  if (result.isError) {
    const errText = toolResultToText(result) || "tool returned isError without a text payload";
    throw new Error(errText);
  }
  const finalText = toolResultToText(result);
  return { saved: finalText, finalText };
}

function toolResultToText(result: ToolResult): string {
  if (!Array.isArray(result.content) || result.content.length === 0) return "";
  return result.content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function previewOf(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s) return "";
  return s.length > PREVIEW_LIMIT ? `${s.slice(0, PREVIEW_LIMIT)}…` : s;
}
