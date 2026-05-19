/**
 * Phase 68 / Plan 06 / Task 2 — linkedin_get_relationship_status tool.
 *
 * Read-only counterpart to linkedin_send_connection. Returns the network
 * distance (degree) of a LinkedIn profile relative to the connected
 * account's network.
 *
 * Envelope (D-21, LOCKED for phase 68):
 *   {
 *     degree: 1 | 2 | 3 | null,    // 1=connection, 2=2nd, 3=3rd, null=out-of-network OR missing
 *     connection_status: string,    // raw network_distance value, or "unknown"
 *     error?: string,
 *     available_accounts?: string[],
 *   }
 *
 * NOT in the envelope (deferred to phase 69 when messaging tools land):
 *   messaging-derived signals (when last contacted, whether the contact
 *   replied) are intentionally excluded — Unipile's `getProfile` does not
 *   expose them. Phase 69 will add `client.messaging.getAllMessagesFromChat`
 *   wrappers and wire those fields in.
 *
 * Pitfall 3 (RESEARCH.md): `network_distance` is OPTIONAL on
 * LinkedinUserProfileSchema. A missing field maps to `degree: null`,
 * NEVER "third degree" — that would silently report a stranger as a
 * 3rd-degree connection, which the operator can act on incorrectly.
 *
 * No audit row written: this is a pure read with no PII transit
 * (the URL is the input; the profile result is not persisted).
 */

import { z } from "zod";
import type { ToolResult } from "@/core/types";
import { getUnipileClient } from "../lib/client";
import { withRetry } from "../lib/retry";
import { resolveProviderId, normalizeProfileUrl } from "../lib/identifiers";
import { resolveAccountId } from "../lib/account";
import { classifyUnipileError } from "../lib/errors";

export const linkedinGetRelationshipStatusSchema = {
  profile_url: z
    .string()
    .url()
    .describe(
      "Public LinkedIn profile URL. Returns the network distance (1/2/3/null) of this profile relative to the connected account."
    ),
  account_id: z
    .string()
    .optional()
    .describe(
      "Unipile LinkedIn account_id. Optional — if exactly one LinkedIn account is connected, it is used silently."
    ),
};

type GetRelArgs = {
  profile_url: string;
  account_id?: string;
};

interface RelStatusEnvelope {
  degree: 1 | 2 | 3 | null; // D-21: 1|2|3|null only
  connection_status: string; // raw network_distance value, or "unknown"
  error?: string;
  available_accounts?: string[];
}

function envelope(e: RelStatusEnvelope): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }] };
}

/**
 * Map Unipile's network_distance string to the public 1|2|3|null degree.
 *
 * Per Pitfall 3: a MISSING `network_distance` field is NOT "third degree"
 * — it is `null` (unknown / private profile / sparse data). Defaulting to
 * 3 would silently classify strangers as warm targets.
 *
 * OUT_OF_NETWORK also maps to null (not 4 or "out"): operators care about
 * the warm/cold binary signal, and null already conveys "no reachable
 * relationship".
 */
function mapDegree(networkDistance: string | undefined): 1 | 2 | 3 | null {
  switch (networkDistance) {
    case "FIRST_DEGREE":
      return 1;
    case "SECOND_DEGREE":
      return 2;
    case "THIRD_DEGREE":
      return 3;
    case "OUT_OF_NETWORK":
      return null;
    default:
      return null;
  }
}

export async function handleLinkedinGetRelationshipStatus(args: GetRelArgs): Promise<ToolResult> {
  // exactOptionalPropertyTypes: only pass `account_id` when defined.
  const acct = await resolveAccountId(
    args.account_id !== undefined ? { account_id: args.account_id } : {}
  );
  if ("error" in acct) {
    const env: RelStatusEnvelope = {
      degree: null,
      connection_status: "unknown",
      error: acct.error,
    };
    if ("available_accounts" in acct) env.available_accounts = acct.available_accounts;
    return envelope(env);
  }
  const accountId = acct.accountId;

  // Resolve provider_id — also warms the URN cache for the next
  // linkedin_send_connection call against the same profile. The returned
  // provider_id is intentionally not consumed below (getProfile is called
  // with the slug as identifier, per Unipile's SDK signature).
  try {
    await resolveProviderId(args.profile_url, accountId);
  } catch (err) {
    return envelope({
      degree: null,
      connection_status: "unknown",
      error: classifyUnipileError(err),
    });
  }

  // Call getProfile to read network_distance. The identifier is the slug
  // (last segment of the normalized URL).
  let slug: string;
  try {
    slug = normalizeProfileUrl(args.profile_url).slice("https://linkedin.com/in/".length);
  } catch (err) {
    return envelope({
      degree: null,
      connection_status: "unknown",
      error: err instanceof Error ? err.message : "invalid_profile_url",
    });
  }

  try {
    const profile = await withRetry(() =>
      getUnipileClient().users.getProfile({ account_id: accountId, identifier: slug })
    );
    const nd = (profile as { network_distance?: string }).network_distance;
    return envelope({
      degree: mapDegree(nd),
      connection_status: nd ?? "unknown",
    });
  } catch (err) {
    return envelope({
      degree: null,
      connection_status: "unknown",
      error: classifyUnipileError(err),
    });
  }
}
