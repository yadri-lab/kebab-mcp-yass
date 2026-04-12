import { SetupWizard } from "./wizard";
import { AppShell } from "../sidebar";
import { getInstanceConfig } from "@/core/config";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  const isFirstTime = !process.env.MCP_AUTH_TOKEN;
  const isVercel = !!process.env.VERCEL;
  const config = getInstanceConfig();

  return (
    <AppShell
      title={isFirstTime ? "Welcome to MyMCP" : "Setup"}
      subtitle={
        isFirstTime
          ? "Let's get your personal MCP server configured in a few minutes."
          : "Update your server configuration."
      }
      displayName={config.displayName}
      setupMode={isFirstTime}
      narrow
    >
      <SetupWizard firstTime={isFirstTime} isVercel={isVercel} />
    </AppShell>
  );
}
