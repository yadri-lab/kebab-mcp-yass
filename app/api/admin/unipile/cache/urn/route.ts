/**
 * Phase 68 / Plan 03 / Task 2 — Admin URN cache eviction endpoint (D-11/D-18).
 *
 * DELETE /api/admin/unipile/cache/urn?profile_url=<linkedin-profile-url>
 *
 * Behavior:
 *  - Admin-auth via withAdminAuth HOC (401 on missing/invalid admin cookie).
 *  - 400 when ?profile_url= is missing.
 *  - 400 when normalizeProfileUrl() rejects the input.
 *  - 200 { ok, evicted: true, key, normalized_url } on success.
 *  - 500 with { ok: false, error } on unexpected failure.
 *
 * KV-ALLOWLIST-EXEMPT: cache eviction for unipile URN keys uses raw getKVStore()
 *   (root scope) rather than getContextKVStore() because an admin operator may
 *   need to evict poisoned/stale entries across all tenants from a single
 *   dashboard action. Mirrors the pattern of app/api/admin/rate-limits/route.ts
 *   (Phase 53 + 42 INVENTORY). See .planning/phases/68-unipile-foundation/
 *   68-CONTEXT.md D-18 for the locked decision.
 *
 * Tenant-scope asymmetry (intentional): connector lib code in
 *   src/connectors/unipile/lib/identifiers.ts writes keys via
 *   getContextKVStore() → on-disk key is `tenant:<id>:unipile:urn:<hash>`.
 *   This root-scope DELETE wipes ONLY the unscoped `unipile:urn:<hash>` key
 *   (which only exists when no tenant context is active, e.g. local dev with
 *   no tenantId). To evict a specific tenant's cached URN, that tenant must
 *   call the same eviction logic from within their request context. NOT
 *   exposed in phase 68; tracked as a future enhancement.
 *
 * KV.delete is idempotent — we always return evicted: true (no existence check
 *   round-trip; the caller's intent is "ensure this key is gone").
 *
 * Note on `evicted: true` semantics: KV.delete doesn't expose whether the key
 *   existed pre-call. The flag means "the delete operation completed
 *   successfully" — NOT "a row was actually removed". Documented here so
 *   operators don't read false positives into it.
 */

import { NextResponse } from "next/server";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";
import { toMsg } from "@/core/error-utils";
import { getKVStore } from "@/core/kv-store";
import { normalizeProfileUrl, urnCacheKey } from "@/connectors/unipile/lib/identifiers";

async function deleteHandler(ctx: PipelineContext): Promise<Response> {
  try {
    const url = new URL(ctx.request.url);
    const profileUrl = url.searchParams.get("profile_url");
    if (!profileUrl) {
      return NextResponse.json(
        { ok: false, error: "profile_url query parameter is required" },
        { status: 400 }
      );
    }

    let normalized: string;
    try {
      normalized = normalizeProfileUrl(profileUrl);
    } catch (err) {
      return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 400 });
    }

    const key = urnCacheKey(normalized);
    const kv = getKVStore();
    await kv.delete(key);

    return NextResponse.json({
      ok: true,
      evicted: true,
      key,
      normalized_url: normalized,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: toMsg(err) }, { status: 500 });
  }
}

export const DELETE = withAdminAuth(deleteHandler);
