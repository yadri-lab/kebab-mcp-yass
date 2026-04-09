# MyMCP — Personal MCP Framework

## What This Is

An open-source framework that lets technical users deploy a personal MCP server on Vercel in minutes. Users configure tool packs (Google Workspace, Obsidian vault, Browser automation) via env vars, and get a single MCP endpoint that connects to Claude Desktop, Claude.ai, or any MCP client. Built with Next.js/TypeScript, deployed on Vercel free tier.

## Core Value

One deploy gives you a personal AI backend with all your tools — email, calendar, notes, browser — behind a single MCP endpoint.

## Current Milestone: v1.0 Open Source Framework

**Goal:** Transform YassMCP into MyMCP — a clean, open-source personal MCP framework deployable by anyone technical.

**Target features:**
- Pack-based tool registry with static manifests and env var auto-activation
- Core types, config, auth separation (MCP + admin)
- Physical reorganization into packs (google, vault, browser, admin)
- Depersonalization + contract snapshot tests
- .env.example, README, Deploy to Vercel, LICENSE, CONTRIBUTING
- Private status dashboard with pack diagnostics
- Guided setup + Google OAuth flow

## Requirements

### Validated

- [x] MCP server running on Vercel with Streamable HTTP transport
- [x] Bearer token auth with timing-safe comparison
- [x] Obsidian vault tools (15): read, write, search, list, delete, move, append, batch read, recent, stats, backlinks, due, save article, read paywalled, my context
- [x] Gmail tools (9): inbox, read, send, reply, trash, label, search, draft, attachment
- [x] Calendar tools (6): events, create, update, delete, find free, RSVP
- [x] Contacts tool (1): search
- [x] Drive tools (2): search, read
- [x] Browser tools (4): web browse, web extract, web act, linkedin feed
- [x] Admin tools (1): MCP logs
- [x] Tool call logging with withLogging decorator
- [x] Security: SSRF protection, context allowlist, error sanitization, rate limiting

### Active

- [ ] Pack-based tool registry with static manifests, auto-activation by env var presence
- [ ] Core types (PackManifest, ToolDefinition, InstanceConfig) + config from env vars
- [ ] Auth separation: MCP_AUTH_TOKEN + ADMIN_AUTH_TOKEN (optional fallback)
- [ ] Physical reorganization: tools into src/packs/*/tools, libs into src/packs/*/lib
- [ ] Depersonalization: remove all hardcoded personal references
- [ ] Contract snapshot tests + smoke tests for registry
- [ ] .env.example with descriptions and source URLs
- [ ] README: what/why/quickstart/architecture/tool list
- [ ] Deploy to Vercel button
- [ ] package.json: name mymcp, LICENSE MIT, CONTRIBUTING.md
- [ ] Health: public liveness (ok, version), private diagnostics via dashboard
- [ ] Private status dashboard at / (auth-gated, pack status, MCP URL copy)
- [ ] Guided setup + Google OAuth flow (token displayed, user copies to Vercel)

### Out of Scope

- Multi-backend vault (Notion, S3, local filesystem) — Obsidian/GitHub only, avoids scope explosion
- Multi-provider auth (Microsoft, Apple) — Google Workspace covers 80% use case
- Tool marketplace or plugin system — premature abstraction
- Mobile app — MCP clients are desktop-based
- Paid hosting/SaaS — self-hosted framework only
- Enterprise features (multi-user, teams, RBAC) — personal tool
- mcp.config.ts user config file — env vars only, avoids fork divergence
- Auto-discovery runtime via filesystem — static manifests only
- Provider abstraction interfaces — clean module boundaries suffice
- Monorepo npm packages — logical separation in same project
- MYMCP_ENABLED_PACKS explicit list — auto-activation by env vars is simpler

## Context

**Origin:** YassMCP started as a personal MCP server. Grew to 38 tools covering Google Workspace, Obsidian vault, and browser automation via Stagehand/Browserbase. Code works but is hardcoded for one user.

**Architecture decisions (v1.0):**
- Env vars only for config (no user-facing config file)
- Pack auto-activation: all requiredEnvVars present → pack active
- Static manifests: each pack exports a PackManifest array
- Registry: single module imports all manifests, filters by env vars
- Health: public `/api/health` → `{ok, version}`. Private diagnostics in dashboard.
- Auth: MCP_AUTH_TOKEN for MCP endpoint, ADMIN_AUTH_TOKEN (optional) for dashboard
- Framework vs instance: framework has zero personal references, instance is pure env vars
- Contract-level compatibility: same tool names, schemas, behavior (descriptions may evolve)

**Target audience:** Technical hobbyists/makers ("bricoleurs"). Comfortable with GitHub, Vercel, env vars. OAuth setup complexity acceptable.

## Constraints

- **Stack**: Next.js on Vercel, TypeScript, MCP SDK via `mcp-handler` — no stack changes
- **Deployment**: Must work on Vercel free tier (60s timeout, serverless) AND local dev
- **Backward compatibility**: Contract-level — same tool names, schemas, behavior
- **Browser tools**: Browserbase for now, clean module boundaries allow swap later
- **Simplicity**: Clean, minimal code over feature-rich. Boring architecture > smart architecture.
- **Upgradability**: `git pull upstream main` must never conflict (no user-modified tracked files)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Env vars only (no mcp.config.ts) | User never modifies tracked files → git pull never conflicts. Vercel-native config primitive. | — Pending |
| Auto-activation by env var presence | Single config gesture: set credentials = pack active. No double-configuration. | — Pending |
| Static manifests (no auto-discovery) | Deterministic, debuggable, works on Vercel serverless. 10s to add a pack vs fragile infra. | — Pending |
| Phase 1 split into 1A/1B | Registry foundation first (low risk), file moves second (high risk but validated). | — Pending |
| Health: public liveness only | Don't leak pack details, env var names, or surface area publicly. | — Pending |
| ADMIN_AUTH_TOKEN with fallback | Security hygiene: MCP token (in Claude config files) ≠ admin token. Fallback for simplicity. | — Pending |
| Guided setup (not "wizard") | Honest framing. OAuth works, but token storage in Vercel remains manual. | — Pending |
| Pack diagnose() hook | Optional async per-pack health check. Env vars present ≠ credentials valid. | — Pending |
| Obsidian/GitHub vault only | Avoid multi-backend abstraction. GitHub is universal. | — Pending |
| Google Workspace only | 80% use case. Microsoft adds disproportionate complexity. | — Pending |
| Browserbase for browser tools | Only cloud browser with Stagehand. Module boundary allows swap. | ✓ Good |
| OpenRouter for LLM (Stagehand) | Avoids vendor lock-in to OpenAI. disableAPI mode required. | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-10 after milestone v1.0 initialization*
