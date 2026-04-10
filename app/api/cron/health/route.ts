import { resolveRegistry } from "@/core/registry";

/**
 * Hourly cron health check (Vercel Cron).
 * Runs diagnose() on all enabled packs.
 * If MYMCP_ERROR_WEBHOOK_URL is set, alerts on degraded packs.
 * Protected by CRON_SECRET (Vercel sets this automatically for cron jobs).
 */
export async function GET(request: Request) {
  // Verify cron secret (Vercel injects this for cron jobs)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const registry = resolveRegistry();
  const results: { pack: string; ok: boolean; message: string }[] = [];

  for (const p of registry) {
    if (!p.enabled || !p.manifest.diagnose) continue;
    try {
      const diag = await p.manifest.diagnose();
      results.push({ pack: p.manifest.label, ok: diag.ok, message: diag.message });
    } catch (err) {
      results.push({
        pack: p.manifest.label,
        ok: false,
        message: err instanceof Error ? err.message : "Check failed",
      });
    }
  }

  const degraded = results.filter((r) => !r.ok);

  // Alert via webhook if any pack is degraded
  if (degraded.length > 0) {
    const webhookUrl = process.env.MYMCP_ERROR_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[MyMCP Health] ${degraded.length} pack(s) degraded: ${degraded.map((d) => `${d.pack}: ${d.message}`).join("; ")}`,
          packs: degraded,
        }),
      }).catch(() => {});
    }
  }

  return Response.json({
    ok: degraded.length === 0,
    checked: results.length,
    degraded: degraded.length,
    results,
  });
}
