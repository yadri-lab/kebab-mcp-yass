"use client";

import type { ToolLog } from "@/core/logging";
import type { InstanceConfig } from "@/core/types";
import { OverviewTab } from "./tabs/overview";
import { PacksTab } from "./tabs/packs";
import { ToolsTab } from "./tabs/tools";
import { SkillsTab } from "./tabs/skills";
import { LogsTab } from "./tabs/logs";
import { SettingsTab } from "./tabs/settings";

export interface PackSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  reason: string;
  toolCount: number;
  requiredEnvVars: string[];
  guide?: string;
  tools: { name: string; description: string; deprecated?: string; destructive?: boolean }[];
}

export function ConfigTabs({
  activeTab,
  packs,
  totalTools,
  enabledCount,
  logs,
  baseUrl,
  config,
}: {
  activeTab: string;
  packs: PackSummary[];
  totalTools: number;
  enabledCount: number;
  logs: ToolLog[];
  baseUrl: string;
  config: InstanceConfig;
}) {
  switch (activeTab) {
    case "packs":
      return <PacksTab packs={packs} />;
    case "tools":
      return <ToolsTab packs={packs} />;
    case "skills":
      return <SkillsTab />;
    case "logs":
      return <LogsTab initialLogs={logs} />;
    case "settings":
      return <SettingsTab config={config} />;
    case "overview":
    default:
      return (
        <OverviewTab
          baseUrl={baseUrl}
          totalTools={totalTools}
          enabledCount={enabledCount}
          packCount={packs.length}
          logs={logs}
          config={config}
        />
      );
  }
}
