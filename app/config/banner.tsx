"use client";

/**
 * SAFE-03: dashboard-wide banner for active destructive env vars.
 *
 * Rendered above the tab row on /config. Fetches /api/health on mount
 * to read `warnings[]`; renders nothing when the array is empty or
 * missing (happy path). When a warning is present, surfaces the var
 * name + operator-facing message in a red banner so the user cannot
 * miss that (e.g.) MYMCP_RECOVERY_RESET=1 is wiping bootstrap state
 * on every cold lambda start.
 *
 * Inline styles (no shadcn/tailwind dep) to match the other /config
 * primitives (see CLAUDE.md UI conventions section).
 */

import { useEffect, useState } from "react";

interface HealthWarning {
  code: string;
  var: string;
  message: string;
}

export function DestructiveVarsBanner() {
  const [warnings, setWarnings] = useState<HealthWarning[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((body: { warnings?: HealthWarning[] }) => {
        if (cancelled) return;
        setWarnings(Array.isArray(body.warnings) ? body.warnings : []);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setWarnings([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || warnings.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        background: "#7f1d1d",
        color: "#fff",
        padding: "12px 16px",
        margin: "0 0 16px 0",
        borderRadius: "4px",
        fontSize: "14px",
        lineHeight: 1.5,
      }}
    >
      <strong>Destructive environment variable(s) active:</strong>
      <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
        {warnings.map((w) => (
          <li key={w.var}>
            <code
              style={{
                background: "rgba(255,255,255,0.15)",
                padding: "1px 6px",
                borderRadius: "3px",
              }}
            >
              {w.var}
            </code>{" "}
            — {w.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
