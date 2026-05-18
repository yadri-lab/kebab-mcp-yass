# ADR 0001 — Unipile as LinkedIn / WhatsApp Write Provider

- **Status:** Accepted
- **Date:** 2026-05-18
- **Deciders:** Yassine (Founder)
- **Scope:** `src/connectors/unipile/` (new connector, milestone v0.17)

## Context

Kebab MCP needs to perform **write actions on LinkedIn** (send connection request, send DM, send InMail) and on **WhatsApp** (send text/media messages, list chats, read conversations) from inside MCP tool calls. These actions are the missing half of the GTM prospection workflow — read-side enrichment is already covered by the `apify` and `browser` connectors.

The first attempt used the existing `browser` connector (Browserbase + Stagehand `web_act`) to drive a LinkedIn UI session and click the "Connect" button. It **failed silently in production** on 2026-05-18 against a real prospect: both `web_act` calls returned `done`, no errors were raised, but the connection request never reached LinkedIn's servers. The button stayed blue in the user's browser after refresh.

Root-cause investigation (web research + Stagehand issue tracker) surfaced three converging causes:

1. **LinkedIn 2026 anti-bot stack.** Detects datacenter IPs, headless Chromium fingerprints, missing mouse-jitter, and the absence of a hover-before-click event sequence. LinkedIn intercepts the click event server-side and silently no-ops it — no captcha, no error.
2. **Browserbase basic stealth is insufficient** for LinkedIn write actions. Advanced Stealth Mode + mobile residential proxy is gated behind the Scale plan (~$130/mo all-in) and remains an asymmetric cat-and-mouse game.
3. **Stagehand bug #1434** (open) returns ambiguous XPath selectors that sometimes click a phantom element, compounding the silent-failure mode.

The write path needs a **stable, dedicated transport** that is purpose-built for LinkedIn/WhatsApp automation, runs in a server-managed browser with regional residential proxies + replicated fingerprints + humanized interactions, and surfaces failures explicitly (not silently).

## Options Considered

| Option | Capabilities | Setup cost | Recurring cost (Cadens-scale, 1 LI + 1 WA) | Maintenance burden | Verdict |
|---|---|---|---|---|---|
| **A. Unipile** | LI connect/DM/InMail/search/InMail + WA messaging + group chats + email + calendar; Node SDK; webhooks; 500+ endpoints | ~15 min (DSN + token + hosted wizard for each account) | **49 €/mo** (palier 1, up to 10 accounts, all channels) | Provider-side | ✅ **Chosen** |
| B. LinkedAPI (linkedapi.io) | LinkedIn-only; MCP server already wired in user's Claude tools; Classic + Sales Nav | ~10 min | 49 $/seat/mo annual (Core) — **74 $/seat/mo for Sales Nav (Plus)** — and no WhatsApp | Provider-side | LinkedIn-only, ~50% more expensive than Unipile at our scale, doesn't unlock WA |
| C. Browserbase Scale + mobile proxy + custom stealth | Full LinkedIn UI (read + write), custom WA via WA Web headless | 1-2j dev | ~$130/mo (Scale 99 $ + proxy 30 $) + ongoing maintenance | **Our team** — cat-and-mouse vs LinkedIn anti-bot updates monthly | Asymmetric fight against a vendor that won't prioritize defending our 5-30 actions/day; doesn't solve WA |
| D. Self-hosted Playwright + manual stealth | Full control | Several days dev | Server + residential proxy ~$50/mo | Our team — same anti-bot game as C, worse infra | Strictly worse than C |
| E. Status quo (manual clicks) | Reliable | 0 | 0 | 0 | ✅ Already works — keep as fallback, but does not scale |

## Decision

**Adopt Unipile as the canonical write provider for LinkedIn and WhatsApp.** Implement a new connector `src/connectors/unipile/` exposing both channels behind a unified manifest, sharing infrastructure (rate-limiter, dedup store, audit log, CRM outbox, webhook ingress).

The connector is purpose-built for prospection workflows, not a thin SDK wrapper. It encapsulates 9 high-level tools (5 LinkedIn, 4 WhatsApp) — see `.planning/milestones/v0.17-unipile-connector-ROADMAP.md` for the full catalog.

**Browserbase and Apify connectors remain in scope for read-only LinkedIn operations** (profile enrichment, posts scraping, company insights). The 2026-05-18 incident validated that read-side automation through Browserbase works fine — the anti-bot stack only flags write actions.

## Consequences

### Positive

- **Predictable failure mode.** Unipile surfaces HTTP errors (422 `cannot_resend_yet`, 429 rate limit, etc.) instead of silent no-ops. Write tools can return `{ verified: 'true'|'false'|'pending' }` honestly.
- **Multi-channel for the price of one.** Unipile pricing is per-account, not per-channel — a Cadens user connecting both LI + WA = 2 accounts = still within the 49 €/mo palier 1.
- **Multi-tenant ready.** One Unipile API key + per-tenant `account_id` mapping → Kebab can host multiple LI/WA accounts under one connector instance. Aligned with the v0.11 multi-tenant architecture already shipped.
- **Webhooks for free.** `new_relation` (LinkedIn connect accepted), `message.created` (inbound DM/WA message), `account.status` (credentials expired) — propagated to CRM bridges (Twenty for Cadens) without polling.
- **Compliance posture.** Unipile uses hosted browser + DMA-interoperability for WhatsApp + LinkedIn session storage on their side. Kebab never sees raw LinkedIn passwords or WA cookies.

### Negative / Risks

- **Vendor lock-in.** All LinkedIn/WhatsApp writes route through Unipile. Mitigation: connector internals abstract the SDK behind `linkedin/*.ts` and `whatsapp/*.ts` files — switching providers is a `client.ts` rewrite, not a fork-wide search-and-replace.
- **ToS gray area.** LinkedIn's ToS technically prohibit unofficial automation. Unipile claims compliance via DMA + hosted-browser arguments, but **LinkedIn could still ban a Kebab user's account** for excessive automation. Mitigation: conservative default daily caps (25 connects, 50 DMs, 15 InMails), explicit kill switch env var, warning if user overrides past LinkedIn red-flag thresholds.
- **Cost floor.** 49 €/mo even with zero usage (palier 1 minimum). For solo users this is meaningful — Browserbase free tier is 0 €. Mitigation: connector is opt-in via env vars (`UNIPILE_DSN` + `UNIPILE_TOKEN`); deployments that don't need writes don't pay.
- **Auth UX involves giving Unipile the LinkedIn password** (no LinkedIn OAuth for non-partners). Mitigation: documented clearly in connector guide; users should use a dedicated session and rotate password if concerned.
- **Webhook ingress required.** New `/api/unipile/webhook` route, signature verification, idempotency by event_id, KV-backed dedup. Net new infrastructure to maintain.

### Plan B (if Unipile fails or pricing changes)

- **Phase 1 fallback:** Switch the connector's `client.ts` to LinkedAPI's MCP for LinkedIn writes (already wired in Claude tools, so degraded mode is one connector swap).
- **Phase 2 fallback:** Drop write tools entirely, surface a `linkedin_engage_preview` tool that returns the relationship status + recommended action, and let the operator click manually. Acceptable for the 5-30 actions/day Cadens scale.

### Out of scope for this ADR

- WhatsApp Business Cloud API (Meta official) — not adopted because of template approval friction; revisit if Kebab ever needs transactional messages at scale.
- Linked API as primary provider — revisit if Unipile becomes unreliable or 2x more expensive.

## References

- Incident transcript: 2026-05-18 Antoine Vercken connect failure (recorded in Cadens GTM project).
- [Unipile pricing](https://www.unipile.com/pricing-api/)
- [Unipile LinkedIn endpoints](https://developer.unipile.com/docs/linkedin)
- [Unipile WhatsApp endpoints](https://developer.unipile.com/docs/whatsapp)
- [Unipile provider limits](https://developer.unipile.com/docs/provider-limits-and-restrictions)
- [Unipile webhooks](https://developer.unipile.com/docs/webhooks-2)
- [Unipile Node SDK](https://github.com/unipile/unipile-node-sdk)
- [Stagehand silent-click bug #1434](https://github.com/browserbase/stagehand/issues/1434)
- [Browserbase Stealth Mode docs](https://docs.browserbase.com/features/stealth-mode)
