# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-10)

**Core value:** One deploy gives you a personal AI backend with all your tools behind a single MCP endpoint.
**Current focus:** Milestone v1.0 — Open Source Personal MCP Framework

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-10 — Milestone v1.0 started

## Accumulated Context

### Decisions

- [Architecture] Env vars only for config, no mcp.config.ts — upgradability over type safety
- [Architecture] Static manifests, no auto-discovery — deterministic, Vercel-compatible
- [Architecture] Pack auto-activation by env var presence — single config gesture
- [Architecture] Phase 1 split: 1A registry foundation, 1B file reorganization — reduce risk
- [Architecture] Health: public liveness minimal, private diagnostics — don't leak surface
- [Architecture] ADMIN_AUTH_TOKEN optional with fallback — security hygiene without friction
- [Architecture] Guided setup, not wizard — honest framing
- [Architecture] Pack diagnose() hook optional — env vars present ≠ credentials valid
- [Research] Arctic for Google OAuth, shadcn/ui + Tailwind v4 for dashboard
- [Research] ~6 new dependencies total for Phase 3

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 3B has most unknowns: Arctic + Google OAuth needs PoC validation
- File reorganization (1B) is highest-risk step — must have smoke tests from 1A
- Vercel API for programmatic env var storage is LOW confidence

## Session Continuity

Last session: 2026-04-10
Stopped at: Defining requirements for milestone v1.0
Resume file: None
