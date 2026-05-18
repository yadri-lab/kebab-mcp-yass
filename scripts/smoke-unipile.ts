/**
 * Live smoke test for the Unipile connector tools (phase 68 acceptance).
 *
 * Loads .env, invokes the two real tool handlers against the live Unipile
 * API + connected LinkedIn account, prints the result envelopes.
 *
 * NOT a unit test — intentional live calls. Skip in CI.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/smoke-unipile.ts [scenario]
 *
 * Scenarios:
 *   get-self      → linkedin_get_relationship_status on operator's own profile (safe baseline)
 *   get <url>     → linkedin_get_relationship_status on any profile URL
 *   send-self     → linkedin_send_connection on operator's own profile (expects upstream rejection)
 *   send <url>    → linkedin_send_connection on any profile URL (ACTUALLY SENDS AN INVITATION)
 *   engage-dry <url> → linkedin_engage with dry_run:true (zero-risk preview)
 *   list-pending  → linkedin_list_pending (read-only)
 *   antoine       → re-validation of the 2026-05-18 Antoine Vercken / Browserbase failure
 */

import { handleLinkedinGetRelationshipStatus } from "../src/connectors/unipile/tools/linkedin-get-relationship-status";
import { handleLinkedinSendConnection } from "../src/connectors/unipile/tools/linkedin-send-connection";
import { handleLinkedinEngage } from "../src/connectors/unipile/tools/linkedin-engage";
import { handleLinkedinListPending } from "../src/connectors/unipile/tools/linkedin-list-pending";

const SELF_URL = "https://linkedin.com/in/yassineht";
const ANTOINE_URL = "https://linkedin.com/in/antoinevercken";

function printResult(label: string, result: { content: Array<{ type: string; text: string }> }) {
  console.log(`\n=== ${label} ===`);
  for (const c of result.content) {
    if (c.type === "text") {
      try {
        const parsed = JSON.parse(c.text);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(c.text);
      }
    } else {
      console.log(`[${c.type}]`, c);
    }
  }
}

async function main() {
  if (!process.env.UNIPILE_DSN || !process.env.UNIPILE_TOKEN) {
    console.error("MISSING UNIPILE_DSN or UNIPILE_TOKEN in env. Check .env.");
    process.exit(1);
  }
  console.log(`Unipile DSN: ${process.env.UNIPILE_DSN}`);
  console.log(`Unipile TOKEN: ${process.env.UNIPILE_TOKEN.slice(0, 12)}…(masked)`);

  const scenario = process.argv[2] ?? "get-self";
  const target = process.argv[3];

  switch (scenario) {
    case "get-self": {
      const r = await handleLinkedinGetRelationshipStatus({ profile_url: SELF_URL });
      printResult(`GET relationship status — self (${SELF_URL})`, r);
      break;
    }
    case "get": {
      if (!target) {
        console.error("usage: npx tsx scripts/smoke-unipile.ts get <profile_url>");
        process.exit(1);
      }
      const r = await handleLinkedinGetRelationshipStatus({ profile_url: target });
      printResult(`GET relationship status — ${target}`, r);
      break;
    }
    case "send-self": {
      const r = await handleLinkedinSendConnection({
        profile_url: SELF_URL,
        actor_user_id: "smoke-test",
      });
      printResult(`SEND connection — self (${SELF_URL}) [expects upstream rejection]`, r);
      break;
    }
    case "send": {
      if (!target) {
        console.error("usage: npx tsx scripts/smoke-unipile.ts send <profile_url> [note]");
        process.exit(1);
      }
      const note = process.argv[4];
      const r = await handleLinkedinSendConnection({
        profile_url: target,
        ...(note ? { note } : {}),
        actor_user_id: "smoke-test",
      });
      printResult(`SEND connection — ${target}${note ? ` (note: "${note}")` : ""}`, r);
      break;
    }
    case "engage-dry": {
      if (!target) {
        console.error(
          "usage: npx tsx --env-file=.env scripts/smoke-unipile.ts engage-dry <profile_url>"
        );
        process.exit(1);
      }
      const r = await handleLinkedinEngage({
        profile_url: target,
        message: "Bonjour, ravi de te recontacter !",
        dry_run: true,
        actor_user_id: "smoke-test-engage-dry",
      });
      printResult(`ENGAGE dry_run — ${target}`, r);
      break;
    }
    case "list-pending": {
      const r = await handleLinkedinListPending({});
      printResult(`LIST pending invitations`, r);
      break;
    }
    case "antoine": {
      console.log("⚠ Antoine Vercken re-validation — this WILL send a real invitation");
      const r = await handleLinkedinSendConnection({
        profile_url: ANTOINE_URL,
        note: "Hello Antoine, I'm reaching out because we had a brief touchpoint via Trusk earlier this year.",
        actor_user_id: "smoke-test-antoine-revalidation",
      });
      printResult(`SEND connection — Antoine Vercken (2026-05-18 re-validation)`, r);
      break;
    }
    default:
      console.error(`Unknown scenario: ${scenario}`);
      console.error("Available: get-self, get <url>, send-self, send <url> [note], antoine");
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("\n=== SMOKE TEST CRASHED ===");
  if (err instanceof Error) {
    console.error(err.message);
    console.error(err.stack);
  } else {
    console.error(err);
  }
  process.exit(1);
});
