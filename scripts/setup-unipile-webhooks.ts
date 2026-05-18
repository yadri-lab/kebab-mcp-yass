#!/usr/bin/env tsx
/**
 * Phase 70 / Plan 01 / Task 3 — One-shot Unipile webhook bootstrap (UNI-12 / D-67 / D-68).
 *
 * Idempotent CLI. Lists the operator's existing Unipile webhook
 * subscriptions, then creates only the missing ones for the 3 required
 * sources:
 *
 *   | source         | mode      | name                    |
 *   |----------------|-----------|-------------------------|
 *   | messaging      | typed     | unipile-messaging       |
 *   | account_status | typed     | unipile-account-status  |
 *   | users          | escape    | unipile-users           |
 *
 * The "users" source is the D-68 escape hatch — the unipile-node-sdk
 * webhook resource only ships typed schemas for messaging /
 * account_status / email / email_tracking (the TUnion in
 * `WebhookCreateBodySchema`). The Unipile REST API supports `users`
 * subscriptions (new_relation event) but the SDK does not surface it;
 * we POST via `client.request.send({ path: ["webhooks"], method: "POST" })`.
 *
 * Usage (after deploying the route to your Vercel project):
 *
 *   # Local: same convention as `scripts/smoke-unipile.ts` — env vars are
 *   # provided by tsx's `--env-file` flag (no dotenv dep).
 *   npx tsx --env-file=.env scripts/setup-unipile-webhooks.ts
 *
 *   # Vercel deploy: set the 4 env vars in the Vercel dashboard, then run
 *   # via `vercel env pull` + `npx tsx --env-file=.env.local scripts/...`.
 *
 * Required env vars:
 *   - UNIPILE_DSN          (e.g. api41.unipile.com:17153 — with or without https://)
 *   - UNIPILE_TOKEN        (Unipile API token from the dashboard)
 *   - UNIPILE_WEBHOOK_SECRET  (operator-chosen ≥32-byte secret; Unipile sends
 *                              it back in the `Unipile-Auth` header per D-52/D-53)
 *   - KEBAB_PUBLIC_URL     (the deployed origin — e.g. https://kebab-yass.vercel.app)
 *
 * The script is IDEMPOTENT: re-running it after success creates 0 new
 * webhooks. Subscriptions are matched on (source, request_url) — if you
 * change KEBAB_PUBLIC_URL between runs, you'll get a NEW subscription
 * pointing at the new URL (the old one continues to receive at the
 * dead origin until you delete it manually via the Unipile dashboard).
 *
 * SCOPE GUARD: This script ONLY POSTs to the Unipile API. It does NOT
 * POST to any CRM, operator URL, or third party. The connector is a
 * stateless MCP transport — outbound state-change notifications are
 * out of scope per `.planning/phases/70-webhooks-whatsapp/70-CONTEXT.md
 * ## Out of scope — IMPORTANT`.
 */
import { UnipileClient } from "unipile-node-sdk";

interface CliConfig {
  dsn: string;
  token: string;
  secret: string;
  publicUrl: string;
}

interface ExistingWebhook {
  id: string;
  source?: string;
  name?: string;
  request_url?: string;
}

interface DesiredWebhook {
  source: "messaging" | "account_status" | "users";
  name: string;
  /**
   * "typed"  → use the SDK's typed `client.webhook.create({...})` method.
   * "escape" → use the D-68 escape hatch `client.request.send({...})` for
   *            sources the SDK doesn't expose (currently: "users").
   */
  mode: "typed" | "escape";
}

const DESIRED: ReadonlyArray<DesiredWebhook> = [
  { source: "messaging", name: "unipile-messaging", mode: "typed" },
  { source: "account_status", name: "unipile-account-status", mode: "typed" },
  { source: "users", name: "unipile-users", mode: "escape" },
];

function readConfig(): CliConfig {
  const dsn = process.env.UNIPILE_DSN;
  const token = process.env.UNIPILE_TOKEN;
  const secret = process.env.UNIPILE_WEBHOOK_SECRET;
  const publicUrl = process.env.KEBAB_PUBLIC_URL;

  const missing: string[] = [];
  if (!dsn) missing.push("UNIPILE_DSN");
  if (!token) missing.push("UNIPILE_TOKEN");
  if (!secret) missing.push("UNIPILE_WEBHOOK_SECRET");
  if (!publicUrl) missing.push("KEBAB_PUBLIC_URL");

  if (missing.length > 0) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    console.error("Set them in .env (local) or your Vercel project (deploy).");
    process.exit(1);
  }

  return { dsn: dsn!, token: token!, secret: secret!, publicUrl: publicUrl! };
}

function normalizeDsn(dsn: string): string {
  return /^https?:\/\//i.test(dsn) ? dsn : `https://${dsn}`;
}

function buildWebhookUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/unipile/webhook`;
}

function buildBody(
  source: DesiredWebhook["source"],
  name: string,
  url: string,
  secret: string
): Record<string, unknown> {
  return {
    source,
    request_url: url,
    name,
    headers: [
      // D-52/D-53: Unipile echoes these headers verbatim on every webhook
      // POST. The route's verifier matches `Unipile-Auth: <secret>` via
      // timingSafeEqual on sha256 hashes.
      { key: "Unipile-Auth", value: secret },
    ],
  };
}

async function listExisting(client: UnipileClient): Promise<ExistingWebhook[]> {
  // The SDK's typed return shape is a discriminated union with many fields;
  // we only care about (id, source, name, request_url). Cast through
  // `unknown` because the SDK schemas don't expose a top-level `source`
  // string field directly — the "source" is implicit in the discriminator.
  // Empirically the response items DO carry the source on the wire (verified
  // against api41.unipile.com 2026-05-18). Defensive: missing fields → null.
  const raw = (await client.webhook.getAll()) as unknown as {
    items?: ExistingWebhook[];
  };
  return Array.isArray(raw?.items) ? raw.items : [];
}

async function createWebhook(
  client: UnipileClient,
  desired: DesiredWebhook,
  url: string,
  secret: string
): Promise<string> {
  const body = buildBody(desired.source, desired.name, url, secret);

  if (desired.mode === "typed") {
    // SDK accepts messaging + account_status natively via the typed union.
    const res = (await client.webhook.create(body as never)) as {
      webhook_id?: string;
    };
    return res?.webhook_id ?? "<id-not-in-response>";
  }

  // D-68 escape hatch — `users` source is not in the SDK's TypeBox union
  // but the REST API supports it. POST via the raw request sender.
  //
  // CRITICAL: the SDK's `RequestSender.send()` only JSON-stringifies the
  // body when `headers['Content-Type'] === 'application/json'` is set
  // explicitly. Without this header, `body: {...}` goes out as
  // `[object Object]` and the server returns a non-2xx with no useful
  // error message. Verified empirically 2026-05-18 against
  // api41.unipile.com:17153 — the typed `client.webhook.create()` path
  // sets this header internally so it "just works" for messaging /
  // account_status, but the escape hatch must set it itself.
  const res = (await client.request.send({
    method: "POST",
    path: ["webhooks"],
    headers: { "Content-Type": "application/json" },
    body,
  })) as { webhook_id?: string };
  return res?.webhook_id ?? "<id-not-in-response>";
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const url = buildWebhookUrl(cfg.publicUrl);

  console.log(`Unipile DSN  : ${cfg.dsn}`);
  console.log(`Webhook URL  : ${url}`);
  console.log(`Webhook auth : Unipile-Auth: ${cfg.secret.slice(0, 4)}…(masked)`);
  console.log("");

  const client = new UnipileClient(normalizeDsn(cfg.dsn), cfg.token);

  console.log("Listing existing subscriptions…");
  const existing = await listExisting(client);
  console.log(`  found ${existing.length} existing webhook(s)`);
  if (existing.length > 0) {
    for (const w of existing) {
      console.log(
        `  - id=${w.id} source=${w.source ?? "?"} name=${w.name ?? "?"} url=${w.request_url ?? "?"}`
      );
    }
  }
  console.log("");

  let created = 0;
  let skipped = 0;
  for (const d of DESIRED) {
    const already = existing.find((e) => e.source === d.source && e.request_url === url);
    if (already) {
      console.log(`[skip]   ${d.source.padEnd(15)} already present (id=${already.id})`);
      skipped++;
      continue;
    }

    try {
      const id = await createWebhook(client, d, url, cfg.secret);
      console.log(`[create] ${d.source.padEnd(15)} → ${url} (id=${id})`);
      created++;
    } catch (err) {
      // `UnsuccessfulRequestError` (from the SDK escape-hatch path) carries
      // the server response on `.body` and ships with `.message === ''` —
      // surface the body so operators can see WHY the create failed
      // (e.g. malformed source, missing field, tenant-side restriction).
      const msg = err instanceof Error ? err.message : String(err);
      const body = (err as { body?: unknown })?.body;
      const detail = body !== undefined ? ` — body: ${JSON.stringify(body)}` : "";
      console.error(`[error]  ${d.source.padEnd(15)} create failed: ${msg}${detail}`);
      process.exitCode = 1;
    }
  }

  console.log("");
  console.log(`Done. ${created} created, ${skipped} skipped.`);
  if (created === 0 && skipped === DESIRED.length) {
    console.log("All 3 required subscriptions are already configured.");
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
