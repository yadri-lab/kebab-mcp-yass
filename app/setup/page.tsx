import { SetupWizard } from "./wizard";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  const isFirstTime = !process.env.MCP_AUTH_TOKEN;
  const isVercel = !!process.env.VERCEL;

  return <SetupWizard firstTime={isFirstTime} isVercel={isVercel} />;
}
