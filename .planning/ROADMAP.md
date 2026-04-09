# Roadmap: MyMCP

## Overview

Transform YassMCP (a personal MCP server with 38 hardcoded tools) into MyMCP (a forkable open-source framework). Phase 1 rebuilds the internal architecture with a config-driven tool registry and removes all personal references. Phase 2 packages the project for public consumption with documentation, deploy button, and clean metadata. Phase 3 adds a web-based setup wizard with built-in Google OAuth to eliminate the biggest adoption friction.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Framework Foundation** - Config-driven tool registry, pack architecture, depersonalization
- [ ] **Phase 2: Packaging & Documentation** - .env.example, README, deploy button, health endpoint, clean package.json
- [ ] **Phase 3: Setup Dashboard & OAuth** - Web UI wizard, Google OAuth consent flow, status dashboard

## Phase Details

### Phase 1: Framework Foundation
**Goal**: The MCP server loads tools dynamically from pack manifests controlled by a config file, with zero hardcoded personal references
**Depends on**: Nothing (first phase)
**Requirements**: FWRK-01, FWRK-02, FWRK-03, FWRK-04, FWRK-05, DEPN-01, DEPN-02, DEPN-03
**Success Criteria** (what must be TRUE):
  1. Server starts with only the tool packs enabled in `mcp.config.ts` -- disabling a pack registers zero tools from it
  2. Removing a required env var (e.g., GITHUB_PAT) causes that pack to skip gracefully with a console warning, not crash
  3. A fresh clone with default config contains no references to "Yassine", "Europe/Paris", or any personal identifiers in tool descriptions or runtime behavior
  4. All 38 existing tools still work identically after the refactor (same tool names, same parameters, same outputs)
  5. Config file controls timezone, locale, display name, context path, and active packs in one place
**Plans**: TBD

Plans:
- [ ] 01-01: TBD
- [ ] 01-02: TBD

### Phase 2: Packaging & Documentation
**Goal**: A developer can discover, understand, and deploy MyMCP from the README alone
**Depends on**: Phase 1
**Requirements**: PKGN-01, PKGN-02, PKGN-03, PKGN-04, PKGN-05
**Success Criteria** (what must be TRUE):
  1. `.env.example` lists every environment variable with a description and where to get the value
  2. Clicking "Deploy to Vercel" in the README forks the repo, prompts for env vars, and produces a working deployment
  3. README contains: what MyMCP is, full tool list by pack, 5-minute quickstart, and architecture overview
  4. Health endpoint (`/api/health`) returns which packs are active, tool count per pack, and overall status
**Plans**: TBD

Plans:
- [ ] 02-01: TBD

### Phase 3: Setup Dashboard & OAuth
**Goal**: Users configure their MyMCP instance through a web UI instead of manually editing env vars and copying tokens
**Depends on**: Phase 2
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, AUTH-01, AUTH-02, AUTH-03
**Success Criteria** (what must be TRUE):
  1. Visiting `/` shows a dashboard with active tool packs, tool count, and health status
  2. User can complete Google OAuth consent flow by clicking "Connect Google" -- no manual token copy needed
  3. Setup wizard walks through vault config (GitHub repo + PAT) and browser config (Browserbase keys) as discrete steps
  4. MCP endpoint URL is displayed with a copy button ready for Claude Desktop config
  5. Google OAuth documentation clearly explains how to create a personal Google Cloud OAuth app
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Framework Foundation | 0/? | Not started | - |
| 2. Packaging & Documentation | 0/? | Not started | - |
| 3. Setup Dashboard & OAuth | 0/? | Not started | - |
