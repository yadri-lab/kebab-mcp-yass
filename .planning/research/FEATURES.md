# Feature Landscape

**Domain:** Personal MCP server framework (open-source, self-hosted on Vercel)
**Researched:** 2026-04-08
**Overall confidence:** MEDIUM-HIGH

## Table Stakes

Features users expect from a "fork and deploy" open-source MCP framework. Missing any of these = users bounce before trying.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **One-click Deploy to Vercel button** | Standard for every Vercel-based OSS project. Users expect README deploy button that forks + configures env vars. Without it, adoption drops 80%+. | Low | Vercel provides button generator. Just needs proper `vercel.json` + env var prompts. |
| **`.env.example` with documentation** | Developers won't read source code to find required env vars. Every serious OSS project ships this. | Low | Already planned in PROJECT.md. List every var with description, required/optional, where to get it. |
| **Clear README with quickstart** | First thing users see. Must answer: what is this, what can it do, how do I deploy in 5 min. | Medium | Architecture diagram, tool list, deploy button, config steps. |
| **Config-driven tool registry** | Users must choose which tool packs to enable. 38 tools is overwhelming; users want Gmail+Calendar but not Vault, or Vault but not Browser. Hardcoded imports = fork-hostile. | High | Central config file (`mcp.config.ts` or `tools.config.ts`) that declares active packs. Tools auto-discovered from filesystem, enabled/disabled per config. MCPJungle and MongoDB MCP both ship this pattern. |
| **Tool packs (modular grouping)** | Users think in capabilities, not individual tools. "I want Google Workspace" not "I want gmail_inbox, gmail_read, gmail_send..." Competitors (guMCP, MCPJungle) group tools. | Medium | Groups: `vault` (15 tools), `google` (18 tools), `browser` (4 tools), `admin` (1 tool). Enable/disable at pack level + individual tool level. |
| **Remove hardcoded personal references** | Any reference to "Yassine", "Europe/Paris", or specific repos makes the project feel like someone's personal server, not a framework. Instant credibility kill. | Medium | Extract to config: timezone, user name, vault repo, context file path. Grep codebase for hardcoded values. |
| **Bearer token authentication** | Minimum viable auth. Already implemented. Must remain as the simple path for personal use. | Low | Already done. Keep as-is, document clearly. |
| **Health check endpoint** | MCP clients and monitoring tools expect `/health` or equivalent. Load balancers need it. Already partially implemented. | Low | Already exists at `app/api/health/route.ts`. Enhance to show which tool packs are active. |
| **Error handling and sanitization** | Tools must return clean error messages, not stack traces with env vars or file paths. Already implemented but must be consistent across all tools. | Low | Already done (SSRF protection, error sanitization). Document the pattern for contributors. |
| **TypeScript throughout** | Target audience is TS developers. JS-only or mixed projects lose trust. | Low | Already TS. Keep strict. |

## Differentiators

Features that set MyMCP apart from competitors. Not expected, but create "wow" moments and drive adoption.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Setup wizard UI at `/`** | Most MCP servers are config-file-only. A web UI that walks you through OAuth, vault setup, and browser config is a massive DX improvement. guMCP has no UI. MCPJungle has a dashboard but targets enterprise. | High | Next.js pages at root. Steps: connect Google (OAuth), configure vault (GitHub repo), configure browser (Browserbase), generate auth token. Stores to env vars or KV. |
| **Built-in Google OAuth flow** | Every Google Workspace MCP integration requires manual OAuth token generation. Building "Click Connect Google" into the app eliminates the #1 setup friction point. No competitor does this well for personal MCP servers. | High | OAuth 2.1 consent flow built into the app. Stores refresh token. Handles token refresh automatically. Major DX win but significant implementation effort. |
| **38 pre-built tools across 4 domains** | Most MCP server frameworks ship 0-5 example tools and expect users to build their own. Shipping 38 production-ready tools covering Gmail, Calendar, Contacts, Drive, Obsidian vault, and browser automation is immediately useful. This is the core moat. | Already built | The tools exist. The framework work is making them modular and configurable. |
| **Status dashboard** | Web page showing: which tools are active, health status, recent tool calls, error rates. Goes beyond a health endpoint into observability. | Medium | Builds on existing `mcp-logs` tool. Show active packs, last call timestamps, error counts. |
| **Obsidian vault as personal knowledge base** | Unique angle: your AI has access to your personal notes, not just productivity tools. Vault tools (search, backlinks, due/resurface) are genuinely novel for MCP. No competitor combines vault + workspace + browser. | Already built | 15 vault tools already production-tested. Resurface/due system is particularly unique. |
| **Browser automation tools** | Web browsing, data extraction, form filling, LinkedIn feed via Stagehand/Browserbase. Most personal MCP servers don't touch browser automation. | Already built | 4 browser tools. Browserbase dependency is a constraint but architecturally swappable. |
| **Tool call logging with decorator pattern** | `withLogging()` wrapper on every tool. Simple, elegant, zero-config observability. Most MCP servers have no logging. | Already built | Document the pattern. Make it easy for contributors to add tools with logging. |

## Anti-Features

Features to deliberately NOT build. Each would dilute focus or create maintenance burden disproportionate to value.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Multi-backend vault (Notion, S3, local FS)** | Scope explosion. Each backend needs its own API wrapper, error handling, auth flow. GitHub-backed Obsidian covers the core use case. Adding Notion alone would be 2-3 weeks. | Ship Obsidian/GitHub only. Document how someone could fork and swap the backend. Architecture should allow it but don't build it. |
| **Multi-provider auth (Microsoft 365, Apple)** | Google Workspace covers ~80% of personal productivity. Microsoft Graph API is a completely different auth model. Would double the auth complexity for 20% more users. | Google only for v1. If demand emerges, add as a separate tool pack later. |
| **Plugin marketplace / tool store** | Premature abstraction. The project has 0 users. A marketplace needs: discovery, versioning, security review, dependency management. Months of work for hypothetical benefit. | Simple tool pack system with clear "add your own tool" docs. Community can contribute via PR. |
| **Multi-user / teams / RBAC** | This is a PERSONAL MCP server. One user, one deployment. Multi-user requires user management, permissions, data isolation. Completely different product. | Single-user only. One bearer token. If someone needs multi-user, they're looking for MCPJungle or an enterprise gateway. |
| **Mobile app** | MCP protocol is designed for desktop AI clients (Claude Desktop, Cursor, etc.). Mobile MCP clients barely exist. | Web dashboard for status/config only. All tool usage goes through MCP clients. |
| **Paid hosting / SaaS mode** | Turns an open-source project into a business. Different legal, billing, support, and infrastructure requirements. | Self-hosted only. Free tier Vercel. If someone wants hosted, point them to Glama or similar MCP hosting platforms. |
| **Custom LLM hosting** | Some frameworks bundle LLM inference. MCP servers don't need this — they're tool providers, not model providers. | MCP is model-agnostic by design. Tools work with any MCP client regardless of which LLM it uses. |
| **Real-time collaboration / WebSocket** | MCP uses Streamable HTTP (request-response + SSE). WebSocket adds complexity with no protocol support. | Stick to Streamable HTTP transport as per MCP spec. |

## Feature Dependencies

```
Config file system ──→ Tool pack enable/disable ──→ Dynamic tool registry
                                                  ──→ Status dashboard (shows active packs)
                                                  ──→ Setup wizard (configures packs)

Google OAuth flow ──→ Gmail tools active
                  ──→ Calendar tools active
                  ──→ Contacts tools active
                  ──→ Drive tools active

GitHub PAT config ──→ Vault tools active

Browserbase config ──→ Browser tools active

Remove hardcoded refs ──→ Config file system (values must live somewhere)

Health endpoint ──→ Status dashboard (builds on health data)

.env.example ──→ Deploy button (Vercel prompts for env vars listed in vercel.json)
```

## MVP Recommendation

**Priority order for framework launch:**

1. **Remove hardcoded personal references** — prerequisite for everything else. Can't ship a framework with "Yassine" in the code.
2. **Config-driven tool registry + tool packs** — the core architectural change. Without this, it's still a personal server, not a framework.
3. **`.env.example` + Deploy to Vercel button** — the adoption funnel. User sees README, clicks deploy, fills env vars, done.
4. **README with quickstart + architecture docs** — answers "what is this" and "how do I use it" in under 2 minutes.
5. **Health endpoint enhancement** — show active tool packs, basic status.

**Defer to post-launch:**
- Setup wizard UI: High value but high complexity. Ship config-file-first, add UI later.
- Google OAuth flow: Major DX improvement but can launch with manual refresh token setup (documented clearly).
- Status dashboard: Nice-to-have. `mcp-logs` tool already provides basic observability.

**Rationale:** Ship the framework with maximum tools and minimum friction. The 38 pre-built tools ARE the product. The framework work is making them accessible to others. A beautiful setup wizard means nothing if the underlying architecture is still hardcoded.

## Competitive Landscape Summary

| Framework | Tools Shipped | Config System | UI | Auth | Deploy |
|-----------|--------------|---------------|-----|------|--------|
| **guMCP** | ~30 integrations | YAML config | None | OAuth per integration | Self-hosted (Docker/local) |
| **MCPJungle** | 0 (gateway only) | Server registration API | Admin dashboard | Token + enterprise auth | Self-hosted (Docker) |
| **Official MCP servers** | ~15 reference servers | Per-server config | None | Per-server | npm packages (stdio) |
| **Vercel MCP template** | 0 (boilerplate) | None | None | OAuth 2.1 | Vercel deploy button |
| **MyMCP (target)** | 38 production tools | Config file + tool packs | Setup wizard (later) | Bearer token + OAuth | Vercel deploy button |

**MyMCP's unique position:** Most tools, easiest deploy path, only framework combining vault + workspace + browser in one endpoint. The gap is: it needs framework-quality packaging (config, docs, deploy button) to match its tool-quality content.

## Sources

- [awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) — curated list of MCP servers
- [MCPJungle](https://github.com/mcpjungle/MCPJungle) — self-hosted MCP gateway
- [guMCP by Gumloop](https://www.gumloop.com/mcp) — open-source MCP server framework
- [MCP Official Servers](https://github.com/modelcontextprotocol/servers) — reference implementations
- [MCP Authorization Spec](https://modelcontextprotocol.io/specification/draft/basic/authorization) — OAuth 2.1 spec
- [Vercel Deploy Button](https://vercel.com/docs/deploy-button) — one-click deploy docs
- [Vercel MCP Template](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel) — deploying MCP to Vercel
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/) — architecture and implementation guide
- [MongoDB MCP enable/disable](https://www.mongodb.com/docs/mcp-server/configuration/enable-or-disable-features/) — tool filtering pattern
