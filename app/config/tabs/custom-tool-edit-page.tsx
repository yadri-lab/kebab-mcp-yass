"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toMsg } from "@/core/error-utils";

/**
 * Custom Tool dedicated edit page (Phase 6).
 *
 * Replaces the slide-in drawer. Pattern aligned with `skill-edit-page.tsx`:
 * a full-page view rendered when `?tab=custom-tools&edit=<id>` is in the
 * URL. Bookmarkable, sharable, no modal trapping the operator's focus.
 *
 * Contains every Phase 4 / Phase 5 affordance the drawer carried:
 *  - JSON composer with Format & validate, registry-aware unknown-tool
 *    warnings, friendly Zod issue rendering, autocomplete hint panel
 *  - Test runner (always-open, dry-run toggle wired to the destructive
 *    flag, step result panel with pretty-printed previews)
 *  - Recent runs (lazy-loaded, last 24h)
 *
 * NEW in Phase 6: a History section showing prior versions (newest
 * first, capped at 10) with View (modal of full JSON) and Rollback
 * actions. The active page reloads on rollback so every cached piece of
 * state (test result, recent runs) re-fetches against the restored tool.
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
  committedSteps?: { index: number; toolName: string }[];
}

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

interface CustomToolVersion {
  tool: CustomTool;
  supersededAt: string;
  supersededBy?: { tokenIdShort?: string };
}

interface ZodIssue {
  path?: (string | number)[];
  message: string;
}

interface RegistryToolNamesResponse {
  ok: boolean;
  names?: string[];
  packs?: { id: string; enabled: boolean; tools: string[] }[];
  error?: string;
}

// ── Sample (used when ?edit=__new__) ──────────────────────────────────

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

// ── Helpers (preserved from the drawer) ───────────────────────────────

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

function extractJsonPosition(msg: string): number | null {
  const m = msg.match(/(?:at )?position (\d+)/);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function prettyJsonOrRaw(text: string): string {
  if (!text) return "";
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return text;
  try {
    const parsed = JSON.parse(t);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

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

function stripStamped(t: CustomTool): Omit<CustomTool, "createdAt" | "updatedAt"> {
  const { createdAt: _c, updatedAt: _u, ...rest } = t;
  void _c;
  void _u;
  return rest;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(t).toLocaleString();
}

// ── Page ──────────────────────────────────────────────────────────────

export function CustomToolEditPage({ toolId }: { toolId: string }) {
  const router = useRouter();
  const isNew = toolId === "__new__";

  const [loading, setLoading] = useState(!isNew);
  const [notFound, setNotFound] = useState(false);
  const [initial, setInitial] = useState<CustomTool | null>(null);

  // JSON composer state.
  const [json, setJson] = useState<string>(isNew ? SAMPLE_TOOL : "");
  const [testInputsJson, setTestInputsJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ZodIssue[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RunResult | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [jsonSyntaxError, setJsonSyntaxError] = useState<string | null>(null);
  const [formatSuccess, setFormatSuccess] = useState<boolean>(false);
  const formatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [registry, setRegistry] = useState<RegistryToolNamesResponse | null>(null);
  const [unknownTools, setUnknownTools] = useState<string[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Dry-run defaults to ON when the parsed JSON declares destructive: true,
  // until the user manually toggles it (then their choice is sticky).
  const [dryRun, setDryRun] = useState<boolean>(() => {
    if (isNew) {
      try {
        const parsed = JSON.parse(SAMPLE_TOOL);
        return parsed && typeof parsed === "object" && parsed.destructive === true;
      } catch {
        return false;
      }
    }
    return false;
  });
  const userTouchedDryRun = useRef<boolean>(false);

  // Versioning.
  const [versions, setVersions] = useState<CustomToolVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [viewVersion, setViewVersion] = useState<CustomToolVersion | null>(null);

  // ── Load the tool ────────────────────────────────────────────────
  const loadTool = useCallback(async () => {
    if (isNew) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(toolId)}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok && data.tool) {
        setInitial(data.tool);
        setJson(JSON.stringify(stripStamped(data.tool), null, 2));
        // Sync dry-run default unless the user has flipped it.
        if (!userTouchedDryRun.current) setDryRun(!!data.tool.destructive);
      } else {
        setNotFound(true);
      }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [isNew, toolId]);

  const loadVersions = useCallback(async () => {
    if (isNew) return;
    setVersionsLoading(true);
    try {
      const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(toolId)}/versions`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) setVersions(data.versions || []);
      else setVersions([]);
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }, [isNew, toolId]);

  useEffect(() => {
    loadTool();
    loadVersions();
  }, [loadTool, loadVersions]);

  // ── Registry tool-names hint ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/registry/tool-names", { credentials: "include" });
        const data = (await res.json()) as RegistryToolNamesResponse;
        if (!cancelled && data.ok) setRegistry(data);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── JSON parsing & format ────────────────────────────────────────
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

  const recomputeUnknownTools = useCallback(() => {
    if (!registry?.names) return;
    const parsed = parseJson();
    if (!parsed.ok) {
      setUnknownTools([]);
      return;
    }
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
  }, [registry?.names, parseJson]);

  useEffect(() => {
    if (registry?.names) recomputeUnknownTools();
  }, [registry?.names, recomputeUnknownTools]);

  // Sync dry-run default to the parsed `destructive` flag (unless user-touched).
  useEffect(() => {
    if (userTouchedDryRun.current) return;
    try {
      const parsed = JSON.parse(json);
      const next = parsed && typeof parsed === "object" && parsed.destructive === true;
      setDryRun(next);
    } catch {
      /* leave as-is */
    }
  }, [json]);

  useEffect(() => {
    return () => {
      if (formatTimer.current) clearTimeout(formatTimer.current);
    };
  }, []);

  const formatAndValidate = useCallback(() => {
    setJsonSyntaxError(null);
    setFormatSuccess(false);
    const parsed = parseJson();
    if (!parsed.ok) {
      const positionHint = parsed.position !== undefined ? ` (at position ${parsed.position})` : "";
      setJsonSyntaxError(`JSON syntax error: ${parsed.err}${positionHint}`);
      return;
    }
    setJson(JSON.stringify(parsed.value, null, 2));
    setFormatSuccess(true);
    if (formatTimer.current) clearTimeout(formatTimer.current);
    formatTimer.current = setTimeout(() => setFormatSuccess(false), 3000);
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

  const goBack = () => {
    router.push("/config?tab=custom-tools");
  };

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
      const isEdit = !isNew && !!initial;
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
        if (isNew && data.tool?.id) {
          // Move from draft mode to edit mode in-place — the URL becomes
          // bookmarkable for this just-created tool.
          router.push(`/config?tab=custom-tools&edit=${encodeURIComponent(data.tool.id)}`);
        } else {
          setFlash("Saved");
          setTimeout(() => setFlash(null), 2000);
          await loadTool();
          await loadVersions();
        }
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

    setTesting(true);
    try {
      const id = (parsed.value as { id?: string }).id;
      if (!id) {
        setError('Test requires a valid "id" in the tool JSON');
        setTesting(false);
        return;
      }

      const testBody = JSON.stringify({ inputs, dryRun });

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

  const jumpToJson = () => {
    textareaRef.current?.focus();
    textareaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const onDelete = async () => {
    if (!initial) return;
    if (!confirm(`Delete Custom Tool "${initial.id}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(initial.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (data.ok) {
        router.push("/config?tab=custom-tools");
      } else {
        alert(data.error || "Delete failed");
      }
    } catch {
      alert("Network error");
    }
  };

  const rollback = async (versionIndex: number) => {
    const target = versions[versionIndex];
    if (!target) return;
    const when = new Date(target.supersededAt).toLocaleString();
    if (
      !confirm(
        `Rollback to version from ${when}? Current state will be saved as a new version, so this is undoable.`
      )
    )
      return;
    setRollingBack(true);
    try {
      const res = await fetch(`/api/admin/custom-tools/${encodeURIComponent(toolId)}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ versionIndex }),
      });
      const data = await res.json();
      if (data.ok) {
        setFlash("Rolled back");
        setTimeout(() => setFlash(null), 2000);
        await loadTool();
        await loadVersions();
      } else {
        alert(data.error || "Rollback failed");
      }
    } catch {
      alert("Network error");
    }
    setRollingBack(false);
  };

  // ── 404 inline ───────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className="space-y-3">
        <nav className="text-xs text-text-muted">
          <button onClick={goBack} className="hover:text-text">
            Custom Tools
          </button>
          <span className="text-text-muted/60 mx-1.5">/</span>
          <span className="text-text-dim">{toolId}</span>
        </nav>
        <div className="border border-border border-dashed rounded-lg p-8 text-center">
          <p className="text-sm text-text-dim">
            Custom Tool <code className="font-mono">{toolId}</code> doesn&apos;t exist.
          </p>
          <button
            type="button"
            onClick={goBack}
            className="mt-3 text-xs font-medium text-accent hover:underline px-3 py-1.5 border border-accent/20 rounded-md"
          >
            ← Back to Custom Tools
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-text-muted p-8">Loading custom tool...</p>;
  }

  const breadcrumbName = isNew ? "New custom tool" : (initial?.id ?? toolId);

  return (
    <div className="space-y-4">
      <div>
        <nav
          className="flex items-center gap-1.5 text-xs text-text-muted mb-2"
          aria-label="Breadcrumb"
        >
          <button type="button" onClick={goBack} className="hover:text-text transition-colors">
            ← Custom Tools
          </button>
          <span className="text-text-muted/60">/</span>
          <span className="text-text-dim font-medium truncate max-w-[280px]">{breadcrumbName}</span>
          {!isNew && (
            <>
              <span className="text-text-muted/60">/</span>
              <span className="text-text-dim">Edit</span>
            </>
          )}
        </nav>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">
              {isNew ? "Create a new custom tool" : (initial?.id ?? "Edit custom tool")}
            </h1>
            <p className="text-xs text-text-dim mt-0.5">
              {isNew
                ? "Define a declarative composition of existing Kebab tools — exposed as a first-class MCP tool."
                : initial?.description || "No description"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {flash && (
              <span className="text-[11px] font-medium text-green bg-green-bg px-2 py-0.5 rounded-full">
                {flash}
              </span>
            )}
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="bg-accent text-white text-xs font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : isNew ? "Create" : "Save"}
            </button>
            <button
              type="button"
              onClick={goBack}
              className="text-xs font-medium text-text-dim hover:text-text px-3 py-1.5 border border-border rounded-md"
            >
              Back
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {/* Composer */}
        <section className="space-y-3">
          <label className="text-sm font-medium block">
            Tool definition <span className="text-text-muted text-xs font-normal">(JSON)</span>
          </label>
          <textarea
            ref={textareaRef}
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              if (jsonSyntaxError) setJsonSyntaxError(null);
              if (formatSuccess) setFormatSuccess(false);
            }}
            rows={20}
            spellCheck={false}
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
          />

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

          {error && !issues && (
            <div className="bg-red/10 border border-red/20 rounded-md p-3 text-xs text-red font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}
        </section>

        {/* Test runner */}
        <section className="border border-border rounded-md p-3 space-y-3">
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
        </section>

        {/* History (Phase 6) */}
        {!isNew && (
          <HistorySection
            versions={versions}
            loading={versionsLoading}
            rollingBack={rollingBack}
            onRollback={rollback}
            onView={(v) => setViewVersion(v)}
          />
        )}

        {/* Recent runs (Phase 3) */}
        {!isNew && initial && <RecentRunsSection toolId={initial.id} />}

        {/* Danger zone */}
        {!isNew && initial && (
          <section className="border border-red/30 rounded-lg bg-red-bg/30 p-5 space-y-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-red">
                Danger zone
              </h3>
              <p className="text-xs text-text-dim mt-0.5">
                Deleting a Custom Tool removes it from the MCP registry and wipes its version
                history. This cannot be undone.
              </p>
            </div>
            <button
              type="button"
              onClick={onDelete}
              className="text-xs font-medium text-red hover:underline"
            >
              Delete this tool
            </button>
          </section>
        )}
      </div>

      {viewVersion && (
        <VersionViewModal version={viewVersion} onClose={() => setViewVersion(null)} />
      )}
    </div>
  );
}

// ── History section ───────────────────────────────────────────────────

function HistorySection({
  versions,
  loading,
  rollingBack,
  onRollback,
  onView,
}: {
  versions: CustomToolVersion[];
  loading: boolean;
  rollingBack: boolean;
  onRollback: (versionIndex: number) => void;
  onView: (v: CustomToolVersion) => void;
}) {
  return (
    <section className="border border-border rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-bg-muted text-sm font-semibold flex items-center justify-between">
        <span>History</span>
        <span className="text-[11px] font-normal text-text-muted">
          {versions.length === 0
            ? "no prior versions"
            : `${versions.length} prior version${versions.length === 1 ? "" : "s"} (cap 10)`}
        </span>
      </div>
      <div className="p-3">
        {loading ? (
          <p className="text-xs text-text-dim">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="text-xs text-text-muted">No previous versions yet.</p>
        ) : (
          <div className="space-y-1.5">
            {versions.map((v, idx) => (
              <div
                key={`${v.supersededAt}-${idx}`}
                className="flex items-center gap-3 text-xs border border-border rounded-md px-3 py-2"
              >
                <span className="text-text-muted shrink-0 font-mono">
                  {new Date(v.supersededAt).toLocaleString()}
                </span>
                <span className="text-text-dim">·</span>
                <span
                  className={`font-mono shrink-0 ${
                    v.tool.destructive ? "text-red" : "text-text-muted"
                  }`}
                >
                  destructive: {v.tool.destructive ? "true" : "false"}
                </span>
                <span className="text-text-dim">·</span>
                <span className="text-text-muted shrink-0">
                  {v.tool.steps.length} step{v.tool.steps.length === 1 ? "" : "s"}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onView(v)}
                  className="text-xs text-text-dim hover:text-text shrink-0"
                >
                  View
                </button>
                <button
                  type="button"
                  onClick={() => onRollback(idx)}
                  disabled={rollingBack}
                  className="text-xs text-orange hover:underline shrink-0 disabled:opacity-50"
                >
                  Rollback
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function VersionViewModal({
  version,
  onClose,
}: {
  version: CustomToolVersion;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-bg border border-border rounded-lg max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Version snapshot"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h3 className="text-sm font-semibold">Version snapshot</h3>
            <p className="text-[11px] text-text-muted">
              Replaced {new Date(version.supersededAt).toLocaleString()} · read-only
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-sm text-text-dim hover:text-text"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono whitespace-pre-wrap break-words bg-bg-muted/40">
          {JSON.stringify(stripStamped(version.tool), null, 2)}
        </pre>
      </div>
    </div>
  );
}

// ── Test result + Recent runs (preserved verbatim from drawer) ────────

function TestResultPanel({ result }: { result: RunResult }) {
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
