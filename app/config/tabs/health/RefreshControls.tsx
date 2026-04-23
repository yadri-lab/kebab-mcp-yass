"use client";

/**
 * Phase 53 — metrics refresh UI. Displays the effective interval +
 * last-fetched timestamp + a manual "Refresh now" button that calls
 * back into the parent's refresh handler (which fans out to every
 * useMetricsPoll hook).
 */

export interface RefreshControlsProps {
  refreshSec: number;
  lastFetchedAt: Date | null;
  onRefresh: () => void;
  source?: "buffer" | "durable" | "upstash" | "unknown" | null;
}

export function RefreshControls({
  refreshSec,
  lastFetchedAt,
  onRefresh,
  source,
}: RefreshControlsProps) {
  const sourceLabel =
    source === "durable" ? " · cold-start (durable)" : source === "unknown" ? " · kv: unknown" : "";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        fontSize: "12px",
        color: "#9ca3af",
      }}
    >
      <span>
        Auto-refresh every {refreshSec}s
        {lastFetchedAt ? ` · last ${lastFetchedAt.toLocaleTimeString()}` : ""}
        {sourceLabel}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        style={{
          background: "#1f2937",
          color: "#e5e7eb",
          border: "1px solid #374151",
          borderRadius: "4px",
          padding: "4px 10px",
          fontSize: "12px",
          cursor: "pointer",
        }}
      >
        Refresh now
      </button>
    </div>
  );
}
