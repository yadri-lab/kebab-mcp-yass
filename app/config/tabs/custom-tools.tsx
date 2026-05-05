"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { toMsg } from "@/core/error-utils";

/**
 * Custom Tools dashboard tab.
 *
 * MVP scope (matches the v0.1 brief):
 *  - List existing Custom Tools (id, description, last updated)
 *  - "+ New custom tool" → drawer with JSON textarea
 *  - In-drawer test runner: provide inputs as JSON, hit "Run test",
 *    see step-by-step results
 *  - Edit (re-opens drawer pre-filled)
 *  - Delete (with confirm)
 *
 * Deliberately excluded from this MVP — captured as TODOs in the Custom
 * Tools rehydrate notes:
 *  - Visual step builder (drag/drop)
 *  - Template autocomplete
 *  - Conditional branching / loops
 *  - Audit log
 */

// ── Types (mirror src/connectors/custom-tools/types.ts) ───────────────

interface CustomToolInputBase {
  name: string;
  description?: string;
  required?: boolean;
}
type CustomToolInput =
  | (CustomToolInputBase & { type: "string" | "number" | "boolean" })
  | (CustomToolInputBase & { type: "enum"; values: string[] });

interface CustomToolStepTool {
  kind: "tool";
  toolName: string;
  args?: Record<string, unknown>;
  saveAs?: string;
}
interface CustomToolStepTransform {
  kind: "transform";
  template: string;
  saveAs: string;
}
type CustomToolStep = CustomToolStepTool | CustomToolStepTransform;

interface CustomTool {
  id: string;
  description: string;
  destructive: boolean;
  inputs: CustomToolInput[];
  steps: CustomToolStep[];
  /** Server-computed cost estimate; missing on tools persisted before Phase 2. */
  estimatedCost?: number;
  createdAt: string;
  updatedAt: string;
}

interface StepRunResult {
  index: number;
  kind: "tool" | "transform";
  label: string;
  ok: boolean;
  durationMs: number;
  preview?: string;
  error?: string;
}
interface RunResult {
  ok: boolean;
  result: string;
  stepResults: StepRunResult[];
  totalDurationMs: number;
  error?: string;
  /** Phase 3 — destructive steps that committed before any later failure. */
  committedSteps?: { index: number; toolName: string }[];
}

/**
 * Phase 3 — telemetry record returned by `/api/admin/custom-tools/:id/runs`.
 * Mirrors RunRecord in src/connectors/custom-tools/runs-store.ts.
 */
interface RunRecord {
  toolId: string;
  ok: boolean;
  totalMs: number;
  stepCount: number;
  error?: string;
  stepResults: {
    index: number;
    kind: "tool" | "transform";
    label: string;
    ok: boolean;
    durationMs: number;
    error?: string;
  }[];
  committedSteps: { index: number; toolName: string }[];
  inputsPreview?: string;
  startedAt: string;
  source: "test" | "mcp";
  tokenIdShort?: string;
}

// ── Sample template shown in an empty drawer ──────────────────────────

const SAMPLE_TOOL = `{
  "id": "todo_add",
  "description": "Add a task to my Obsidian Tasks/Kanban.md kanban",
  "destructive": true,
  "inputs": [
    {
      "name": "task",
      "type": "string",
      "required": true,
      "description": "The task description"
    },
    {
      "name": "due",
      "type": "string",
      "required": false,
      "description": "ISO date YYYY-MM-DD or empty"
    },
    {
      "name": "priority",
      "type": "enum",
      "values": ["high", "med", "low"],
      "required": false,
      "description": "Task priority"
    }
  ],
  "steps": [
    {
      "kind": "tool",
      "toolName": "vault_read",
      "args": { "path": "Tasks/Kanban.md" },
      "saveAs": "kanban"
    },
    {
      "kind": "transform",
      "template": "{{kanban}}\\n- [ ] {{task}}{{#priority}} #{{priority}}{{/priority}}{{#due}} 📅 {{due}}{{/due}}",
      "saveAs": "newKanban"
    },
    {
      "kind": "tool",
      "toolName": "vault_write",
      "args": { "path": "Tasks/Kanban.md", "content": "{{newKanban}}" }
    }
  ]
}`;

// 5-line teaser shown on the empty-state — the most "aha!" lines from
// SAMPLE_TOOL: an input, a tool call that saves its output, and a
// transform that consumes it via {{}}. Just enough to signal the shape
// without making the empty state feel like a wall of code.
const SAMPLE_TOOL_PREVIEW = `"inputs": [{ "name": "task", "type": "string", "required": true }],
"steps": [
  { "kind": "tool", "toolName": "vault_read", "args": { "path": "Tasks/Kanban.md" }, "saveAs": "kanban" },
  { "kind": "transform", "template": "{{kanban}}\\n- [ ] {{task}}", "saveAs": "newKanban" },
  { "kind": "tool", "toolName": "vault_write", "args": { "path": "Tasks/Kanban.md", "content": "{{newKanban}}" } }
]`;

// ── Tab ───────────────────────────────────────────────────────────────

export function CustomToolsTab() {
  const [tools, setTools] = useState<CustomTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState<
    { mode: "new" } | { mode: "edit"; tool: CustomTool } | { mode: "sample" } | null
  >(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Help panel: default open the first time a user lands on this tab. We
  // persist the *collapsed* bit (mirrors the brief's localStorage key) so
  // a missing key reads as "not collapsed yet" → keep the panel open.
  const [helpOpen, setHelpOpen] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("kebab.customtools.help.collapsed");
      if (saved !== null) setHelpOpen(saved !== "1");
    } catch {
      /* localStorage unavailable — keep default (open) */
    }
  }, []);

  const toggleHelp = () => {
    setHelpOpen((v) => {
      const next = !v;
      try {
        // Stored value represents "collapsed": "1" when the panel is closed.
        localStorage.setItem("kebab.customtools.help.collapsed", next ? "0" : "1");
      } catch {
        /* localStorage unavailable — UI state still toggles in-memory */
      }
      return next;
    });
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/custom-tools", { credentials: "include" });
      const data = await res.json();
      if (data.ok) setTools(data.tools || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onDelete = async (id: string) => {
    if (!confirm(`Delete Custom Tool "${id}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        setFlash(`Deleted "${id}"`);
        setTimeout(() => setFlash(null), 2000);
        await reload();
      } else {
        alert(data.error || "Delete failed");
      }
    } catch {
      alert("Network error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Custom Tools</h2>
          <p className="text-sm text-text-dim">
            Define new MCP tools as declarative JSON — paste, test, save.
          </p>
        </div>
        <button
          onClick={() => setDrawer({ mode: "new" })}
          className="text-sm font-medium px-4 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90"
        >
          + New custom tool
        </button>
      </div>

      <div className="border border-border rounded-lg overflow-hidden bg-bg-muted/20">
        <button
          type="button"
          onClick={toggleHelp}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-muted/40 transition-colors"
          aria-expanded={helpOpen}
        >
          <div
            className="w-7 h-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold shrink-0"
            aria-hidden="true"
          >
            ?
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text">How custom tools work</p>
            <p className="text-xs text-text-dim mt-0.5">
              {helpOpen
                ? "Click to collapse."
                : "What a Custom Tool is, the two step kinds, and how variables flow."}
            </p>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className={`text-text-muted shrink-0 transition-transform ${helpOpen ? "rotate-180" : ""}`}
          >
            <path
              d="M3.5 5.25L7 8.75L10.5 5.25"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {helpOpen && (
          <div className="border-t border-border px-4 py-4 text-sm text-text-dim space-y-3 bg-bg/40">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                What it is
              </h4>
              <p>
                A Custom Tool is a JSON-defined sequence of steps that calls existing Kebab tools
                (vault, slack, gmail…) and shapes the result. The composed tool appears as a regular
                MCP tool to your AI clients (Claude, Cursor…).
              </p>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                The two step kinds
              </h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <code className="text-text">tool</code> — invoke another Kebab tool by name. Save
                  its result under <code className="text-text">saveAs</code> to reuse it.
                </li>
                <li>
                  <code className="text-text">transform</code> — render a Mustache template against
                  the running context. Use it to format the final output or restructure intermediate
                  values.
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
                Variables
              </h4>
              <p>
                Use <strong className="text-text-dim">{`{{varName}}`}</strong> to inject inputs or
                saved values from previous steps. Strict Mustache only — no JS.
              </p>
            </div>
          </div>
        )}
      </div>

      {flash && (
        <div className="bg-accent/10 border border-accent/20 rounded-md p-2 text-xs text-accent">
          {flash}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : tools.length === 0 ? (
        <div className="border border-border border-dashed rounded-lg p-8 space-y-4">
          <p className="text-sm text-text-dim text-center">
            No custom tools yet. Here&apos;s what one looks like:
          </p>
          <pre className="bg-bg-muted/60 border border-border rounded-md p-3 font-mono text-xs text-text-muted overflow-x-auto max-w-2xl mx-auto">
            {SAMPLE_TOOL_PREVIEW}
          </pre>
          <div className="flex items-center justify-center gap-2 pt-1">
            <button
              onClick={() => setDrawer({ mode: "sample" })}
              className="text-xs font-medium px-3 py-1.5 border border-border rounded-md text-text-dim hover:text-text hover:bg-bg-muted/40"
            >
              View full sample
            </button>
            <button
              onClick={() => setDrawer({ mode: "new" })}
              className="text-xs font-medium px-3 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90"
            >
              + Create from scratch
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {tools.map((t) => (
            <div
              key={t.id}
              className="border border-border rounded-lg p-4 bg-bg-muted hover:border-border-light transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-sm font-mono font-semibold">{t.id}</code>
                    {t.destructive && (
                      <span className="text-[10px] uppercase tracking-wide bg-red/10 text-red px-1.5 py-0.5 rounded">
                        destructive
                      </span>
                    )}
                    <span className="text-[11px] text-text-muted">
                      {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
                    </span>
                    {typeof t.estimatedCost === "number" && (
                      <span
                        className="text-[10px] tracking-wide bg-bg border border-border text-text-muted px-1.5 py-0.5 rounded"
                        title="Server-estimated cost per run (1–10 points/step depending on pack). Hard cap: 50."
                      >
                        ~{t.estimatedCost}pts cost
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-text-dim mb-1">{t.description}</p>
                  <p className="text-[11px] text-text-muted">
                    Updated {new Date(t.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setDrawer({ mode: "edit", tool: t })}
                    className="text-xs font-medium px-3 py-1 border border-border rounded-md text-text-dim hover:text-text"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(t.id)}
                    className="text-xs font-medium px-3 py-1 border border-red/30 rounded-md text-red hover:bg-red/5"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {drawer && (
        <CustomToolDrawer
          initial={drawer.mode === "edit" ? drawer.tool : null}
          onClose={() => setDrawer(null)}
          onSaved={async () => {
            setDrawer(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────

// ── Phase 5 helpers ───────────────────────────────────────────────────

/**
 * Parsed payload returned by the save API on Zod failure.
 * Mirrors `customToolWriteSchema.safeParse(...).error.issues`.
 */
interface ZodIssue {
  path?: (string | number)[];
  message: string;
}

/**
 * Friendly-message dictionary — substring (or exact) match against the
 * raw Zod message. We surface the friendly variant prominently and keep
 * the raw text in muted small print so technical readers still see what
 * the underlying validator complained about.
 */
const FRIENDLY_MESSAGES: { match: string; friendly: string }[] = [
  {
    match: "id must be a lowercase snake_case slug, max 64 chars",
    friendly:
      "id must be lowercase letters, digits, and underscores only — like `my_tool` or `summarize_inbox`.",
  },
  {
    match: "tool name must be a lowercase slug",
    friendly:
      "step.toolName must be the exact name of an existing Kebab tool — try the 'Available tool names' list above.",
  },
  {
    match: "saveAs must be a valid identifier",
    friendly:
      "saveAs must be a valid variable name (letters, digits, underscores; must start with a letter or _).",
  },
  {
    match: "estimated cost",
    friendly:
      "(see help panel) — reduce step count or replace expensive tools (browser, composio, paywall) with lighter ones.",
  },
];

function friendlyMessageFor(raw: string): string | null {
  for (const entry of FRIENDLY_MESSAGES) {
    if (raw.includes(entry.match)) return entry.friendly;
  }
  return null;
}

/**
 * Best-effort extraction of a position from a JSON.parse error message.
 * V8 emits `... at position 42 ...`; some other runtimes emit
 * `position 42`. We try both and fall back to no-position.
 */
function extractJsonPosition(msg: string): number | null {
  const m = msg.match(/(?:at )?position (\d+)/);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pretty-print a value for the step-result panel: try JSON.parse +
 * re-stringify with indent; on failure return the raw text.
 */
function prettyJsonOrRaw(text: string): string {
  if (!text) return "";
  // Heuristic — only attempt parse if it looks JSON-ish to avoid eating
  // CPU on large free-text previews. Both `{` and `[` first-char are
  // strong signals; everything else passes through.
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return text;
  try {
    const parsed = JSON.parse(t);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Walk a parsed tool definition and pull every `step.toolName` value
 * out, regardless of step kind (we ignore non-tool steps automatically).
 * Used by the unknown-toolname warning.
 */
function extractToolNames(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];
  for (const s of steps) {
    if (s && typeof s === "object" && "kind" in s && (s as { kind?: unknown }).kind === "tool") {
      const tn = (s as { toolName?: unknown }).toolName;
      if (typeof tn === "string" && tn.length > 0) names.push(tn);
    }
  }
  return names;
}

interface RegistryToolNamesResponse {
  ok: boolean;
  names?: string[];
  packs?: { id: string; enabled: boolean; tools: string[] }[];
  error?: string;
}

function CustomToolDrawer({
  initial,
  onClose,
  onSaved,
}: {
  initial: CustomTool | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Strip server-stamped timestamps for the editable JSON.
  const initialJson = initial ? JSON.stringify(stripStamped(initial), null, 2) : SAMPLE_TOOL;

  const [json, setJson] = useState(initialJson);
  const [testInputsJson, setTestInputsJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  // Phase 5 — Zod issues are now rendered as a structured list, not a
  // text blob. We keep the raw `error` field for non-Zod errors (network,
  // generic save crash) and use `issues` for the structured path/message
  // pairs that the save endpoint returns on schema failure.
  const [issues, setIssues] = useState<ZodIssue[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RunResult | null>(null);

  // Phase 5/A — JSON syntax error feedback (separate from save errors).
  const [jsonSyntaxError, setJsonSyntaxError] = useState<string | null>(null);
  // Phase 5/A — transient "✓ Valid JSON" success badge after format.
  const [formatSuccess, setFormatSuccess] = useState<boolean>(false);
  const formatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase 5/B — registry tool names for client-side validation hints.
  const [registry, setRegistry] = useState<RegistryToolNamesResponse | null>(null);
  // Phase 5/B — list of unknown toolNames found in current JSON. Re-
  // computed on Format & validate, on drawer open (after registry loads),
  // and on save attempts.
  const [unknownTools, setUnknownTools] = useState<string[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Phase 5/G — dry-run checkbox. Default-on iff the current JSON parses
  // and declares `destructive: true`. Recomputed when the JSON changes
  // (cheap parse, only on edits) AND on first mount. The user can flip
  // either way; we don't auto-uncheck once they've manually toggled.
  const [dryRun, setDryRun] = useState<boolean>(() => {
    try {
      const parsed = JSON.parse(initialJson);
      return parsed && typeof parsed === "object" && parsed.destructive === true;
    } catch {
      return false;
    }
  });
  // Track whether the user has manually overridden the auto-default. If
  // they have, we stop force-syncing the checkbox to the destructive flag
  // on subsequent JSON edits — their explicit choice wins.
  const userTouchedDryRun = useRef<boolean>(false);

  // ── A: Parse helper, exposed for save/test/format ─────────────────
  const parseJson = useCallback(():
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; err: string; position?: number } => {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, err: "Tool definition must be a JSON object" };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (err) {
      const msg = toMsg(err);
      const position = extractJsonPosition(msg);
      return position !== null ? { ok: false, err: msg, position } : { ok: false, err: msg };
    }
  }, [json]);

  // ── B: Load registry tool names on mount ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/registry/tool-names", { credentials: "include" });
        const data = (await res.json()) as RegistryToolNamesResponse;
        if (!cancelled && data.ok) setRegistry(data);
      } catch {
        // Non-fatal — the unknown-tool warning just won't fire.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recompute unknown tool names whenever the registry resolves and on
  // first JSON parse. We do NOT recompute on every keystroke (would
  // flicker the warning); the user gets a fresh check via Format &
  // validate or save.
  const recomputeUnknownTools = useCallback(() => {
    if (!registry?.names) return;
    const parsed = parseJson();
    if (!parsed.ok) {
      setUnknownTools([]);
      return;
    }
    const known = new Set(registry.names);
    const unknown = extractToolNames(parsed.value).filter((n) => !known.has(n));
    // Dedupe in display order so the warning copy is stable.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const n of unknown) {
      if (seen.has(n)) continue;
      seen.add(n);
      deduped.push(n);
    }
    setUnknownTools(deduped);
  }, [registry?.names, parseJson]);

  // First scan when the registry list arrives.
  useEffect(() => {
    if (registry?.names) recomputeUnknownTools();
  }, [registry?.names, recomputeUnknownTools]);

  // Sync dry-run default to the parsed `destructive` flag — but only
  // until the user manually flips it. After that, their choice is
  // sticky for the lifetime of the drawer.
  useEffect(() => {
    if (userTouchedDryRun.current) return;
    try {
      const parsed = JSON.parse(json);
      const next = parsed && typeof parsed === "object" && parsed.destructive === true;
      setDryRun(next);
    } catch {
      /* invalid JSON — leave previous value */
    }
  }, [json]);

  // Cleanup the format-success timer on unmount.
  useEffect(() => {
    return () => {
      if (formatTimer.current) clearTimeout(formatTimer.current);
    };
  }, []);

  // ── A: Format & validate ──────────────────────────────────────────
  const formatAndValidate = useCallback(() => {
    setJsonSyntaxError(null);
    setFormatSuccess(false);
    const parsed = parseJson();
    if (!parsed.ok) {
      const positionHint = parsed.position !== undefined ? ` (at position ${parsed.position})` : "";
      setJsonSyntaxError(`JSON syntax error: ${parsed.err}${positionHint}`);
      return;
    }
    // Reformat in place — preserves user intent (no key reordering, no
    // schema coercion; we use the parsed object verbatim).
    setJson(JSON.stringify(parsed.value, null, 2));
    setFormatSuccess(true);
    if (formatTimer.current) clearTimeout(formatTimer.current);
    formatTimer.current = setTimeout(() => setFormatSuccess(false), 3000);
    // Re-scan for unknown tool names against the freshly-parsed payload.
    if (registry?.names) {
      const known = new Set(registry.names);
      const unknown = extractToolNames(parsed.value).filter((n) => !known.has(n));
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const n of unknown) {
        if (seen.has(n)) continue;
        seen.add(n);
        deduped.push(n);
      }
      setUnknownTools(deduped);
    }
  }, [parseJson, registry?.names]);

  const save = async () => {
    setError(null);
    setIssues(null);
    const parsed = parseJson();
    if (!parsed.ok) {
      setJsonSyntaxError(`JSON syntax error: ${parsed.err}`);
      return;
    }
    setSaving(true);
    try {
      const isEdit = !!initial;
      const url = isEdit
        ? `/api/admin/custom-tools/${encodeURIComponent(initial!.id)}`
        : "/api/admin/custom-tools";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(parsed.value),
      });
      const data = await res.json();
      if (!data.ok) {
        if (Array.isArray(data.issues)) {
          setIssues(data.issues as ZodIssue[]);
          setError(data.error || "Validation failed");
        } else {
          setError(data.error || "Save failed");
        }
      } else {
        onSaved();
      }
    } catch {
      setError("Network error");
    }
    setSaving(false);
  };

  const runTest = async () => {
    setError(null);
    setIssues(null);
    setTestResult(null);
    const parsed = parseJson();
    if (!parsed.ok) {
      setJsonSyntaxError(`JSON syntax error: ${parsed.err}`);
      return;
    }

    let inputs: Record<string, unknown> = {};
    if (testInputsJson.trim()) {
      try {
        const parsedInputs = JSON.parse(testInputsJson);
        if (
          typeof parsedInputs !== "object" ||
          parsedInputs === null ||
          Array.isArray(parsedInputs)
        ) {
          setError("Test inputs must be a JSON object");
          return;
        }
        inputs = parsedInputs as Record<string, unknown>;
      } catch (err) {
        setError(`Invalid test inputs JSON: ${toMsg(err)}`);
        return;
      }
    }

    // Test runner needs a persisted tool — for unsaved drafts we save to a
    // temporary id, run, then delete. For an existing tool we run directly.
    setTesting(true);
    try {
      const id = (parsed.value as { id?: string }).id;
      if (!id) {
        setError('Test requires a valid "id" in the tool JSON');
        setTesting(false);
        return;
      }

      // Phase 5/G — body now also carries `dryRun`. The server defaults
      // to false when omitted, but we always pass the explicit boolean
      // so the wire format is unambiguous in proxy logs.
      const testBody = JSON.stringify({ inputs, dryRun });

      // If editing an existing tool with the same id, just run it (the
      // saved version on disk wins). Otherwise stage a temporary tool
      // under a __test__ prefix, run, then delete — so the user gets a
      // real end-to-end exercise of the runner without having to commit.
      if (initial && initial.id === id) {
        const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(id)}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: testBody,
        });
        const data = (await res.json()) as RunResult;
        setTestResult(data);
      } else {
        // HI-01 — tempId must start with [a-z] to satisfy
        // customToolIdPattern (`/^[a-z][a-z0-9_]{0,63}$/`). The `t__test_`
        // prefix gives us a deterministic-looking marker (`t__test_*`)
        // while still parsing as a valid id. Length budget: 7 (prefix) +
        // 32 (id slice) + 1 (underscore) + 13 (Date.now base36, e.g.
        // `lpr5w8q1a4`) = 53 chars, comfortably under the 64-char cap.
        const tempId = `t__test_${id.slice(0, 32)}_${Date.now().toString(36)}`;
        const tempPayload = { ...(parsed.value as Record<string, unknown>), id: tempId };
        const create = await fetch("/api/admin/custom-tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(tempPayload),
        });
        const created = await create.json();
        if (!created.ok) {
          setError(created.error || "Failed to stage test tool");
          setTesting(false);
          return;
        }
        try {
          const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(tempId)}/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: testBody,
          });
          const data = (await res.json()) as RunResult;
          setTestResult(data);
        } finally {
          // Best-effort cleanup; ignore errors so a 5xx on delete doesn't
          // mask the test result the user actually wants to see.
          await fetch(`/api/admin/custom-tools/${encodeURIComponent(tempId)}`, {
            method: "DELETE",
            credentials: "include",
          }).catch(() => undefined);
        }
      }
    } catch (err) {
      setError(`Network error: ${toMsg(err)}`);
    }
    setTesting(false);
  };

  // Convenience for the issue list "→ jump to JSON" buttons. We don't
  // map paths to character offsets (would require a JSON-with-locations
  // parser); just focusing the textarea is already a UX improvement
  // over the unfocused error blob.
  const jumpToJson = () => {
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-end">
      <div className="bg-bg border-l border-border w-full max-w-3xl h-full overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg">
            {initial ? `Edit "${initial.id}"` : "New Custom Tool"}
          </h3>
          <button onClick={onClose} className="text-sm text-text-dim hover:text-text">
            Close
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1.5">
              Tool definition <span className="text-text-muted text-xs font-normal">(JSON)</span>
            </label>
            <textarea
              ref={textareaRef}
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                // Clearing transient feedback as the user edits keeps the
                // UI honest — a stale "✓ Valid JSON" badge after edits
                // would mislead.
                if (jsonSyntaxError) setJsonSyntaxError(null);
                if (formatSuccess) setFormatSuccess(false);
              }}
              rows={20}
              spellCheck={false}
              className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
            />
          </div>

          {/* C: Available tool names hint — collapsed by default to keep
              the composer dense, but right next to the textarea so the
              author can copy-paste quickly. */}
          {registry?.packs && registry.packs.length > 0 && (
            <details className="border border-border rounded-md overflow-hidden">
              <summary className="px-3 py-2 bg-bg-muted cursor-pointer text-xs font-medium text-text-dim">
                Available tool names ({registry.names?.length ?? 0})
              </summary>
              <div className="p-3 space-y-2 text-xs">
                <p className="text-text-muted">
                  Click a name to copy. Disabled packs are listed but their tools cannot run.
                </p>
                {registry.packs.map((p) => (
                  <div key={p.id}>
                    <div className="flex items-center gap-2 mb-1">
                      <code className="font-mono font-semibold text-text">{p.id}</code>
                      {!p.enabled && (
                        <span className="text-[10px] uppercase tracking-wide bg-bg-muted text-text-muted px-1.5 py-0.5 rounded border border-border">
                          disabled
                        </span>
                      )}
                      <span className="text-text-muted">
                        {p.tools.length} tool{p.tools.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 pl-2">
                      {p.tools.length === 0 ? (
                        <span className="text-text-muted italic">no tools</span>
                      ) : (
                        p.tools.map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => {
                              // Best-effort copy — silently no-op when the
                              // browser blocks clipboard access (insecure
                              // origin, missing permission). The button
                              // always visually flashes regardless.
                              try {
                                void navigator.clipboard?.writeText(t);
                              } catch {
                                /* ignore */
                              }
                            }}
                            title={`Copy "${t}"`}
                            className="font-mono text-[11px] px-1.5 py-0.5 bg-bg border border-border rounded hover:border-accent hover:text-accent text-text-dim"
                          >
                            {t}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* A/B: action row + JSON feedback */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={formatAndValidate}
              type="button"
              className="text-xs font-medium px-3 py-1.5 border border-border rounded-md text-text-dim hover:text-text hover:border-accent"
            >
              Format & validate
            </button>
            {formatSuccess && (
              <span className="text-xs text-accent" role="status" aria-live="polite">
                ✓ Valid JSON
              </span>
            )}
          </div>

          {jsonSyntaxError && (
            <div className="bg-red/10 border border-red/20 rounded-md p-2 text-xs text-red font-mono">
              {jsonSyntaxError}
            </div>
          )}

          {unknownTools.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-2 text-xs text-amber-700 dark:text-amber-400">
              ⚠ Unknown tool name{unknownTools.length === 1 ? "" : "s"}:{" "}
              <code className="font-mono">{unknownTools.join(", ")}</code> — the server may reject
              save. Browse the &quot;Available tool names&quot; list above.
            </div>
          )}

          {/* D: Structured Zod issues list */}
          {issues && issues.length > 0 && (
            <div className="bg-red/10 border border-red/20 rounded-md p-3 space-y-2">
              <p className="text-xs font-medium text-red">
                {error ?? "Validation failed"} — {issues.length} issue
                {issues.length === 1 ? "" : "s"}:
              </p>
              <ul className="space-y-1.5">
                {issues.map((iss, idx) => {
                  const path = (iss.path ?? []).join(".");
                  const friendly = friendlyMessageFor(iss.message);
                  return (
                    <li key={`${path}-${idx}`} className="text-xs flex items-start gap-2 group">
                      <button
                        type="button"
                        onClick={jumpToJson}
                        title="Focus the JSON editor"
                        className="text-text-muted hover:text-accent shrink-0 font-mono"
                      >
                        →
                      </button>
                      <div className="min-w-0 flex-1">
                        {path && (
                          <code className="font-mono font-bold text-text block break-all">
                            {path}
                          </code>
                        )}
                        <span className="text-text-dim">{friendly ?? iss.message}</span>
                        {friendly && (
                          <span className="block text-[10px] text-text-muted mt-0.5 font-mono">
                            ({iss.message})
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Generic non-Zod errors */}
          {error && !issues && (
            <div className="bg-red/10 border border-red/20 rounded-md p-3 text-xs text-red font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}

          {/* Action row: Save / Cancel anchored at top so it's reachable
              even on long JSON bodies. Run-test moved into the (now
              always-open) test runner below. */}
          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <button
              onClick={save}
              disabled={saving}
              className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : initial ? "Save changes" : "Create tool"}
            </button>
            <button
              onClick={onClose}
              className="text-sm font-medium px-4 py-1.5 rounded-md bg-bg-muted hover:bg-border-light text-text-dim"
            >
              Cancel
            </button>
          </div>

          {/* E: Test runner — open by default, no <details> wrapper. */}
          <div className="border border-border rounded-md p-3 space-y-3">
            <h3 className="text-sm font-semibold">Test runner</h3>
            <div>
              <label className="text-xs font-medium block mb-1">
                Test inputs <span className="text-text-muted">(JSON object)</span>
              </label>
              <textarea
                value={testInputsJson}
                onChange={(e) => setTestInputsJson(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder='{"task": "Buy milk", "priority": "high"}'
                className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
              />
            </div>

            {/* G: Dry-run toggle — sits above Run test so it's the last
                thing the operator sees before clicking. */}
            <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => {
                  userTouchedDryRun.current = true;
                  setDryRun(e.target.checked);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-text">
                  Dry-run (skip destructive steps, return mocked output)
                </span>
                <span className="block text-[11px] text-text-muted">
                  Read-only tools and transforms still execute.
                </span>
              </span>
            </label>

            <button
              onClick={runTest}
              disabled={testing}
              className="text-xs font-medium px-3 py-1.5 bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50"
            >
              {testing ? "Running…" : dryRun ? "Run test (dry-run)" : "Run test"}
            </button>

            {testResult && <TestResultPanel result={testResult} />}
          </div>

          {initial && <RecentRunsSection toolId={initial.id} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 5 — extracted result panel so the drawer body stays scannable.
 *
 * Each step row shows status, label, duration, then a pretty-printed
 * preview (JSON.parse → JSON.stringify(..., 2) when possible, raw text
 * otherwise). The full final-result blob lives in a nested <details>
 * because it can get large.
 */
function TestResultPanel({ result }: { result: RunResult }) {
  // Detect dry-run from the per-step payload — the server stamps the
  // `[dry-run skipped]` sentinel on the runner side, so we recognize it
  // verbatim. Used purely for an unobtrusive header pill.
  const isDryRun = useMemo(
    () => result.stepResults.some((s) => s.preview === "[dry-run skipped]"),
    [result.stepResults]
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium">
        <span className={result.ok ? "text-accent" : "text-red"}>
          {result.ok ? "✓ ok" : "✗ failed"}
        </span>
        <span className="text-text-muted">— {result.totalDurationMs}ms</span>
        {isDryRun && (
          <span className="text-[10px] uppercase tracking-wide bg-bg-muted text-text-muted px-1.5 py-0.5 rounded border border-border">
            dry-run
          </span>
        )}
        {result.error && <span className="text-red">— {result.error}</span>}
      </div>
      <div className="space-y-1">
        {result.stepResults.map((s) => (
          <StepRow key={s.index} step={s} />
        ))}
      </div>
      {result.ok && (
        <details className="bg-bg-muted border border-border rounded-md overflow-hidden">
          <summary className="px-2 py-1.5 cursor-pointer text-[11px] font-medium text-text-dim">
            Final result
          </summary>
          <pre className="border-t border-border p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto">
            {prettyJsonOrRaw(result.result)}
          </pre>
        </details>
      )}
    </div>
  );
}

function StepRow({ step: s }: { step: StepRunResult }) {
  return (
    <div
      className={`text-[11px] font-mono px-2 py-1 rounded ${
        s.ok ? "bg-bg-muted text-text-dim" : "bg-red/10 text-red"
      }`}
    >
      <div>
        {s.ok ? "✓" : "✗"} step[{s.index}] {s.kind}:{s.label} — {s.durationMs}ms
      </div>
      {s.preview && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-text-muted">
          {prettyJsonOrRaw(s.preview)}
        </pre>
      )}
      {s.error && <pre className="mt-1 whitespace-pre-wrap break-words">{s.error}</pre>}
    </div>
  );
}

function stripStamped(t: CustomTool): Omit<CustomTool, "createdAt" | "updatedAt"> {
  const { createdAt: _c, updatedAt: _u, ...rest } = t;
  void _c;
  void _u;
  return rest;
}

// ── Recent runs (Phase 3) ─────────────────────────────────────────────

/**
 * Lazy-loaded "Recent runs" section in the edit drawer.
 *
 * Lazy because the run history list is bounded but extra work — we
 * don't fetch it until the operator expands the section. Also
 * intentionally only mounted for SAVED tools (the parent drawer guards
 * with `initial && <RecentRunsSection />`); a draft has no id to query
 * runs for.
 *
 * Empty state mirrors the rest of the dashboard ("border-dashed,
 * text-text-dim"). Failed runs with `committedSteps` get a warning
 * line so operators see what landed before the crash and can decide
 * whether to manually roll back.
 */
function RecentRunsSection({ toolId }: { toolId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/custom-tools/${encodeURIComponent(toolId)}/runs?limit=20`,
        { credentials: "include" }
      );
      const data = await res.json();
      if (!data.ok) {
        setErr(data.error || "Failed to load runs");
        setRuns(null);
      } else {
        setRuns(Array.isArray(data.runs) ? data.runs : []);
      }
    } catch (e) {
      setErr(toMsg(e));
      setRuns(null);
    } finally {
      setLoading(false);
    }
  }, [toolId]);

  return (
    <details
      className="border border-border rounded-md overflow-hidden"
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        setOpen(next);
        if (next && runs === null && !loading) {
          // fire-and-forget OK: lazy-load on expand; load() owns its own error/loading state via setErr/setLoading
          void load();
        }
      }}
    >
      <summary className="px-3 py-2 bg-bg-muted cursor-pointer text-sm font-medium flex items-center justify-between">
        <span>Recent runs (last 24h)</span>
        {open && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // fire-and-forget OK: refresh button click; load() owns its own error/loading state
              void load();
            }}
            className="text-[11px] text-text-dim hover:text-text font-normal"
          >
            Refresh
          </button>
        )}
      </summary>
      <div className="p-3 space-y-2">
        {loading && <p className="text-xs text-text-dim">Loading…</p>}
        {err && (
          <p className="text-xs text-red bg-red/10 border border-red/20 rounded p-2 font-mono">
            {err}
          </p>
        )}
        {!loading && !err && runs !== null && runs.length === 0 && (
          <p className="text-xs text-text-dim">No runs in the last 24h.</p>
        )}
        {!loading && !err && runs !== null && runs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted border-b border-border">
                  <th className="font-medium py-1.5 pr-3">Time</th>
                  <th className="font-medium py-1.5 pr-3">Status</th>
                  <th className="font-medium py-1.5 pr-3">Duration</th>
                  <th className="font-medium py-1.5 pr-3">Source</th>
                  <th className="font-medium py-1.5">Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, idx) => (
                  <RunRow key={`${r.startedAt}-${idx}`} run={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

function RunRow({ run }: { run: RunRecord }) {
  const hasCommitted = !run.ok && run.committedSteps && run.committedSteps.length > 0;
  return (
    <>
      <tr className="border-b border-border/50">
        <td className="py-1.5 pr-3 font-mono text-text-dim whitespace-nowrap">
          {formatRelative(run.startedAt)}
        </td>
        <td className="py-1.5 pr-3">
          <span
            className={`text-[11px] font-mono ${run.ok ? "text-accent" : "text-red"}`}
            title={run.ok ? "Run succeeded" : "Run failed"}
          >
            {run.ok ? "✓ ok" : "✗ failed"}
          </span>
        </td>
        <td className="py-1.5 pr-3 font-mono text-text-dim whitespace-nowrap">{run.totalMs}ms</td>
        <td className="py-1.5 pr-3 font-mono text-text-muted">{run.source}</td>
        <td
          className="py-1.5 font-mono text-text-dim max-w-[24rem] truncate"
          title={run.error || ""}
        >
          {run.error ?? ""}
        </td>
      </tr>
      {hasCommitted && (
        <tr className="border-b border-border/50">
          <td colSpan={5} className="py-1.5 pr-3">
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              ⚠ {run.committedSteps.length} step
              {run.committedSteps.length === 1 ? "" : "s"} committed before failure:{" "}
              <code className="font-mono">
                {run.committedSteps.map((s) => s.toolName).join(", ")}
              </code>{" "}
              — manual rollback may be required.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Render an ISO timestamp as a short "Nm ago" / "Nh ago" string.
 * Falls back to the local time for anything older than 24h (the TTL
 * cap, but a clock skew or a freshly-deployed instance might still
 * surface older entries).
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(t).toLocaleString();
}
