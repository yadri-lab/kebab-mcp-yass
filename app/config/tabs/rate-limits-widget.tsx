"use client";

import { useEffect, useState, useCallback } from "react";

interface RateLimitScope {
  scope: string;
  current: number;
  max: number;
  tenantId: string;
  percentage: number;
}

interface RateLimitsData {
  scopes: RateLimitScope[];
}

type State = { kind: "loading" } | { kind: "ready"; data: RateLimitsData } | { kind: "error" };

function barColor(pct: number): string {
  if (pct > 80) return "bg-red";
  if (pct > 50) return "bg-orange";
  return "bg-green";
}

function barTextColor(pct: number): string {
  if (pct > 80) return "text-red";
  if (pct > 50) return "text-orange-dark";
  return "text-green";
}

export function RateLimitsWidget() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const fetchData = useCallback(() => {
    fetch("/api/admin/rate-limits", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: RateLimitsData) => setState({ kind: "ready", data }))
      .catch(() => setState({ kind: "error" }));
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (state.kind === "error") return null;

  if (state.kind === "loading") {
    return (
      <section>
        <h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
          Rate Limits
        </h2>
        <div className="border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">Loading...</p>
        </div>
      </section>
    );
  }

  const { scopes } = state.data;

  return (
    <section>
      <h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
        Rate Limits
      </h2>
      <div className="border border-border rounded-lg divide-y divide-border">
        {scopes.length === 0 ? (
          <p className="text-sm text-text-muted px-5 py-4">No active rate limits</p>
        ) : (
          scopes.map((s) => (
            <div key={`${s.tenantId}:${s.scope}`} className="px-5 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-text">{s.scope}</span>
                  {s.tenantId !== "global" && (
                    <span className="text-[10px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded">
                      {s.tenantId}
                    </span>
                  )}
                </div>
                <span className={`font-mono text-xs font-semibold ${barTextColor(s.percentage)}`}>
                  {s.current}/{s.max} ({s.percentage}%)
                </span>
              </div>
              <div className="w-full h-1.5 bg-bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${barColor(s.percentage)}`}
                  style={{ width: `${Math.min(100, s.percentage)}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
