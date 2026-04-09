# Domain Pitfalls

**Domain:** Personal MCP server to open-source framework transformation
**Researched:** 2026-04-08

## Critical Pitfalls

Mistakes that cause rewrites, lost users, or abandoned adoption.

### Pitfall 1: Google OAuth Verification Trap

**What goes wrong:** The app requires Gmail, Calendar, Drive, and Contacts scopes -- all classified as "sensitive" or "restricted" by Google. An unverified OAuth app in "Testing" mode is limited to 100 test users maximum, and each must be manually added to the allowlist. Publishing the app for general use triggers Google's OAuth verification process, which requires domain ownership for privacy policy hosting, a security assessment for restricted scopes (Gmail read/send), and can take weeks to months (reports of 6+ month delays exist).

**Why it happens:** The current architecture uses a single OAuth client (Yassine's). For an open-source framework where each user deploys their own instance, the question is: who owns the OAuth app? If the framework ships a shared OAuth client ID, Google will require verification. If each user creates their own, the setup friction is enormous.

**Consequences:** Either (a) users are blocked at 100 with shared credentials, (b) framework gets stuck in Google verification limbo, or (c) each user faces a 15-step Google Cloud Console setup that kills adoption.

**Prevention:**
- Each user creates their own Google Cloud project and OAuth credentials (self-hosted pattern, same as n8n)
- The setup wizard MUST automate this as much as possible: pre-fill scopes, generate redirect URIs, provide copy-paste instructions with screenshots
- Document the "Testing" vs "Published" distinction clearly -- for personal use, Testing mode with yourself as the sole test user is sufficient
- Never ship a shared OAuth client ID in the open-source repo

**Detection:** Users reporting "Access blocked" screens, 403 errors on Google APIs, or confusion about OAuth consent screen configuration.

**Phase relevance:** Phase 1 (OAuth flow). This is THE critical path item. Get this wrong and nothing else matters.

### Pitfall 2: Hardcoded Personal Context Everywhere

**What goes wrong:** The codebase has 25+ instances of `Europe/Paris` timezone, `fr-FR` locale, and references to "Yassine" in tool descriptions. These are spread across `calendar.ts`, `calendar-find-free.ts`, `calendar-events.ts`, `gmail-inbox.ts`, `gmail-search.ts`, `drive-search.ts`, `linkedin-feed.ts`, `mcp-logs.ts`, `browserbase.ts`, and `route.ts`. A find-and-replace misses some, breaks others, and the framework ships with French formatting for English-speaking users.

**Why it happens:** Personal tools naturally embed the author's preferences. These were never designed to be configurable because there was only one user.

**Consequences:** Framework feels unprofessional ("who is Yassine?"), calendar tools show wrong timezone, date formatting is wrong for non-French users, working hours (8h-19h hardcoded in `findFreeTime`) don't match user's schedule.

**Prevention:**
- Create a centralized `config.ts` that exports all user-configurable values: timezone, locale, working hours, display name
- Source these from environment variables with sensible defaults (e.g., `TIMEZONE=UTC`, `LOCALE=en-US`)
- Audit every file in `src/tools/` and `src/lib/` for hardcoded locale/timezone/name references before any public release
- The config file should be the ONLY place these values live

**Detection:** `grep -r "Europe/Paris\|fr-FR\|Yassine" src/` returns results after the refactor phase.

**Phase relevance:** Phase 1 (configuration system). Must be complete before public release.

### Pitfall 3: 38 Tools Overwhelming the LLM Context

**What goes wrong:** All 38 tools are registered simultaneously in a single `route.ts`. MCP clients send all tool schemas to the LLM on every request. With 38 tools, that's thousands of tokens of schema before the user even asks a question. Models make worse tool selection decisions when presented with too many options, especially when tools have overlapping names (e.g., `vault_read` vs `drive_read`, `gmail_search` vs `gmail_inbox`).

**Why it happens:** Tools were added one at a time for personal use where the user already knew which tool to invoke. At scale, the tool surface area degrades model performance.

**Consequences:** Slow responses (large context), wrong tool selection, confused models, poor first impressions for new users.

**Prevention:**
- Tool packs that can be enabled/disabled via config (already in the plan as "dynamic tool registry")
- Default to minimal tool set -- only enable packs the user has configured credentials for
- If `GOOGLE_CLIENT_ID` is not set, don't register any Google tools
- If `GITHUB_PAT` is not set, don't register vault tools
- Tools should auto-discover from filesystem + env var presence, not hardcoded imports

**Detection:** Users reporting "Claude picked the wrong tool" or slow initial responses. Count tool registrations in logs.

**Phase relevance:** Phase 1 (tool registry). Core architectural change.

### Pitfall 4: Vercel Serverless State Loss

**What goes wrong:** The current `logging.ts` uses an in-memory ring buffer for logs. On Vercel serverless, each function invocation may run in a different instance. Logs disappear between cold starts. The `cachedToken` in `google-auth.ts` works within a warm instance but is lost on cold starts, causing unnecessary token refreshes. Any future feature that assumes persistent state (sessions, rate limiting, usage tracking) will silently fail.

**Why it happens:** The code was written for a single always-warm instance mental model, not serverless ephemeral compute.

**Consequences:** Logs are unreliable, rate limiting (LinkedIn daily limit) resets on cold starts, OAuth tokens refresh more than needed (wasted API calls, potential rate limits from Google), future features built on in-memory state break unpredictably.

**Prevention:**
- Document clearly which state is ephemeral vs persistent
- For logs: accept that in-memory logs are best-effort, or add optional external logging (Vercel Log Drain, Upstash)
- For token caching: the 5-minute margin in `google-auth.ts` is fine -- token refresh is cheap and Google allows it. Don't over-engineer this.
- For rate limiting: use Vercel KV or Upstash Redis if precise limits matter, or accept approximate limits
- Never build features that REQUIRE cross-request state without external storage

**Detection:** Users reporting "mcp_logs shows nothing" after a period of inactivity, or rate limits not being enforced.

**Phase relevance:** Phase 2 (status/health). Important for observability features.

## Moderate Pitfalls

### Pitfall 5: Request Body Size Limit (4.5 MB)

**What goes wrong:** Vercel Functions have a 4.5 MB request/response body limit. Tools like `vault_batch_read` (20 files), `vault_search`, or `gmail_attachment` can easily exceed this when returning large content. The `save_article` tool already has a 5 MB limit check, but that's the article size, not the function response size.

**Prevention:**
- Add response size checks before returning large payloads
- Implement truncation with a "content too large, showing first N bytes" message
- For batch operations, return summaries with an option to read individual items
- Document the 4.5 MB limit in tool descriptions so the LLM knows to request smaller batches

**Phase relevance:** Phase 2 (hardening). Should be addressed when stress-testing tools.

### Pitfall 6: Setup Wizard Security Exposure

**What goes wrong:** The planned setup wizard at `/` creates a web UI that handles OAuth tokens and configuration. If not properly secured, this becomes an attack vector. Anyone who discovers the Vercel URL can access the setup page, potentially triggering OAuth flows or viewing configuration.

**Prevention:**
- Setup wizard MUST be behind the same auth as the MCP endpoint (bearer token)
- Consider a one-time setup flow that disables itself after initial configuration
- Never display full tokens/secrets in the UI -- show masked versions
- Add CSRF protection to the setup wizard forms
- The wizard should generate the config, not store secrets in a database

**Detection:** Setup page accessible without authentication in production.

**Phase relevance:** Phase 2 (setup wizard). Design auth before building UI.

### Pitfall 7: Breaking Existing Users During Refactor

**What goes wrong:** The refactor from monolithic `route.ts` to dynamic tool registry changes how tools are registered. Existing users (including Yassine) who have Claude Desktop configured with the current endpoint break if the API contract changes. Tool names change, endpoints move, or auth flow changes.

**Prevention:**
- Keep the `/api/[transport]` endpoint path stable -- it's already correct
- Keep all tool names exactly as they are (`vault_read`, `gmail_send`, etc.)
- Keep bearer token auth working alongside any new auth mechanism
- Implement the new tool registry behind the same interface
- Test the refactored version against the same Claude Desktop config before releasing

**Detection:** Existing MCP client configurations stop working after a deploy.

**Phase relevance:** Every phase. Backward compatibility is a constraint, not a feature.

### Pitfall 8: Premature Abstraction in Tool Registry

**What goes wrong:** Building an overly flexible plugin system with hooks, middleware chains, dependency injection, and tool lifecycle management when what's needed is "load tools from files if their env vars exist." The code becomes harder to understand than the monolithic version it replaced.

**Prevention:**
- Start with the simplest thing: scan `src/tools/` directory, check if required env vars exist, register tool if they do
- Each tool file exports `{ name, description, schema, handler, requiredEnvVars }`
- The registry is a for loop, not a framework
- No plugin API, no hooks, no lifecycle. Just conditional registration.
- Add abstraction only when you have 3 concrete use cases that need it

**Detection:** The tool registry code is longer than 100 lines, or requires documentation to understand.

**Phase relevance:** Phase 1 (tool registry). Resist the urge to over-engineer.

### Pitfall 9: Tool Description Quality for Model Selection

**What goes wrong:** Tool descriptions are written for humans, not LLMs. The current descriptions are good for personal use but some overlap conceptually: `gmail_inbox` vs `gmail_search`, `vault_read` vs `vault_batch_read`, `web_browse` vs `web_extract`. When all tools are registered, models struggle to pick the right one.

**Prevention:**
- Each tool description must start with WHEN to use it, not WHAT it does
- Add explicit "Use X instead when..." guidance in descriptions
- Test tool selection by asking Claude "which tool would you use for [scenario]?" with all tools registered
- Keep descriptions under 2 sentences -- long descriptions waste context tokens

**Detection:** Model consistently picks wrong tool for common tasks.

**Phase relevance:** Phase 1 (tool registry refactor). Rewrite descriptions during the migration.

## Minor Pitfalls

### Pitfall 10: README-Driven Development Trap

**What goes wrong:** Spending weeks perfecting README, documentation, and marketing materials before the framework actually works for anyone other than the author. The README promises a "5-minute setup" but nobody has tested it.

**Prevention:**
- Have 2-3 friends/colleagues deploy the framework from scratch using only the README before publishing
- Time their setup. If it takes more than 15 minutes, simplify.
- Write the README last, after the setup wizard works

**Detection:** No one outside the author has successfully deployed the framework.

**Phase relevance:** Final phase (launch preparation). Real user testing before announcement.

### Pitfall 11: License and Dependency Compliance

**What goes wrong:** The project uses `mcp-handler` (Vercel), `@browserbasehq/stagehand`, and `@browserbasehq/sdk` as dependencies. If any of these have restrictive licenses or become unmaintained, the framework inherits their constraints. The current `package.json` has `"private": true` and no license field.

**Prevention:**
- Add a LICENSE file (MIT is standard for developer tools)
- Audit all dependency licenses before open-sourcing
- Pin major versions of critical dependencies (`mcp-handler`, `@modelcontextprotocol/sdk`)
- Remove `"private": true` from `package.json`

**Detection:** Missing LICENSE file, `"private": true` still in package.json at launch.

**Phase relevance:** Phase 1 (clean package.json). Quick fix but easy to forget.

### Pitfall 12: Env Var Explosion

**What goes wrong:** The framework currently needs `MCP_AUTH_TOKEN`, `GITHUB_PAT`, `GITHUB_REPO`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `MEDIUM_SID`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `OPENROUTER_API_KEY`, and more. Each tool pack adds 2-4 env vars. New users face a wall of 15+ environment variables to configure.

**Prevention:**
- Group env vars by tool pack in `.env.example` with clear comments
- Only require env vars for enabled tool packs
- The setup wizard should handle env var configuration
- Provide a validation script (`npm run check-config`) that reports which tool packs are ready

**Detection:** Users opening issues about "which env vars do I actually need?"

**Phase relevance:** Phase 1 (configuration). Part of the setup experience.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Tool Registry | Over-engineering the plugin system (#8) | Keep it to a for loop. No frameworks. |
| OAuth Flow | Google verification blocking adoption (#1) | Each user creates own OAuth app. Wizard guides them. |
| Configuration | Missing hardcoded references (#2) | Automated grep check in CI |
| Configuration | Env var overwhelm (#12) | Group by pack, validate on startup |
| Setup Wizard | Security exposure (#6) | Auth-gate the wizard, one-time setup mode |
| Status/Health | Relying on in-memory state (#4) | Accept ephemeral logs or add external storage |
| Launch | No real user testing (#10) | 2-3 beta testers before public announcement |
| All Phases | Breaking existing functionality (#7) | Keep tool names and endpoint paths stable |

## Sources

- Codebase analysis: `route.ts` (38 hardcoded tool imports), `google-auth.ts` (refresh token flow), `calendar.ts` (hardcoded timezone/locale), `logging.ts` (in-memory state)
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations) -- 4.5 MB payload, 300s hobby timeout, 1024 file descriptors
- [Google OAuth Verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) -- sensitive/restricted scope requirements
- [Google OAuth Consent Screen](https://support.google.com/cloud/answer/13463073) -- Testing mode 100-user limit
- [Nearform MCP Implementation Pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) -- tool naming, schema design, state management
- [MCP Security Vulnerabilities](https://equixly.com/blog/2025/03/29/mcp-server-new-security-nightmare/) -- auth gaps in MCP ecosystem
- [n8n Google OAuth Pattern](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/) -- self-hosted OAuth credential pattern
- [Vercel MCP Handler](https://github.com/vercel/mcp-handler) -- Streamable HTTP transport, stateless model
