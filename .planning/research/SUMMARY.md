# Project Research Summary

**Project:** MyMCP Framework Transformation
**Domain:** Personal MCP server to open-source framework (Next.js / Vercel)
**Researched:** 2026-04-08
**Confidence:** MEDIUM-HIGH

## Executive Summary

MyMCP is a personal MCP server with 38 production-ready tools across four domains (Obsidian vault, Google Workspace, browser automation, admin) that needs to become a forkable open-source framework. The core challenge is not building new functionality -- the tools already exist and work -- but restructuring a monolithic, hardcoded personal server into a modular, configurable system that any developer can deploy in under 15 minutes. The dominant pattern in this space (guMCP, MCPJungle, n8n) is config-driven tool packs with per-user OAuth credentials, and MyMCP should follow it.

The recommended approach is a registry pattern with tool packs: reorganize 38 tools into 4 packs (vault, google, browser, admin), introduce a single `mcp.config.ts` for all user configuration, and gate tool loading on both config flags and environment variable presence. The existing stack (Next.js 16, TypeScript 6, Zod 4, MCP SDK) is solid and needs minimal changes -- the main additions are shadcn/ui + Tailwind v4 for a setup wizard UI and Arctic for lightweight Google OAuth. No database, no state management library, no plugin system.

The two existential risks are Google OAuth verification (each user must create their own OAuth app -- a shared client ID would cap adoption at 100 users) and hardcoded personal references scattered across 25+ files (timezone, locale, name). Both must be resolved before any public release. Secondary risks include LLM context overload from 38 simultaneous tools (solved by pack-level gating) and Vercel serverless state loss (accept ephemeral logs, do not build features requiring cross-request state).

## Key Findings

### Recommended Stack

The existing stack is mature and correct for the use case. No major technology changes are needed -- only targeted additions for new capabilities (setup wizard, OAuth flow).

**Core technologies (keep):**
- **Next.js 16 + TypeScript 6**: Already in place, proven for Vercel serverless MCP hosting
- **@modelcontextprotocol/sdk**: Upgrade from ^1.26.0 to ^1.29.0 for better dynamic tool support
- **Zod 4**: Already used for tool schemas, reuse for form validation via @hookform/resolvers

**Additions (new):**
- **shadcn/ui + Tailwind v4**: Setup wizard UI -- components owned in codebase, no dependency lock-in
- **Arctic ^3.7.0**: Lightweight OAuth client for one-time Google consent flow (NOT Auth.js -- wrong tool for single-user setup)
- **React Hook Form**: Multi-step wizard forms with Zod integration
- **sonner**: Toast notifications (shadcn recommended)

**Explicitly rejected:** Prisma/any ORM (no database needed), Auth.js (over-engineered for single-user), tRPC (only 3-4 API routes), Zustand/Redux (no global state), Docker (wrong deployment target).

### Expected Features

**Must have (table stakes):**
- Config-driven tool registry with pack enable/disable -- the core architectural change
- Tool packs: vault (15), google (18), browser (4), admin (1)
- Remove all hardcoded personal references (timezone, locale, name) into config
- `.env.example` with documentation + Vercel Deploy button
- Clear README with quickstart under 5 minutes
- Enhanced health endpoint showing active packs

**Should have (differentiators):**
- Setup wizard UI at `/` -- walks users through OAuth, vault, browser config
- Built-in Google OAuth consent flow -- eliminates #1 setup friction
- Status dashboard -- active tools, recent calls, error rates
- 38 pre-built tools across 4 domains -- this IS the moat

**Defer (v2+):**
- Multi-backend vault (Notion, S3) -- scope explosion
- Multi-provider auth (Microsoft 365) -- doubles auth complexity for 20% more users
- Plugin marketplace -- premature with 0 users
- Multi-user / RBAC -- this is a personal server
- Internationalization -- English only for v1

### Architecture Approach

The recommended architecture is a **registry pattern with tool packs** (Option A from ARCHITECTURE.md). Tools move from flat `src/tools/` into `src/packs/{vault,google,browser,admin}/tools/`, each pack has a manifest (`index.ts`) exporting a ToolDefinition array, and a central registry collects enabled tools based on config + env var presence. Route.ts shrinks from 335 lines of static imports to a simple loop over the registry output.

**Major components:**
1. **`mcp.config.ts`** -- Single user-facing config file (packs, user settings, server metadata)
2. **`src/registry/`** -- Collects ToolDefinitions from enabled packs, filters by env vars
3. **`src/packs/*/`** -- Self-contained pack directories (tools, lib, manifest)
4. **`src/lib/`** -- Shared utilities only (logging, user-context) -- pack-specific code stays in pack
5. **`app/api/[transport]/route.ts`** -- Thin MCP endpoint: auth + registry loop

**Key architectural decisions:**
- Static imports with conditional registration (not dynamic imports -- createMcpHandler callback is synchronous)
- Pack-level env var gating: missing GOOGLE_CLIENT_ID = no Google tools registered
- User config injection via shared module (replaces 25+ hardcoded references)
- No filesystem scanning at runtime (does not work on Vercel serverless)

### Critical Pitfalls

1. **Google OAuth verification trap** -- Shared OAuth client ID caps at 100 users and triggers months-long Google review. Each user MUST create their own Google Cloud project. Setup wizard must guide this process with pre-filled scopes and copy-paste instructions.

2. **Hardcoded personal references** -- 25+ files contain Europe/Paris, fr-FR, or Yassine. Must be extracted to config before any public release. Add automated grep check in CI to prevent regression.

3. **38 tools overwhelming LLM context** -- All tools registered simultaneously wastes context tokens and degrades model tool selection. Pack-level gating based on config + env vars is the solution. Default to minimal: only register what the user has credentials for.

4. **Vercel serverless state loss** -- In-memory log buffer and token cache are ephemeral. Accept this for logs (best-effort), do not build features requiring cross-request state without external storage.

5. **Breaking existing functionality during refactor** -- Tool names, endpoint paths, and auth must remain stable through the entire transformation. The refactor changes internal structure, not external API.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation (Config + Registry + Depersonalization)

**Rationale:** Everything else depends on this. You cannot build a setup wizard until config exists. You cannot ship publicly with hardcoded personal references. The tool registry is the core architectural change that transforms a personal server into a framework.

**Delivers:** Configurable MCP server with pack-based tool loading, all personal references extracted to config, clean package.json with LICENSE.

**Addresses features:** Config-driven tool registry, tool packs, remove hardcoded references, .env.example, enhanced health endpoint.

**Avoids pitfalls:** Hardcoded context (#2), LLM context overload (#3), premature abstraction (#8), breaking changes (#7).

**Build order (from ARCHITECTURE.md):** Types -> Config -> File reorganization into packs -> Pack manifests -> Registry -> Route.ts refactor -> User config injection.

**Warning:** The file reorganization step (moving 38 tool files + lib files into pack directories) is the highest-risk step. Must be a single atomic commit with all import paths updated. Build check immediately after.

### Phase 2: Google OAuth + Setup Wizard

**Rationale:** With config in place, the setup wizard can read/write it. Google OAuth is the #1 adoption blocker -- manual refresh token setup is a 15-step process that kills conversion. The wizard transforms this into "Click Connect Google."

**Delivers:** Web-based setup wizard at / with Google OAuth consent flow, tool pack configuration UI, and status dashboard.

**Uses:** Arctic (OAuth), shadcn/ui + Tailwind v4 (UI), React Hook Form (wizard forms), sonner (toasts).

**Avoids pitfalls:** OAuth verification trap (#1 -- each user creates own OAuth app), setup wizard security (#6 -- auth-gate the wizard), env var explosion (#12 -- wizard handles configuration).

**Warning:** This phase has the most unknowns. Arctic for Google OAuth is correct in theory but needs validation. The Vercel API for programmatic env var storage is LOW confidence. The OAuth consent screen UX for guiding users through Google Cloud Console is a design challenge.

### Phase 3: Polish + Launch Preparation

**Rationale:** Framework works, setup works -- now make it shippable. Documentation, deploy button, tool description optimization, and real user testing.

**Delivers:** Vercel Deploy button, comprehensive README with quickstart, optimized tool descriptions for LLM selection, 2-3 beta tester validations.

**Addresses features:** Deploy button, README, tool description quality.

**Avoids pitfalls:** README-driven development trap (#10 -- test with real users before polishing docs), license compliance (#11 -- add MIT license, audit dependencies).

### Phase Ordering Rationale

- **Phase 1 before Phase 2:** Config system is a prerequisite for the setup wizard. You cannot build a UI to configure something that does not have a config layer yet.
- **Phase 1 before Phase 3:** Cannot write a README or deploy button for a framework that still has hardcoded personal references in the code.
- **Phase 2 before Phase 3:** The setup wizard IS the onboarding experience. Documentation describes it, not replaces it.
- **File reorg is Phase 1, not Phase 0:** Reorganizing into packs is the riskiest step but must happen early because everything builds on the pack structure.
- **OAuth is Phase 2, not Phase 1:** The framework can launch with manual token setup (documented clearly) if OAuth takes longer than expected. High-value but not blocking.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (OAuth + Wizard):** Google OAuth consent flow UX, Arctic library validation for Google scopes, Vercel API for env var management, setup wizard auth/security model. This phase has the most unknowns and lowest-confidence stack decisions.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Registry pattern, config file, file reorganization -- all well-documented patterns with clear implementation paths from ARCHITECTURE.md.
- **Phase 3 (Launch):** Deploy button, README, testing -- standard open-source launch checklist.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Existing stack is proven. Additions (shadcn, Arctic, RHF) are well-documented with official guides. Only Arctic (MEDIUM) needs implementation validation. |
| Features | MEDIUM-HIGH | Table stakes and differentiators are clear from competitive analysis. MVP prioritization is sound. Setup wizard complexity may be underestimated. |
| Architecture | HIGH | Registry pattern is simple, well-reasoned, with clear build order. All alternatives were evaluated and rejected with rationale. Implementation path is concrete. |
| Pitfalls | HIGH | Based on direct codebase analysis + official platform documentation (Vercel limits, Google OAuth). Pitfalls are specific and actionable, not generic. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Arctic + Google OAuth integration:** MEDIUM confidence. Correct architectural choice but needs validation with Google full scope set (Gmail restricted scopes, Calendar, Drive, Contacts). Validate during Phase 2 planning with a proof-of-concept.
- **Vercel API for env var management:** LOW confidence. Nice-to-have for wizard to programmatically set env vars after OAuth. May not be worth the complexity. Decide during Phase 2 implementation.
- **Tool description optimization for LLM selection:** No research was done on optimal MCP tool description patterns. Empirical testing needed -- have Claude select tools with all 38 registered and measure accuracy. Do during Phase 3.
- **Browserbase dependency longevity:** Browser pack depends on @browserbasehq/stagehand and SDK. No assessment of stability or pricing changes. Low risk for v1 but worth monitoring.
- **MCP SDK v2 timeline:** SDK is at 1.29.0, pinned to ^1.29.0. If v2 ships with breaking changes during development, migration work could disrupt the roadmap. Monitor the MCP SDK changelog.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: route.ts (38 tools), google-auth.ts, calendar.ts, logging.ts -- direct inspection
- [mcp-handler (Vercel)](https://github.com/vercel/mcp-handler) -- createMcpHandler API, withMcpAuth
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- tool registration, v1.29.0
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations) -- 4.5 MB payload, serverless constraints
- [Google OAuth Verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) -- scope requirements, testing mode limits
- [shadcn/ui docs](https://ui.shadcn.com/docs) -- Tailwind v4, Next.js installation

### Secondary (MEDIUM confidence)
- [Arctic OAuth library](https://github.com/pilcrowonpaper/arctic) -- v3.7.0, Google provider support
- [guMCP](https://www.gumloop.com/mcp), [MCPJungle](https://github.com/mcpjungle/MCPJungle) -- competitive analysis
- [n8n Google OAuth Pattern](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/) -- self-hosted OAuth model
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/) -- architecture guidance

### Tertiary (LOW confidence)
- Vercel API for programmatic env var management -- needs validation
- Tool description optimization for LLM selection -- needs empirical testing

---
*Research completed: 2026-04-08*
*Ready for roadmap: yes*
