# Requirements: MyMCP

**Defined:** 2026-04-09
**Core Value:** One deploy gives you a personal AI backend with all your tools behind a single MCP endpoint.

## v1 Requirements

### Framework Foundation

- [ ] **FWRK-01**: Tool registry dynamically loads tools from pack manifests based on config
- [ ] **FWRK-02**: Tool packs group tools by domain (vault, google, browser, admin)
- [ ] **FWRK-03**: Packs are enabled/disabled via config file — disabled packs register zero tools
- [ ] **FWRK-04**: Packs auto-skip when required env vars are missing (with console warning)
- [ ] **FWRK-05**: Config file (`mcp.config.ts`) declares active packs, timezone, locale, user display name

### Depersonalization

- [ ] **DEPN-01**: All hardcoded "Yassine" / "Europe/Paris" / "fr-FR" references replaced by config values
- [ ] **DEPN-02**: Tool descriptions are generic (no personal names, specific repos, or personal context)
- [ ] **DEPN-03**: `my_context` tool reads from a configurable path (not hardcoded `System/context.md`)

### Packaging

- [ ] **PKGN-01**: `.env.example` documents every environment variable with description and source URL
- [ ] **PKGN-02**: Deploy to Vercel button in README works end-to-end (fork → configure → deploy)
- [ ] **PKGN-03**: README covers: what this is, tool list, 5-min quickstart, architecture overview
- [ ] **PKGN-04**: `package.json` has proper name, description, keywords, repository URL
- [ ] **PKGN-05**: Health endpoint shows active tool packs and their status

### Setup Dashboard

- [ ] **DASH-01**: Web UI at `/` shows which tool packs are active, tool count, and health status
- [ ] **DASH-02**: Setup wizard guides user through Google OAuth consent flow (click "Connect Google")
- [ ] **DASH-03**: Setup wizard shows vault configuration step (GitHub repo + PAT)
- [ ] **DASH-04**: Setup wizard shows browser configuration step (Browserbase keys, optional)
- [ ] **DASH-05**: MCP endpoint URL displayed with copy button for Claude Desktop config

### Google OAuth Flow

- [ ] **AUTH-01**: Built-in OAuth 2.1 consent flow for Google (Gmail, Calendar, Contacts, Drive scopes)
- [ ] **AUTH-02**: Refresh token stored securely and auto-refreshed
- [ ] **AUTH-03**: Clear documentation for users to create their own Google Cloud OAuth app

## v2 Requirements

### Advanced Configuration

- **CONF-01**: Individual tool enable/disable within a pack (e.g., disable `gmail_send` but keep inbox)
- **CONF-02**: Custom tool packs — user can add their own tools following the pack pattern

### Alternative Providers

- **PROV-01**: Pluggable browser provider interface (swap Browserbase for Playwright local, etc.)
- **PROV-02**: Support for non-Google workspace (Microsoft 365)

### Observability

- **OBSV-01**: Status dashboard with recent tool calls, error rates, latency charts

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-backend vault (Notion, S3) | Scope explosion — Obsidian/GitHub covers core use case |
| Multi-user / teams / RBAC | Personal tool, not an enterprise gateway |
| Plugin marketplace | Premature abstraction, 0 users |
| Mobile app | MCP clients are desktop-based |
| Paid hosting / SaaS | Self-hosted framework only |
| Custom LLM hosting | MCP is model-agnostic by design |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FWRK-01 | Phase 1 | Pending |
| FWRK-02 | Phase 1 | Pending |
| FWRK-03 | Phase 1 | Pending |
| FWRK-04 | Phase 1 | Pending |
| FWRK-05 | Phase 1 | Pending |
| DEPN-01 | Phase 1 | Pending |
| DEPN-02 | Phase 1 | Pending |
| DEPN-03 | Phase 1 | Pending |
| PKGN-01 | Phase 2 | Pending |
| PKGN-02 | Phase 2 | Pending |
| PKGN-03 | Phase 2 | Pending |
| PKGN-04 | Phase 2 | Pending |
| PKGN-05 | Phase 2 | Pending |
| DASH-01 | Phase 3 | Pending |
| DASH-02 | Phase 3 | Pending |
| DASH-03 | Phase 3 | Pending |
| DASH-04 | Phase 3 | Pending |
| DASH-05 | Phase 3 | Pending |
| AUTH-01 | Phase 3 | Pending |
| AUTH-02 | Phase 3 | Pending |
| AUTH-03 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 21 total
- Mapped to phases: 21
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-09*
*Last updated: 2026-04-09 after initial definition*
