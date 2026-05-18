import { UnipileClient } from "unipile-node-sdk";
import type { ConnectorManifest, ToolDefinition } from "@/core/types";
import { getConfig } from "@/core/config-facade";
import { getLogger } from "@/core/logging";
import { toMsg } from "@/core/error-utils";

const log = getLogger("CONNECTOR:unipile");

/**
 * Phase 68 / Plan 01 — Wave 0 stub manifest.
 *
 * Exposes the Unipile connector tile in /config with zero tools. Real
 * tools (linkedin_send_connection + linkedin_get_relationship_status)
 * land in Plan 06; this scaffold is here so:
 *  - parallel Wave 1 plans (client/identifiers/audit/crm-bridge) don't
 *    collide on manifest.ts edits,
 *  - the connector tile shows the operator that DSN + TOKEN are
 *    recognized BEFORE any tools ship,
 *  - the registry-metadata-consistency contract test passes with
 *    toolCount: 0 matching tools.length === 0.
 *
 * Decision references:
 *  - D-19 (CONTEXT.md): testConnection uses client.account.getAll() and
 *    requires ≥1 LinkedIn account. Silent "active but unusable" connectors
 *    mislead operators — we fail loud when no LinkedIn account is wired.
 *  - T-68-01-01 (threat model): never log the DSN or token value; log
 *    only the outcome string (e.g. "Connected — 2 LinkedIn account(s)").
 */

interface UnipileAccountItem {
  type?: string;
  // SDK exposes additional fields (id, status, etc.) — only `type` is
  // load-bearing here; the rest are intentionally unmodeled.
}

interface UnipileAccountListResponse {
  items?: UnipileAccountItem[];
}

function countLinkedinAccounts(resp: UnipileAccountListResponse): number {
  const items = resp.items ?? [];
  return items.filter((it) => it?.type === "LINKEDIN").length;
}

async function probe(
  dsn: string,
  token: string
): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
}> {
  try {
    const client = new UnipileClient(`https://${dsn}`, token);
    const resp = (await client.account.getAll()) as UnipileAccountListResponse;
    const linkedinCount = countLinkedinAccounts(resp);
    const total = resp.items?.length ?? 0;
    if (linkedinCount >= 1) {
      log.info(`Unipile probe ok: ${linkedinCount} LinkedIn account(s) of ${total} total`);
      return {
        ok: true,
        message: `Connected — ${linkedinCount} LinkedIn account(s)`,
      };
    }
    log.info(`Unipile probe: no LinkedIn account connected (${total} total accounts)`);
    return {
      ok: false,
      message: "No LinkedIn account connected to Unipile token",
      detail: `Total accounts on token: ${total}`,
    };
  } catch (err) {
    const msg = toMsg(err);
    log.info(`Unipile probe failed: ${msg}`);
    return {
      ok: false,
      message: `Unipile: ${msg}`,
    };
  }
}

export const unipileConnector: ConnectorManifest = {
  id: "unipile",
  label: "Unipile (LinkedIn writes)",
  description:
    "Send LinkedIn connection requests and read relationship status via Unipile's managed-browser API.",
  guide: `Use Unipile's managed-browser API to send LinkedIn connection requests and read relationship signals from the server side — no DOM automation, no Browserbase session juggling.

### Prerequisites
A [Unipile](https://www.unipile.com) account with at least one LinkedIn account connected through the Unipile dashboard. The connected LinkedIn account is what actually fires the connection request — Unipile is the API layer in front of it.

### How to get credentials
1. Sign in to the [Unipile dashboard](https://dashboard.unipile.com).
2. Open **Settings → API** and copy your **DSN** (e.g. \`api41.unipile.com:17153\`) — set it as \`UNIPILE_DSN\`.
3. From the same screen, copy your **API Token** and set it as \`UNIPILE_TOKEN\`.
4. In **Accounts → Add account**, connect a LinkedIn account (Sales Navigator-tier recommended for higher daily quotas).
5. Paste both env vars in the /config Credentials tab and click Test. The probe calls Unipile and verifies that at least one LinkedIn account is wired — without that you get connected-but-useless ambiguity.

### Notes
- This is the Phase 68 Wave-0 stub manifest: zero tools ship in this plan. The two real tools (\`linkedin_send_connection\`, \`linkedin_get_relationship_status\`) arrive in Plan 06.
- Audit log entries (Plan 03) live 90 days in Upstash KV and store only a SHA-256 of \`{tool, profile_url, note}\` — never the note text itself.`,
  requiredEnvVars: ["UNIPILE_DSN", "UNIPILE_TOKEN"],
  testConnection: async (credentials) => {
    const dsn = credentials.UNIPILE_DSN;
    const token = credentials.UNIPILE_TOKEN;
    if (!dsn || !token) {
      return { ok: false, message: "Missing UNIPILE_DSN or UNIPILE_TOKEN" };
    }
    return probe(dsn, token);
  },
  diagnose: async () => {
    const dsn = getConfig("UNIPILE_DSN");
    const token = getConfig("UNIPILE_TOKEN");
    if (!dsn || !token) {
      return { ok: false, message: "UNIPILE_DSN or UNIPILE_TOKEN not set" };
    }
    return probe(dsn, token);
  },
  // Stub — Plan 06 replaces this with the real 2-tool surface.
  tools: [] as ToolDefinition[],
};
