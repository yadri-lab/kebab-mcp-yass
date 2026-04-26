import { NextResponse } from "next/server";
import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  rateLimitStep,
  hydrateCredentialsStep,
  type PipelineContext,
} from "@/core/pipeline";
import { getConfig } from "@/core/config-facade";
import { getCredential } from "@/core/request-context";
import { getKVStore } from "@/core/kv-store";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";
import {
  computeUpdateStatus,
  UPDATE_CHECK_KV_KEY,
  UPDATE_CHECK_TTL_SECONDS,
} from "@/core/update-check";
// app/landing/deploy-url is OUTSIDE the @/* alias scope (which maps to ./src/* only).
// From app/api/cron/update-check/route.ts the relative path to
// app/landing/deploy-url.ts is `../../../landing/deploy-url` — three `..`
// segments take us from the `update-check/` directory up through `cron/`
// and `api/` to `app/`. Mirrors the same pattern in
// app/api/config/update/route.ts (directory at the same depth).
import { UPSTREAM_OWNER, UPSTREAM_REPO_SLUG } from "../../../landing/deploy-url";

/**
 * Daily cron at 8h UTC (vercel.json).
 *
 * Calls computeUpdateStatus() against UPSTREAM_OWNER/UPSTREAM_REPO_SLUG and
 * writes the result to KV `global:update-check` with a 48h TTL. The Overview
 * banner reads this cache first (Plan 063-01) so warm pageviews don't pay
 * the 200-500ms GitHub round-trip.
 *
 * Pipeline (canonical Phase-41 cron, mirrors /api/cron/health):
 *   rehydrateStep        — populates bootstrap auth cache from KV (also
 *                          satisfies the route-rehydrate-coverage contract,
 *                          so no BOOTSTRAP_EXEMPT marker is needed).
 *   authStep("cron")     — enforces Authorization: Bearer ${CRON_SECRET}.
 *                          Mismatch → 401. Unset → 503 (unless loopback).
 *                          The handler stays clean — no inline auth check.
 *   rateLimitStep        — 120 req/min keyed by sha256(CRON_SECRET).
 *   hydrateCredentialsStep — D-15: PAT-via-Settings reaches the cron.
 */
const logger = getLogger("cron.update-check");

async function cronUpdateCheckHandler(_ctx: PipelineContext): Promise<Response> {
  // ── Resolve PAT (D-06: KEBAB_UPDATE_PAT first, then GITHUB_TOKEN) ──────
  const token =
    (getCredential("KEBAB_UPDATE_PAT") ?? getConfig("KEBAB_UPDATE_PAT")) ||
    (getCredential("GITHUB_TOKEN") ?? getConfig("GITHUB_TOKEN")) ||
    null;

  if (!token) {
    logger.info("no token configured — skipping update check");
    return NextResponse.json({ ok: false, reason: "no-token" });
  }

  // ── Determine fork owner/slug (Vercel-deployed forks) ──────────────────
  const owner = getConfig("VERCEL_GIT_REPO_OWNER");
  const slug = getConfig("VERCEL_GIT_REPO_SLUG");
  if (!owner || !slug) {
    logger.info("VERCEL_GIT_REPO_OWNER/SLUG unset — skipping (not a Vercel fork)");
    return NextResponse.json({ ok: false, reason: "not-a-fork" });
  }

  // ── Run the shared computeUpdateStatus helper ──────────────────────────
  const result = await computeUpdateStatus(token, owner, slug);
  if (!result.ok) {
    logger.warn("computeUpdateStatus failed", { kind: result.kind });
    // Don't poison the cache with auth/fetch errors — return diagnostic.
    return NextResponse.json({ ok: false, reason: result.kind });
  }

  // ── Awaited KV write (CLAUDE.md fire-and-forget rule + BUG-07) ─────────
  try {
    const kv = getKVStore();
    await kv.set(UPDATE_CHECK_KV_KEY, JSON.stringify(result.payload), UPDATE_CHECK_TTL_SECONDS);
    logger.info("update-check cache refreshed", {
      status: result.payload.status,
      behind_by: result.payload.behind_by,
    });
  } catch (err) {
    logger.error("KV write failed", { error: toMsg(err) });
    return NextResponse.json({ ok: false, reason: "kv-write-failed" }, { status: 502 });
  }

  // Reference UPSTREAM_OWNER/UPSTREAM_REPO_SLUG so the import isn't
  // tree-shaken to nothing — they're documented in the response for
  // operators eyeballing logs.
  return NextResponse.json({
    ok: true,
    upstream: `${UPSTREAM_OWNER}/${UPSTREAM_REPO_SLUG}`,
    payload: result.payload,
  });
}

export const GET = composeRequestPipeline(
  [
    rehydrateStep,
    authStep("cron"),
    rateLimitStep({ scope: "cron", keyFrom: "cronSecretTokenId", limit: 120 }),
    hydrateCredentialsStep,
  ],
  cronUpdateCheckHandler
);
