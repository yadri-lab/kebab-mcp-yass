# Technology Stack

**Project:** MyMCP Framework Transformation
**Researched:** 2026-04-09

## Current Stack (Keep As-Is)

These are already in the project and should NOT change. Listed for completeness.

| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| Next.js | ^16.2.1 | App framework + API routes | Keep |
| TypeScript | ^6.0.2 | Type safety | Keep |
| React | ^19.2.4 | UI (needed for setup wizard) | Keep |
| Zod | ^4.3.6 | Schema validation | Keep |
| @modelcontextprotocol/sdk | ^1.26.0 | MCP protocol implementation | Upgrade to ^1.29.0 |
| mcp-handler | ^1.1.0 | Vercel MCP adapter | Keep, leverage withMcpAuth |
| js-yaml | ^4.1.1 | Frontmatter parsing | Keep |
| @browserbasehq/stagehand | ^3.2.0 | Browser automation | Keep |
| @browserbasehq/sdk | ^2.10.0 | Browserbase client | Keep |

**Action:** Upgrade `@modelcontextprotocol/sdk` to `^1.29.0`. The project currently pins `^1.26.0` which is the minimum safe version (security vuln in earlier versions). 1.29.0 has better dynamic tool support and is the latest stable before v2 ships.

## Recommended Additions

### 1. Setup Wizard UI: shadcn/ui + Tailwind CSS v4

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| tailwindcss | ^4.x | Utility CSS for setup wizard UI | HIGH |
| @tailwindcss/postcss | ^4.x | PostCSS integration | HIGH |
| shadcn/ui | latest (CLI) | Component library for wizard/dashboard | HIGH |
| tw-animate-css | latest | Animation support (replaces tailwindcss-animate) | HIGH |
| lucide-react | latest | Icon library (shadcn default) | HIGH |

**Why shadcn/ui:** Components are copied into your codebase (no dependency lock-in), built on Radix UI primitives (accessible), styled with Tailwind. This is the dominant pattern for Next.js admin UIs in 2025-2026. Every major Next.js dashboard template uses it. The project already has React 19 which shadcn fully supports.

**Why NOT Material UI / Ant Design / Chakra:** These are heavy, opinionated, and create dependency lock-in via npm packages. shadcn gives you the source files. For a framework that others will fork and customize, owning the UI code is essential.

**Why NOT a full admin template:** Premature. The setup wizard is 3-5 pages (config, OAuth connect, tool selection, status). A dashboard template adds 30+ pages of dead weight. Build only what's needed with shadcn components.

**Install:**
```bash
npx tailwindcss@latest init
npx shadcn@latest init
npx shadcn@latest add button card input label switch tabs form toast
```

### 2. Dynamic Tool Registry: Filesystem Convention (No New Dependency)

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| Node.js `fs` + `path` | built-in | Tool auto-discovery at build time | HIGH |
| glob (via fast-glob) | ^3.3.x | File pattern matching for tool discovery | MEDIUM |

**Why filesystem convention over a plugin registry:** The project already has a clean `src/tools/` directory with 38 tool files following a consistent `{ schema, handler }` export pattern. The simplest registry is: scan `src/tools/`, import each file, register tools whose required env vars are present.

**Pattern:**
```typescript
// src/lib/tool-registry.ts
// At build time or server startup:
// 1. Glob src/tools/*.ts
// 2. Each tool exports: { name, description, schema, handler, pack, requiredEnvVars }
// 3. Filter by: config enables pack + all requiredEnvVars present
// 4. Register surviving tools with server.tool()
```

**Why NOT cosmiconfig / c12:** Overkill. The config is a single file (`mcp.config.ts`) that the framework owns. No need for a config discovery library that searches 15 locations. A direct TypeScript import is simpler and type-safe.

**Why NOT a database-backed registry:** This is a personal server deployed on Vercel serverless. Config lives in the filesystem (committed to repo) and env vars. No database needed for tool registration.

### 3. Configuration System: TypeScript Config File

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| (no new dependency) | - | `mcp.config.ts` at project root | HIGH |

**Why a `.ts` config file:** Type-safe, IDE autocomplete, can import types from the framework. This is the pattern Next.js (`next.config.ts`), Tailwind (`tailwind.config.ts`), and Vite (`vite.config.ts`) all use. Users already understand it.

**Shape:**
```typescript
// mcp.config.ts
import { defineConfig } from './src/lib/config';

export default defineConfig({
  name: "My MCP Server",
  packs: {
    vault: { enabled: true },
    google: { enabled: true, scopes: ['gmail', 'calendar', 'drive', 'contacts'] },
    browser: { enabled: false },
  },
  settings: {
    timezone: "Europe/Paris",
    workingHours: { start: 8, end: 19 },
    locale: "en",
  },
});
```

**Why NOT JSON / YAML config:** No type safety, no IDE completion, no conditional logic. TypeScript config is strictly better for a TypeScript project.

**Why NOT Vercel Edge Config:** Free tier has very limited storage, adds Vercel vendor lock-in, and is designed for runtime reads from edge — not for declaring which tools to load. Config belongs in the repo.

### 4. Google OAuth Flow: Arctic (Lightweight OAuth Client)

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| arctic | ^3.7.0 | OAuth 2.0 client for Google | MEDIUM |

**Why Arctic over Auth.js/NextAuth:** This is NOT a user authentication system. The framework needs a one-time OAuth consent flow where the deployer connects their Google account to get refresh tokens. Auth.js is designed for end-user sessions (sign in, sign out, session management, JWT, CSRF). That's unnecessary complexity for a single-user setup wizard.

Arctic is a lightweight OAuth client library (50+ providers including Google) that handles:
- Authorization URL generation with PKCE
- Token exchange (code -> access_token + refresh_token)
- Token refresh

That's exactly what the setup wizard needs: generate auth URL -> user clicks "Connect Google" -> callback receives code -> exchange for refresh token -> store in env vars.

**Why NOT Auth.js v5:** Auth.js adds middleware, session management, CSRF protection, and multi-provider complexity. The MCP server has ONE user (the deployer). After initial OAuth setup, the refresh token is stored as an env var and used directly. Auth.js would be a large dependency solving the wrong problem.

**Why NOT raw `fetch` to Google OAuth endpoints:** The current `google-auth.ts` already does raw fetch for token refresh, which is fine. But the initial OAuth consent flow (PKCE, state verification, code exchange) has security-sensitive edge cases that Arctic handles correctly.

**Install:**
```bash
npm install arctic
```

### 5. Token/Secret Storage: Environment Variables + Vercel API

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| (no new dependency) | - | Env vars via Vercel dashboard or API | HIGH |
| @vercel/sdk | latest | Programmatic env var management (optional) | LOW |

**Why env vars:** The project already uses env vars for all secrets (MCP_AUTH_TOKEN, GITHUB_PAT, GOOGLE_CLIENT_SECRET, etc.). This is the correct pattern for Vercel serverless. The setup wizard should help users SET these env vars, not replace them with a different storage mechanism.

**Optional enhancement:** The Vercel API allows programmatic creation of env vars. The setup wizard could use this to write OAuth tokens directly to Vercel env vars after the consent flow, eliminating manual copy-paste. But this requires a Vercel API token, adding another env var. LOW confidence — validate during implementation.

**Why NOT a database (Vercel KV, Upstash Redis, etc.):** Secrets should not be in a database. Env vars are the standard for serverless secrets. Adding a database for config storage adds cost, complexity, and a failure point — all for a personal server.

### 6. Form Validation: React Hook Form + Zod

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| react-hook-form | ^7.54.x | Form state management for setup wizard | HIGH |
| @hookform/resolvers | ^5.x | Zod integration for react-hook-form | HIGH |

**Why:** The setup wizard needs multi-step forms (config, OAuth, tool selection). React Hook Form is the standard for Next.js forms — minimal re-renders, built-in validation, works with Server Actions. Zod is already in the project for tool schemas; reusing it for form validation is free.

**Why NOT Formik:** Formik is legacy. React Hook Form has won the Next.js ecosystem.

**Install:**
```bash
npm install react-hook-form @hookform/resolvers
```

### 7. Notifications/Toasts: sonner

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| sonner | ^2.x | Toast notifications for setup wizard | HIGH |

**Why:** Lightweight toast library that shadcn/ui officially recommends and integrates with. Needed for "Google connected successfully", "Configuration saved", error messages in the wizard.

**Install:**
```bash
npm install sonner
```

## Full Installation Command

```bash
# Upgrade existing
npm install @modelcontextprotocol/sdk@^1.29.0

# Setup wizard UI
npx shadcn@latest init
npm install react-hook-form @hookform/resolvers sonner

# OAuth flow
npm install arctic

# Dev dependencies (if not already present via shadcn init)
npm install -D tailwindcss @tailwindcss/postcss

# shadcn components (after init)
npx shadcn@latest add button card input label switch tabs form toast separator badge
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| UI Components | shadcn/ui | Material UI | Heavy, opinionated, npm dependency lock-in |
| UI Components | shadcn/ui | Ant Design | Even heavier, enterprise-focused, not Next.js-native |
| CSS | Tailwind v4 | CSS Modules | Less productive for rapid UI development |
| OAuth | Arctic | Auth.js v5 | Over-engineered for single-user OAuth consent flow |
| OAuth | Arctic | Raw fetch | Security-sensitive PKCE flow shouldn't be hand-rolled |
| Config | mcp.config.ts | cosmiconfig | Overkill — single known config file location |
| Config | mcp.config.ts | JSON/YAML | No type safety, no IDE autocomplete |
| Config storage | Env vars | Vercel Edge Config | Vendor lock-in, free tier limits, wrong abstraction |
| Config storage | Env vars | Database (KV/Redis) | Secrets don't belong in databases, adds cost |
| Tool registry | Filesystem glob | Database | Static config, not runtime-dynamic |
| Forms | React Hook Form | Formik | Legacy, more re-renders, less Next.js integration |
| Toasts | sonner | react-hot-toast | sonner is shadcn's official recommendation |

## What NOT to Add

| Technology | Why Not |
|------------|---------|
| Prisma / Drizzle / any ORM | No database needed. Config is in files + env vars. |
| Redis / KV store | No session state to manage. Serverless = stateless. |
| tRPC | Only 3-4 API routes for the wizard. Plain route handlers suffice. |
| Zustand / Jotai / Redux | Setup wizard state is form-local. No global state needed. |
| next-intl / i18next | English-only for v1. Internationalization is premature. |
| Playwright / Puppeteer | Browser tools already use Stagehand/Browserbase. |
| Stripe / payments | Out of scope — this is a free self-hosted framework. |
| Docker | Target is Vercel deployment. Docker adds complexity for the audience. |

## Architecture Notes for Tool Registry

The key architectural insight: tools should declare their dependencies, and the registry filters at startup.

```typescript
// Each tool file exports a ToolDefinition
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, ZodType>;
  handler: (params: any) => Promise<McpToolResult>;
  pack: 'vault' | 'google' | 'browser' | 'admin' | 'core';
  requiredEnvVars: string[];
}

// Registry loads all tools, filters by config + env vars
// No import changes needed in route.ts — registry handles it
```

This pattern means:
- Adding a tool = adding one file to `src/tools/`
- Enabling a tool pack = setting `enabled: true` in config + providing env vars
- No manual registration in `route.ts` ever again

## Confidence Assessment

| Technology | Confidence | Reason |
|------------|------------|--------|
| shadcn/ui + Tailwind v4 | HIGH | Dominant pattern, verified via official docs and ecosystem |
| Filesystem tool registry | HIGH | Natural extension of existing `src/tools/` convention |
| mcp.config.ts | HIGH | Standard TypeScript config pattern used by Next.js, Tailwind, Vite |
| Arctic for OAuth | MEDIUM | Well-maintained but less widely adopted than Auth.js. Correct fit for the use case but needs validation during implementation. |
| Env var storage | HIGH | Already the pattern in the project, correct for Vercel serverless |
| React Hook Form | HIGH | Standard for Next.js forms, Zod integration is native |
| @modelcontextprotocol/sdk ^1.29.0 | HIGH | Verified latest stable, widely adopted (40K+ dependents) |
| Vercel API for env vars | LOW | Nice-to-have, adds complexity, needs validation |

## Sources

- [mcp-handler GitHub](https://github.com/vercel/mcp-handler) — Vercel MCP adapter, withMcpAuth OAuth support
- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — Latest version 1.29.0
- [MCP Spec: Dynamic Tool Updates](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — Protocol support for dynamic tool lists
- [shadcn/ui Tailwind v4 docs](https://ui.shadcn.com/docs/tailwind-v4) — Full v4 support confirmed
- [shadcn/ui Next.js installation](https://ui.shadcn.com/docs/installation/next) — Official setup guide
- [Arctic OAuth library](https://github.com/pilcrowonpaper/arctic) — v3.7.0, 50+ providers including Google
- [Auth.js v5 with Next.js 16](https://dev.to/huangyongshan46a11y/authjs-v5-with-nextjs-16-the-complete-authentication-guide-2026-2lg) — Auth.js capabilities (considered and rejected)
- [Zod v4 release notes](https://zod.dev/v4) — Stable since July 2025, 14x faster parsing
- [Vercel Storage docs](https://vercel.com/docs/storage) — KV sunset, Edge Config limits
- [c12 config loader](https://unjs.io/packages/c12/) — Considered and rejected (overkill)
- [Cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — Considered and rejected (overkill)
