"use client";

import { useState } from "react";
import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";

export function OverviewTab({
  baseUrl,
  totalTools,
  enabledCount,
  packCount,
  logs,
  config,
}: {
  baseUrl: string;
  totalTools: number;
  enabledCount: number;
  packCount: number;
  logs: ToolLog[];
  config: InstanceConfig;
}) {
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const endpoint = `${baseUrl}/api/mcp`;
  const lastLog = logs[logs.length - 1];

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active tools" value={totalTools} accent />
        <StatCard label="Active packs" value={`${enabledCount} / ${packCount}`} />
        <StatCard
          label="Last invocation"
          value={lastLog ? new Date(lastLog.timestamp).toLocaleTimeString() : "—"}
          small
        />
        <StatCard label="Display name" value={config.displayName} small />
      </div>

      {/* Endpoint */}
      <Section title="MCP endpoint">
        <Row
          label="URL"
          value={endpoint}
          action={
            <button
              onClick={() => copy("url", endpoint)}
              className="text-xs text-accent hover:underline"
            >
              {copied === "url" ? "Copied!" : "Copy"}
            </button>
          }
        />
        <Row
          label="Auth token"
          value={tokenRevealed ? "(see .env — MCP_AUTH_TOKEN)" : "••••••••••••"}
          action={
            <div className="flex gap-3">
              <button
                onClick={() => setTokenRevealed(!tokenRevealed)}
                className="text-xs text-accent hover:underline"
              >
                {tokenRevealed ? "Hide" : "Reveal"}
              </button>
            </div>
          }
        />
      </Section>

      {/* Recent activity */}
      <Section title="Recent activity">
        {logs.length === 0 ? (
          <p className="text-sm text-text-muted px-5 py-4">No tool invocations yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {logs
              .slice(-5)
              .reverse()
              .map((log, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${log.status === "success" ? "bg-green" : "bg-red"}`}
                  />
                  <span className="font-mono text-xs w-36 truncate">{log.tool}</span>
                  <span className="text-text-muted flex-1 truncate">
                    {log.status === "success" ? "OK" : log.error}
                  </span>
                  <span className="font-mono text-xs text-text-muted">{log.durationMs}ms</span>
                </div>
              ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div className="border border-border rounded-lg p-4">
      <p
        className={`${small ? "text-sm" : "text-2xl"} font-bold font-mono ${accent ? "text-accent" : "text-text"}`}
      >
        {value}
      </p>
      <p className="text-[10px] text-text-muted uppercase tracking-wide mt-1">{label}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
        {title}
      </h2>
      <div className="border border-border rounded-lg divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, value, action }: { label: string; value: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <span className="text-xs text-text-muted w-24 shrink-0">{label}</span>
      <span className="font-mono text-xs text-text flex-1 truncate">{value}</span>
      {action}
    </div>
  );
}
