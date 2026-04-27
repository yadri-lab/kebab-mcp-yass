import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LandingPage from "./landing/landing-page";
import { getConfig } from "@/core/config-facade";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kebab MCP — Give every AI client the same superpowers.",
  description:
    "One self-hosted backend for every AI client. 86+ tools across 15 connectors — Gmail, Calendar, Notion, GitHub, Slack and more. Deploy to Vercel in one click. MIT licensed, open source.",
  openGraph: {
    title: "Kebab MCP — Give every AI client the same superpowers.",
    description:
      "One deploy. Claude, Cursor, Windsurf — every MCP client gets 86+ tools across 15 connectors. Self-hosted, MIT licensed, zero ongoing cost.",
  },
};

export default function HomePage() {
  // Routing rules for `/`:
  //   - Token present → user has finished setup → /config dashboard.
  //   - Explicit `INSTANCE_MODE=showcase` → marketing landing (e.g. the
  //     public mymcp-home demo).
  //   - Anything else (real deployments, including fresh forks) → /welcome
  //     to mint the token. The previous logic gated this on
  //     `INSTANCE_MODE=personal` being explicitly set, but Vercel's
  //     fork-then-import flow doesn't set any env vars, so first-time
  //     users landed on the marketing page on their own deploy.
  //     Default-to-welcome makes the zero-config path work.
  //
  // Local dev (`npm run dev`) without a token still hits /welcome, which
  // is the right behavior — the welcome page is what bootstraps state.
  // To preview the marketing landing locally, set INSTANCE_MODE=showcase.
  const hasToken = !!getConfig("MCP_AUTH_TOKEN");
  const mode = getConfig("INSTANCE_MODE");
  const isShowcase = mode === "showcase";

  if (isShowcase) {
    return <LandingPage />;
  }

  if (hasToken) {
    redirect("/config");
  }

  redirect("/welcome");
}
