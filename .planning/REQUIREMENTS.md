# Requirements: MyMCP v1.0

**Defined:** 2026-04-10
**Core Value:** One deploy gives you a personal AI backend with all your tools behind a single MCP endpoint.

## v1.0 Requirements

### Registry Foundation (Phase 1A)

- [ ] **REG-01**: Core types defined: PackManifest, ToolDefinition, InstanceConfig
- [ ] **REG-02**: Config module reads env vars and exposes typed InstanceConfig (timezone, locale, displayName, contextPath)
- [ ] **REG-03**: Registry imports all pack manifests and resolves enabled/disabled state per pack based on env vars
- [ ] **REG-04**: Packs auto-skip when required env vars are missing, with console warning showing which vars are missing
- [ ] **REG-05**: MYMCP_DISABLE_* env vars force-disable a pack even when credentials are present
- [ ] **REG-06**: route.ts refactored: imports registry, iterates enabled tools, registers via server.tool() (~30 lines replaces ~350)
- [ ] **REG-07**: Health endpoint public: returns {ok, version} only — no pack details leaked
- [ ] **REG-08**: Auth separation: ADMIN_AUTH_TOKEN (optional, fallback to MCP_AUTH_TOKEN) for dashboard routes
- [ ] **REG-09**: withLogging decorator works with new registry pattern unchanged
- [ ] **REG-10**: npm run dev works locally with .env file, identically to Vercel

### Physical Reorganization (Phase 1B)

- [ ] **REORG-01**: Tools moved to src/packs/{google,vault,browser,admin}/tools/
- [ ] **REORG-02**: Libs moved to src/packs/{google,vault,browser,admin}/lib/
- [ ] **REORG-03**: Each pack has manifest.ts exporting PackManifest with metadata + tools array
- [ ] **REORG-04**: All hardcoded "Yassine", "Europe/Paris", "fr-FR", "citizenyass" references replaced by InstanceConfig values
- [ ] **REORG-05**: Tool descriptions are generic (no personal names, specific repos, or personal context paths)
- [ ] **REORG-06**: my_context tool reads from configurable MYMCP_CONTEXT_PATH
- [ ] **REORG-07**: Smoke test script: starts dev server, calls tools/list, verifies expected tools per env var config
- [ ] **REORG-08**: Contract snapshot test: captures tool names + input schemas, fails if contract changes unexpectedly
- [ ] **REORG-09**: All 38 tools maintain contract-level compatibility (same names, same schemas, same behavior)
- [ ] **REORG-10**: Build passes, no TypeScript errors, all imports resolved

### Packaging & Documentation (Phase 2)

- [ ] **PKG-01**: .env.example documents every env var with description, required/optional, and URL to obtain it
- [ ] **PKG-02**: Deploy to Vercel button in README works end-to-end (fork → configure env vars → deploy)
- [ ] **PKG-03**: README covers: what is this, tool pack list, 5-min quickstart, architecture overview
- [ ] **PKG-04**: package.json: name "mymcp", description, keywords, repository URL, license MIT
- [ ] **PKG-05**: LICENSE file (MIT)
- [ ] **PKG-06**: CONTRIBUTING.md: how to add a tool, how to add a pack, code conventions
- [ ] **PKG-07**: CHANGELOG.md initialized with semver convention
- [ ] **PKG-08**: Health endpoint enhanced: shows version from package.json

### Private Status Dashboard (Phase 3A)

- [ ] **DASH-01**: Web UI at / requires ADMIN_AUTH_TOKEN (returns 401 without it)
- [ ] **DASH-02**: Dashboard shows each pack: active/inactive, tool count, reason for inactive (missing env vars)
- [ ] **DASH-03**: Pack diagnose() hook: optional async check verifying credentials actually work (not just present)
- [ ] **DASH-04**: MCP endpoint URL displayed with copy button (formatted for Claude Desktop JSON config)
- [ ] **DASH-05**: Recent tool call logs displayed as ephemeral/best-effort (clearly labeled as such)
- [ ] **DASH-06**: UI built with shadcn/ui + Tailwind v4, minimal and clean

### Guided Setup & OAuth (Phase 3B)

- [ ] **SETUP-01**: /setup page: checklist per pack showing configured ✓ / not configured ✗ status
- [ ] **SETUP-02**: Google OAuth consent flow built into app (Arctic): redirect → Google consent → callback → token
- [ ] **SETUP-03**: Refresh token displayed masked by default, revealable explicitly, behind admin auth, never logged
- [ ] **SETUP-04**: Clear instructions: "Copy this token → Add to Vercel env vars as GOOGLE_REFRESH_TOKEN"
- [ ] **SETUP-05**: Vault setup: verify GitHub PAT + repo access, show success/failure
- [ ] **SETUP-06**: Browser setup: verify Browserbase API key, show success/failure
- [ ] **SETUP-07**: Documentation: step-by-step guide for creating personal Google Cloud OAuth app

## v2 Requirements (Deferred)

### Advanced Configuration

- **ADV-01**: Individual tool enable/disable within a pack
- **ADV-02**: Custom tool packs — user adds own tools following pack pattern

### Alternative Providers

- **PROV-01**: Pluggable browser provider interface (Playwright local, etc.)
- **PROV-02**: Microsoft 365 support (separate tool pack)

### Observability

- **OBS-01**: Persistent tool call logging (beyond in-memory ephemeral)
- **OBS-02**: Error rate tracking and alerting

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-backend vault (Notion, S3) | Scope explosion — Obsidian/GitHub covers core use case |
| Multi-user / teams / RBAC | Personal tool, not enterprise gateway |
| Plugin marketplace | Premature abstraction with 0 users |
| mcp.config.ts user config file | Breaks upgradability (git pull conflicts) |
| MYMCP_ENABLED_PACKS explicit list | Auto-activation by env vars is simpler, less friction |
| Auto-discovery runtime (fs/glob) | Non-deterministic, fragile on Vercel serverless |
| Provider abstraction interfaces | Clean module boundaries suffice |
| Monorepo npm packages | Logical separation in same project is sufficient |
| Mobile app | MCP clients are desktop-based |
| Paid hosting / SaaS | Self-hosted framework only |
| Database for config/state | Env vars + in-memory. Serverless = stateless. |
| Automated token storage in Vercel | Requires Vercel API token — meta-auth complexity. Guided setup instead. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REG-01 | 1A | Pending |
| REG-02 | 1A | Pending |
| REG-03 | 1A | Pending |
| REG-04 | 1A | Pending |
| REG-05 | 1A | Pending |
| REG-06 | 1A | Pending |
| REG-07 | 1A | Pending |
| REG-08 | 1A | Pending |
| REG-09 | 1A | Pending |
| REG-10 | 1A | Pending |
| REORG-01 | 1B | Pending |
| REORG-02 | 1B | Pending |
| REORG-03 | 1B | Pending |
| REORG-04 | 1B | Pending |
| REORG-05 | 1B | Pending |
| REORG-06 | 1B | Pending |
| REORG-07 | 1B | Pending |
| REORG-08 | 1B | Pending |
| REORG-09 | 1B | Pending |
| REORG-10 | 1B | Pending |
| PKG-01 | 2 | Pending |
| PKG-02 | 2 | Pending |
| PKG-03 | 2 | Pending |
| PKG-04 | 2 | Pending |
| PKG-05 | 2 | Pending |
| PKG-06 | 2 | Pending |
| PKG-07 | 2 | Pending |
| PKG-08 | 2 | Pending |
| DASH-01 | 3A | Pending |
| DASH-02 | 3A | Pending |
| DASH-03 | 3A | Pending |
| DASH-04 | 3A | Pending |
| DASH-05 | 3A | Pending |
| DASH-06 | 3A | Pending |
| SETUP-01 | 3B | Pending |
| SETUP-02 | 3B | Pending |
| SETUP-03 | 3B | Pending |
| SETUP-04 | 3B | Pending |
| SETUP-05 | 3B | Pending |
| SETUP-06 | 3B | Pending |
| SETUP-07 | 3B | Pending |

**Coverage:**
- v1.0 requirements: 41 total
- Mapped to phases: 41
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-10*
*Last updated: 2026-04-10 after milestone v1.0 definition*
