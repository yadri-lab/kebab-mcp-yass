import { NextResponse } from "next/server";

/**
 * POST /api/setup/test
 * Test a single credential by making a lightweight API call.
 * Only works during first-time setup (no MCP_AUTH_TOKEN).
 */
export async function POST(request: Request) {
  if (process.env.MCP_AUTH_TOKEN) {
    return NextResponse.json({ error: "Use /api/admin/verify instead" }, { status: 403 });
  }

  const body = (await request.json()) as { pack: string; credentials: Record<string, string> };

  try {
    switch (body.pack) {
      case "google": {
        const token = body.credentials.GOOGLE_REFRESH_TOKEN;
        if (!token) return NextResponse.json({ ok: false, message: "No refresh token to test" });
        // Light test: try to get user info
        const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) return NextResponse.json({ ok: true, message: "Google API connected" });
        return NextResponse.json({ ok: false, message: `Google API: ${res.status}` });
      }

      case "vault": {
        const pat = body.credentials.GITHUB_PAT;
        const repo = body.credentials.GITHUB_REPO;
        if (!pat || !repo) return NextResponse.json({ ok: false, message: "Missing PAT or repo" });
        const res = await fetch(`https://api.github.com/repos/${repo}`, {
          headers: { Authorization: `token ${pat}` },
        });
        if (res.ok) return NextResponse.json({ ok: true, message: `Connected to ${repo}` });
        return NextResponse.json({ ok: false, message: `GitHub: ${res.status}` });
      }

      case "slack": {
        const token = body.credentials.SLACK_BOT_TOKEN;
        if (!token) return NextResponse.json({ ok: false, message: "Missing token" });
        const res = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
        if (data.ok) return NextResponse.json({ ok: true, message: `Connected to ${data.team}` });
        return NextResponse.json({ ok: false, message: `Slack: ${data.error}` });
      }

      case "notion": {
        const key = body.credentials.NOTION_API_KEY;
        if (!key) return NextResponse.json({ ok: false, message: "Missing API key" });
        const res = await fetch("https://api.notion.com/v1/users/me", {
          headers: { Authorization: `Bearer ${key}`, "Notion-Version": "2022-06-28" },
        });
        if (res.ok) return NextResponse.json({ ok: true, message: "Notion API connected" });
        return NextResponse.json({ ok: false, message: `Notion: ${res.status}` });
      }

      default:
        return NextResponse.json({ ok: true, message: "No test available for this pack" });
    }
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: err instanceof Error ? err.message : "Connection failed",
    });
  }
}
