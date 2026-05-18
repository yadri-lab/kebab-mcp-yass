/**
 * Phase 71 / Plan 71-02 / UNI-22 (D-93..D-97) — cursor-paginated tenant-scoped audit query.
 *
 * GET /api/admin/audit/unipile?account_id=&since=&tool=&result=&limit=&cursor=
 *
 * - Admin-auth via withAdminAuth.
 * - Tenant-scoped via getContextKVStore (D-96).
 * - All filters optional + ANDed.
 * - Skip dedup pointer keys (containing :hash:) — mirrors audit.ts
 *   findAuditByProviderId at lines 244-258.
 * - Sort by timestamp DESC (newest first) — operator expectation.
 * - Cursor: base64 of last page's terminal audit_id. Invalid cursor → page 1
 *   (defensive — logged but not 500).
 * - 10s Cache-Control (shorter than metrics — audit freshness matters).
 *
 * Perf note (D-97): O(n) scan acceptable at Cadens scale (~12k rows/year/tenant).
 *   Secondary indexes deferred to phase 72+ if needed.
 *
 * Limits (D-95): default 50, max 200, min 1 (clamped).
 *
 * NO kv-allowlist entry (tenant-scoped — see PATTERNS misalignment #1).
 */
import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline/types";
import { getContextKVStore } from "@/core/request-context";
import { toMsg } from "@/core/error-utils";
import { getLogger } from "@/core/logging";
import type { AuditRow } from "@/connectors/unipile/lib/audit";

const log = getLogger("API:admin/audit/unipile");
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function decodeCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    return Buffer.from(cursor, "base64").toString("utf-8");
  } catch {
    log.warn("invalid cursor — falling back to page 1");
    return null;
  }
}

async function handler(ctx: PipelineContext): Promise<Response> {
  try {
    const url = new URL(ctx.request.url);
    const accountId = url.searchParams.get("account_id");
    const since = url.searchParams.get("since");
    const tool = url.searchParams.get("tool");
    const resultFilter = url.searchParams.get("result");
    const cursor = url.searchParams.get("cursor");
    const limitRaw = url.searchParams.get("limit");
    let limit = limitRaw ? parseInt(limitRaw, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT;
    limit = Math.min(MAX_LIMIT, Math.max(1, limit));

    const startAfterId = decodeCursor(cursor);

    const kv = getContextKVStore();
    const keys = await kv.list("unipile:audit:");
    const rowKeys = keys.filter((k) => !k.includes(":hash:"));

    const items: AuditRow[] = [];
    for (const key of rowKeys) {
      const raw = await kv.get(key);
      if (!raw) continue;
      let row: AuditRow;
      try {
        row = JSON.parse(raw) as AuditRow;
      } catch {
        continue;
      }
      if (accountId && row.account_id !== accountId) continue;
      if (tool && row.tool !== tool) continue;
      if (resultFilter && row.result !== resultFilter) continue;
      if (since && row.timestamp < since) continue;
      items.push(row);
    }
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    let startIdx = 0;
    if (startAfterId) {
      const found = items.findIndex((r) => r.audit_id === startAfterId);
      startIdx = found >= 0 ? found + 1 : 0; // not-found → page 1 fallback (defensive)
    }
    const page = items.slice(startIdx, startIdx + limit);
    const lastRow = page[page.length - 1];
    const nextCursor =
      items.length > startIdx + limit && lastRow
        ? Buffer.from(lastRow.audit_id, "utf-8").toString("base64")
        : null;

    return NextResponse.json(
      { items: page, cursor: nextCursor, total_estimate: items.length },
      { headers: { "Cache-Control": "private, max-age=10" } }
    );
  } catch (err) {
    return NextResponse.json({ error: toMsg(err) }, { status: 500 });
  }
}

export const GET = withAdminAuth(handler);
