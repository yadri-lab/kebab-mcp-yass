"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CustomToolEditPage } from "./custom-tool-edit-page";

/**
 * Custom Tools dashboard tab — list view + edit-page router (Phase 6).
 *
 * Pattern aligned with `skills.tsx`: when `?edit=<id>` is present in the
 * URL, render the dedicated edit page; otherwise render the list view
 * with search + chips. The drawer that lived here through Phase 5 has
 * been removed — every editor affordance migrated to
 * `custom-tool-edit-page.tsx`.
 *
 * `?edit=__new__` opens the editor in draft mode (sample template
 * pre-loaded). On successful create the URL is rewritten to the just-
 * minted tool id so the page becomes bookmarkable.
 */

interface CustomToolStep {
  kind: "tool" | "transform";
  toolName?: string;
  args?: Record<string, unknown>;
  template?: string;
  saveAs?: string;
}

interface CustomTool {
  id: string;
  description: string;
  destructive: boolean;
  inputs: { name: string }[];
  steps: CustomToolStep[];
  estimatedCost?: number;
  createdAt: string;
  updatedAt: string;
}

const CHIP_LIMIT = 4;

// Sample preview shown on the empty state — same shape as Phase 5.
const SAMPLE_TOOL_PREVIEW = `"inputs": [{ "name": "task", "type": "string", "required": true }],
"steps": [
  { "kind": "tool", "toolName": "vault_read", "args": { "path": "Tasks/Kanban.md" }, "saveAs": "kanban" },
  { "kind": "transform", "template": "{{kanban}}\\n- [ ] {{task}}", "saveAs": "newKanban" },
  { "kind": "tool", "toolName": "vault_write", "args": { "path": "Tasks/Kanban.md", "content": "{{newKanban}}" } }
]`;

export function CustomToolsTab() {
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");

  if (editId) {
    return <CustomToolEditPage toolId={editId} />;
  }

  return <CustomToolsListView />;
}

function CustomToolsListView() {
  const router = useRouter();
  const [tools, setTools] = useState<CustomTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Help panel — collapsed bit persisted in localStorage so a missing
  // key reads as "not collapsed yet" → keep open.
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
        localStorage.setItem("kebab.customtools.help.collapsed", next ? "0" : "1");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/custom-tools", { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        // Default sort: updatedAt desc. The server doesn't guarantee
        // ordering today, so we sort client-side — cheap, deterministic,
        // doesn't depend on Upstash returning rows in insertion order.
        const sorted = [...(data.tools || [])].sort(
          (a: CustomTool, b: CustomTool) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        setTools(sorted);
      }
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

  const startCreate = () => {
    router.push("/config?tab=custom-tools&edit=__new__");
  };

  const startEdit = (id: string) => {
    router.push(`/config?tab=custom-tools&edit=${encodeURIComponent(id)}`);
  };

  // Client-side filter — case-insensitive contains on id and description.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) => t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  }, [tools, search]);

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
          onClick={startCreate}
          className="text-xs font-medium text-accent hover:underline px-3 py-1.5 border border-accent/20 rounded-md"
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

      {/* Search — only render when we have at least 2 tools to filter
          across. A search bar above an empty state is just visual noise. */}
      {tools.length >= 2 && (
        <div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by id or description..."
            className="w-full bg-bg-muted border border-border rounded-md px-3 py-1.5 text-xs focus:border-accent focus:outline-none"
            aria-label="Search custom tools"
          />
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
              onClick={startCreate}
              className="text-xs font-medium text-accent hover:underline px-3 py-1.5 border border-accent/20 rounded-md"
            >
              + Create from scratch
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-text-muted">
          No tools match <code className="font-mono">{search}</code>.
        </p>
      ) : (
        <div className="grid gap-3">
          {filtered.map((t) => (
            <CustomToolCard
              key={t.id}
              tool={t}
              onEdit={() => startEdit(t.id)}
              onDelete={() => onDelete(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CustomToolCard({
  tool,
  onEdit,
  onDelete,
}: {
  tool: CustomTool;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Compute unique tool names referenced by this tool's `tool` steps —
  // capped at CHIP_LIMIT to keep the card compact, with "+N more" for
  // overflow.
  const { chips, overflow } = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const step of tool.steps) {
      if (step.kind !== "tool") continue;
      const name = step.toolName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return {
      chips: names.slice(0, CHIP_LIMIT),
      overflow: Math.max(0, names.length - CHIP_LIMIT),
    };
  }, [tool.steps]);

  return (
    <div className="border border-border rounded-lg p-4 bg-bg-muted hover:border-border-light transition-colors">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
          title="Click to edit"
        >
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <code className="text-sm font-mono font-semibold">{tool.id}</code>
            {tool.destructive && (
              <span className="text-[10px] uppercase tracking-wide bg-red/10 text-red px-1.5 py-0.5 rounded">
                destructive
              </span>
            )}
            <span className="text-[11px] text-text-muted">
              {tool.steps.length} step{tool.steps.length === 1 ? "" : "s"}
            </span>
            {typeof tool.estimatedCost === "number" && (
              <span
                className="text-[10px] tracking-wide bg-bg border border-border text-text-muted px-1.5 py-0.5 rounded"
                title="Server-estimated cost per run (1–10 points/step depending on pack). Hard cap: 50."
              >
                ~{tool.estimatedCost}pts cost
              </span>
            )}
          </div>
          <p className="text-sm text-text-dim mb-1.5">{tool.description}</p>
          {chips.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mb-1">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">uses:</span>
              {chips.map((name) => (
                <span
                  key={name}
                  className="inline-block px-1.5 py-0.5 text-[10px] font-mono bg-bg border border-border rounded text-text-dim"
                >
                  {name}
                </span>
              ))}
              {overflow > 0 && (
                <span className="text-[10px] text-text-muted">…+{overflow} more</span>
              )}
            </div>
          )}
          <p className="text-[11px] text-text-muted">
            Updated {new Date(tool.updatedAt).toLocaleString()}
          </p>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onEdit}
            className="text-xs font-medium px-3 py-1 border border-border rounded-md text-text-dim hover:text-text"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="text-xs font-medium px-3 py-1 border border-red/30 rounded-md text-red hover:bg-red/5"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
