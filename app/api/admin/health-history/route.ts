import { checkAdminAuth } from "@/core/auth";
import { getLogStore } from "@/core/log-store";

/**
 * GET /api/admin/health-history — admin-gated.
 *
 * Returns health-check sample history from the LogStore. Each sample is
 * written by the deep health check (`GET /api/health?deep=1`) and
 * contains per-connector ok/latency data.
 *
 * Query params:
 * - `days` — retention window (default: MYMCP_HEALTH_SAMPLE_RETENTION_DAYS or 7)
 */
export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const defaultDays = parseInt(process.env.MYMCP_HEALTH_SAMPLE_RETENTION_DAYS || "7", 10);
  const days = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get("days") || String(defaultDays), 10) || defaultDays, 90)
  );
  const cutoff = Date.now() - days * 86_400_000;

  const store = getLogStore();
  const entries = await store.since(cutoff);

  const samples = entries
    .filter((e) => e.meta && (e.meta as Record<string, unknown>).type === "health-sample")
    .map((e) => ({
      ts: e.ts,
      overall: (e.meta as Record<string, unknown>).overall,
      connectors: (e.meta as Record<string, unknown>).connectors,
    }));

  // Entries from `since()` come newest-first; reverse to chronological.
  samples.reverse();

  return Response.json(samples);
}
