import { AppShell } from "../sidebar";
import { getInstanceConfig } from "@/core/config";
import { resolveRegistry } from "@/core/registry";
import { getRecentLogs } from "@/core/logging";
import { ConfigTabs } from "./tabs";

export const dynamic = "force-dynamic";

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: "Overview", subtitle: "Live status of your MCP server." },
  connectors: { title: "Connectors", subtitle: "Enable, configure, and test your connectors." },
  tools: { title: "Tools", subtitle: "Browse and run any registered tool." },
  skills: { title: "Skills", subtitle: "Create and manage user-defined skills." },
  logs: { title: "Logs", subtitle: "Recent tool invocations." },
  settings: { title: "Settings", subtitle: "Server-wide configuration." },
};

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab || "overview";
  const meta = PAGE_META[tab] || PAGE_META.overview;
  const config = getInstanceConfig();

  const registry = resolveRegistry();
  const logs = getRecentLogs(100);

  const enabled = registry.filter((p) => p.enabled);
  const totalTools = enabled.reduce((s, p) => s + p.manifest.tools.length, 0);

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const connectorSummaries = registry.map((p) => ({
    id: p.manifest.id,
    label: p.manifest.label,
    description: p.manifest.description,
    enabled: p.enabled,
    reason: p.reason,
    toolCount: p.manifest.tools.length,
    requiredEnvVars: p.manifest.requiredEnvVars,
    guide: p.manifest.guide,
    tools: p.manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      deprecated: t.deprecated,
      destructive: t.destructive,
    })),
  }));

  return (
    <AppShell title={meta.title} subtitle={meta.subtitle} displayName={config.displayName}>
      <ConfigTabs
        activeTab={tab}
        connectors={connectorSummaries}
        totalTools={totalTools}
        enabledCount={enabled.length}
        logs={logs}
        baseUrl={baseUrl}
        config={config}
      />
    </AppShell>
  );
}
