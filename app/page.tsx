import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function HomePage() {
  if (process.env.MCP_AUTH_TOKEN) {
    redirect("/config");
  }
  redirect("/setup");
}
