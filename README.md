<p align="center">
  <h1 align="center">MyMCP</h1>
  <p align="center"><strong>Your personal AI backend. One endpoint. 51 tools. Deploy in 5 minutes.</strong></p>
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp&env=MCP_AUTH_TOKEN&envDescription=Required%20env%20vars%20for%20MyMCP&envLink=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp%23configuration"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#tool-packs">Tool Packs</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Claude / ChatGPT / AI                         │
│                      (any MCP-compatible client)                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ MCP (Streamable HTTP)
                               ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            MyMCP on Vercel / Docker                              │
│                                                                                  │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌─────────┐ ┌─────┐   │
│  │  Google   │ │ Vault  │ │Browser │ │ Slack │ │ Notion │ │Composio │ │Admin│   │
│  │ Workspace │ │Obsidian│ │  Auto  │ │       │ │        │ │ 1000+   │ │     │   │
│  │ 18 tools  │ │15 tools│ │4 tools │ │6 tools│ │5 tools │ │  apps   │ │1 tool│  │
│  └─────┬─────┘ └───┬────┘ └───┬────┘ └───┬───┘ └───┬────┘ └────┬────┘ └─────┘   │
│        │           │          │          │         │           │                 │
│      Registry ← Pack Manifests ← Env vars (auto-activation)                    │
└────────┼───────────┼──────────┼──────────┼─────────┼───────────┼────────────────┘
         │           │          │          │         │           │
         ▼           ▼          ▼          ▼         ▼           ▼
    Google APIs  GitHub API  Browserbase  Slack API  Notion API  Composio
```

## The Story

I built MyMCP because I wanted a single MCP server that works everywhere (Claude, ChatGPT, Hermes, OpenClaw, ..). It started as a simple bridge to my Obsidian vault with a few tools, and kept growing as I added Google Workspace, browser automation, Slack, and Notion. At some point I realized: if it's useful to me, it might be useful to others, so I open-sourced it.

## Why MyMCP?

Most MCP setups require running 5 separate servers, each with their own config. Or paying for a hosted platform that controls your data.

MyMCP gives you **one server, one endpoint, 51 tools** — deployed on Vercel's free tier (or Docker). You own everything.

| | MyMCP | Separate MCP servers | Hosted platforms |
|---|---|---|---|
| **Setup** | Fork + env vars + deploy | 5 repos, 5 configs | Sign up + monthly fee |
| **Tools** | 45 pre-built | Build your own | 1000s (but vendor lock-in) |
| **Endpoint** | 1 | 5+ | 1 (their server) |
| **Cost** | Free (Vercel free tier) | Free but complex | $0-80/month |
| **Data** | Your Vercel, your keys | Your machines | Their servers |
| **Docker** | Yes | Usually yes | N/A |

## Quick Start

> **Which option should I pick?**
>
> | You are... | Best option |
> |---|---|
> | Using Claude Code (CLI or Desktop) | [Option 1](#option-1-from-claude-code-recommended) — ask Claude to do it for you |
> | Comfortable with the terminal | [Option 2](#option-2-interactive-installer) — `npx @yassinello/create-mymcp` |
> | Prefer clicking buttons | [Option 3](#option-3-deploy-to-vercel) — one-click Vercel deploy |
> | Want to self-host | [Option 4](#option-4-docker) |

---

### Option 1: From Claude Code (recommended)

If you're using Claude Code (Desktop, CLI, or Web), just run the installer from the conversation. No need to create a folder first — the installer will ask you where to set up.

```bash
npx @yassinello/create-mymcp@latest
```

Or ask Claude to run it for you:

> "Run `npx @yassinello/create-mymcp@latest` and help me set up MyMCP."

The installer will:
1. Clone the repo to your machine
2. Walk you through which packs to enable (Google, Obsidian, Slack...)
3. Generate your `MCP_AUTH_TOKEN` securely
4. Collect your API credentials (with links to get them)
5. Create your `.env` file
6. Install dependencies
7. Optionally deploy to Vercel

Claude can then help you add the MCP server to your config and verify everything works.

---

### Option 2: Interactive installer

```bash
npx @yassinello/create-mymcp@latest
```

The CLI walks you through everything step by step:

```
[1/5] Project setup        → Pick a directory name
[2/5] Cloning MyMCP        → Downloads the code + sets up update tracking
[3/5] Choose your packs    → Google Workspace? Obsidian? Slack? (Y/n for each)
[4/5] Configure credentials → Paste your API keys (with links to get them)
[5/5] Install & deploy     → npm install + optional Vercel deploy
```

At the end you get a working `.env`, installed dependencies, and an `upstream` remote for future updates.

---

### Option 3: Deploy to Vercel

1. Click the **Deploy with Vercel** button at the top of this page
2. Choose a name for your private repo copy (e.g. `my-mcp-instance`)
3. Set `MCP_AUTH_TOKEN` — generate one with `openssl rand -hex 32`
4. Add credentials for the packs you want (see [Configuration](#configuration))
5. Click **Deploy** — your endpoint is live at `https://your-app.vercel.app/api/mcp`

---

### Option 4: Docker

```bash
git clone https://github.com/Yassinello/mymcp.git
cd mymcp
cp .env.example .env    # Fill in your API keys
docker compose up       # or: docker build -t mymcp . && docker run -p 3000:3000 --env-file .env mymcp
```

---

### Option 5: Run locally (development)

```bash
git clone https://github.com/Yassinello/mymcp.git
cd mymcp
cp .env.example .env    # Fill in your values
npm install
npm run dev             # http://localhost:3000
```

---

### Connect your AI client

Once deployed, add MyMCP to your AI client's config:

<details>
<summary><strong>Claude Desktop</strong></summary>

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "mymcp": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Claude Code</strong></summary>

File: `~/.claude.json` (global) or `.mcp.json` (per-project)

```json
{
  "mcpServers": {
    "mymcp": {
      "type": "http",
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>ChatGPT / Other MCP clients</strong></summary>

Use the Streamable HTTP endpoint:
- **URL**: `https://your-app.vercel.app/api/mcp`
- **Auth**: Bearer token (your `MCP_AUTH_TOKEN`)
- **Method**: POST
</details>

---

### Staying up to date

MyMCP is a [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository). Your copy is standalone — it won't auto-update. To pull in new tools and bug fixes:

```bash
# One-time setup (skip if you used npx @yassinello/create-mymcp — already done)
git remote add upstream https://github.com/Yassinello/mymcp.git

# Pull updates anytime
git fetch upstream
git merge upstream/main
```

Or simply:

```bash
npm run update
```

Your `.env` is never touched — all customization lives in env vars, not in code. Updates are always safe to merge.

## Tool Packs

MyMCP ships **51 production-ready tools** organized in 7 packs. Each pack activates automatically when its credentials are present in env vars.

### Google Workspace — 18 tools

| Category | Tools |
|----------|-------|
| **Gmail** | `gmail_inbox` `gmail_read` `gmail_send` `gmail_reply` `gmail_trash` `gmail_label` `gmail_search` `gmail_draft` `gmail_attachment` |
| **Calendar** | `calendar_events` `calendar_create` `calendar_update` `calendar_delete` `calendar_find_free` `calendar_rsvp` |
| **Contacts** | `contacts_search` |
| **Drive** | `drive_search` `drive_read` |

**Requires:** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`

### Obsidian Vault — 15 tools

| Category | Tools |
|----------|-------|
| **CRUD** | `vault_read` `vault_write` `vault_delete` `vault_move` `vault_append` `vault_list` |
| **Batch & Search** | `vault_batch_read` `vault_search` `vault_recent` `vault_stats` |
| **Knowledge Graph** | `vault_backlinks` `vault_due` |
| **Web → Vault** | `save_article` `read_paywalled` |
| **Context** | `my_context` |

**Requires:** `GITHUB_PAT` + `GITHUB_REPO`

### Browser Automation — 4 tools

| Tool | What it does |
|------|-------------|
| `web_browse` | Open URL, return visible text (handles JS-rendered pages) |
| `web_extract` | Extract structured data with AI (e.g., "get all prices from this page") |
| `web_act` | Execute actions: click, type, fill forms (natural language) |
| `linkedin_feed` | Read LinkedIn feed (rate-limited, persistent session) |

**Requires:** `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` + `OPENROUTER_API_KEY`

### Slack — 6 tools

| Tool | What it does |
|------|-------------|
| `slack_channels` | List channels with topic, member count |
| `slack_read` | Read recent messages from a channel |
| `slack_send` | Send a message or threaded reply |
| `slack_search` | Search messages (supports Slack operators: from:, in:, has:) |
| `slack_thread` | Read all replies in a thread |
| `slack_profile` | Get user profile: name, title, email, timezone, status |

**Requires:** `SLACK_BOT_TOKEN`

### Notion — 5 tools

| Tool | What it does |
|------|-------------|
| `notion_search` | Search pages by title or content |
| `notion_read` | Read full page content as markdown |
| `notion_create` | Create a page in a database |
| `notion_update` | Update page properties and/or append content |
| `notion_query` | Query a database with filters and sorting |

**Requires:** `NOTION_API_KEY`

### Composio — 2 tools + 1000s of integrations

| Tool | What it does |
|------|-------------|
| `composio_action` | Execute any action on a connected app (GitHub, Jira, HubSpot, Salesforce, Airtable, Linear, Figma...) |
| `composio_list` | Discover available actions for a specific app |

Connect your apps in the [Composio dashboard](https://composio.dev), then use `composio_list` to discover actions and `composio_action` to execute them.

**Requires:** `COMPOSIO_API_KEY`

### Admin — 1 tool

`mcp_logs` — View recent tool calls, errors, latency. Always active, no credentials needed.

## Architecture

```
src/
  core/                 ← Framework: types, registry, config, auth, logging
  packs/
    google/             ← Google Workspace (18 tools)
      manifest.ts       ← Pack definition (single source of truth)
      lib/              ← Gmail, Calendar, Contacts, Drive wrappers
      tools/            ← Individual tool handlers
    vault/              ← Obsidian Vault (15 tools)
    browser/            ← Browser Automation (4 tools)
    slack/              ← Slack (6 tools)
    notion/             ← Notion (5 tools)
    composio/           ← Composio bridge (2 tools → 1000+ integrations)
    admin/              ← Admin & Observability (1 tool)

app/
  api/mcp               ← MCP endpoint (~30 lines — reads from registry)
  api/health            ← Public liveness: { ok, version }
  api/admin/*           ← Private: status, stats, verify, call (auth-gated)
  api/auth/google       ← OAuth consent flow
  /                     ← Private status dashboard
  /setup                ← Guided setup with progress bar
  /playground           ← Tool call playground (test any tool)
  /packs                ← Public pack listing
```

### How it works

1. Each pack has a `manifest.ts` declaring its tools and required env vars
2. The **registry** checks env vars → determines which packs are active
3. `route.ts` iterates enabled packs, registers tools via the MCP SDK
4. **Everything derives from manifests** — dashboard, health, admin API, playground all read from the same source

### Design principles

- **Env vars only** — no config files to maintain, `git pull` never conflicts
- **Single source of truth** — pack manifests drive MCP registration, dashboard, health, docs
- **Framework vs instance** — framework code has zero personal references; all customization is via env vars
- **Contract-level compatibility** — same tool names, same schemas, same behavior across versions

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Auth

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_TOKEN` | Yes | Bearer token for MCP endpoint |
| `ADMIN_AUTH_TOKEN` | No | Separate token for dashboard (falls back to MCP_AUTH_TOKEN) |

### Instance Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MYMCP_TIMEZONE` | `UTC` | Timezone for date formatting |
| `MYMCP_LOCALE` | `en-US` | Locale for date/number formatting |
| `MYMCP_DISPLAY_NAME` | `User` | Display name in dashboard |
| `MYMCP_CONTEXT_PATH` | `System/context.md` | Path to context file in vault |
| `GITHUB_BRANCH` | `main` | Default branch for vault repo |
| `MYMCP_TOOL_TIMEOUT` | `30000` | Tool timeout in ms |
| `MYMCP_ERROR_WEBHOOK_URL` | — | Webhook for error alerts (Slack-compatible) |

### Pack Control

Packs activate automatically when their credentials are present. Override with:

```bash
MYMCP_DISABLE_GOOGLE=true          # Force-disable even with credentials
MYMCP_ENABLED_PACKS=vault,admin    # Only listed packs are considered
```

## Dashboard & Tools

| Page | Auth | Description |
|------|------|-------------|
| `/` | Admin | Status dashboard — pack health, tool counts, config, logs |
| `/setup` | Admin | Guided setup — progress bar, OAuth flow, credential checks |
| `/playground` | Admin | Tool playground — test any tool with JSON params |
| `/packs` | Public | Pack listing — tools, descriptions, required env vars |

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/mcp` | MCP_AUTH_TOKEN | MCP Streamable HTTP |
| `GET /api/health` | Public | `{ ok, version }` |
| `GET /api/admin/status` | Admin | Pack diagnostics + diagnose() results |
| `GET /api/admin/stats` | Admin | Tool usage analytics (ephemeral) |
| `GET /api/admin/verify` | Admin | Live credential verification |
| `POST /api/admin/call` | Admin | Invoke any tool (playground API) |
| `GET /api/auth/google` | Admin | Google OAuth redirect |
| `GET /api/cron/health` | Cron | Daily health check + webhook alert |

## Security

| Layer | Protection |
|-------|-----------|
| **Auth** | Timing-safe token comparison (MCP + Admin) |
| **SSRF** | Browser tools block localhost, private IPs (v4+v6), cloud metadata |
| **Errors** | API keys stripped from error messages |
| **Rate limiting** | LinkedIn feed: 3 calls/day (vault-persisted counter) |
| **OAuth** | State parameter validation, PKCE, HttpOnly cookies |
| **Dashboard** | Private by default — all admin routes require auth |
| **Webhooks** | Error alerts on tool failures (opt-in) |
| **CI** | ESLint (no-any enforced), Prettier, contract tests, build checks |

## Development

```bash
npm run dev             # Start dev server
npm run build           # Production build
npm run lint            # ESLint
npm run format          # Prettier
npm run test:contract   # Verify tool contracts (51 tools)
npm run test:e2e        # E2E smoke test (starts server, checks tools/list)
```

Pre-commit hook (via Husky): `lint-staged` + `contract test`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add tools, packs, and custom extensions.

**Quick version:** Create a file in `src/packs/<pack>/tools/`, add it to the pack's `manifest.ts`. Done.

## Tech Stack

Next.js 16 · TypeScript 6 · Zod 4 · MCP SDK · Vercel Serverless · Arctic (OAuth) · Stagehand + Browserbase

## License

[MIT](LICENSE)
