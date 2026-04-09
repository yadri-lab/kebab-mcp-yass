# Architecture Patterns

**Domain:** Modular MCP Server Framework (Next.js / Vercel)
**Researched:** 2026-04-08

## Current State Analysis

The codebase has 38 tools registered via 38 static imports and 38 `server.tool()` calls in a single `route.ts` file (335 lines). Every tool follows the same pattern:

```
export const fooSchema = { ... };          // Zod schema object
export async function handleFoo(params) { ... }  // Handler function
```

The `createMcpHandler` callback receives a `server` object and registers tools synchronously. This is the constraint we work within: the callback runs once at cold start, registering all tools before the handler is returned.

**Key insight:** `createMcpHandler` is a Vercel `mcp-handler` function. The callback is synchronous. But since all imports are resolved at build time in Next.js (webpack bundling), we can use static imports with conditional registration. True dynamic `import()` inside the callback is possible but adds async complexity the SDK does not natively support in the setup callback.

## Recommended Architecture: Registry Pattern with Tool Packs

### Why This Over Alternatives

The registry pattern is the simplest architecture that solves the actual problems: (1) removing hardcoded imports from route.ts, (2) enabling/disabling tool groups via config, (3) making it easy for new users to fork and customize. It avoids over-engineering (no plugin system, no dynamic filesystem scanning) while delivering all the framework goals.

### Component Boundaries

```
mcp.config.ts                    -- User config: which packs are enabled
src/registry/index.ts            -- Registry: collects tools from enabled packs
src/registry/types.ts            -- ToolDefinition interface
src/packs/vault/index.ts         -- Pack manifest: exports tool definitions array
src/packs/vault/tools/*.ts       -- Individual tool files (unchanged pattern)
src/packs/vault/lib/*.ts         -- Pack-specific lib (github.ts)
src/packs/google/index.ts        -- Google pack manifest
src/packs/google/tools/*.ts      -- Gmail, Calendar, Contacts, Drive tools
src/packs/google/lib/*.ts        -- google-auth.ts, google-fetch.ts, gmail.ts, etc.
src/packs/browser/index.ts       -- Browser pack manifest
src/packs/browser/tools/*.ts     -- web-browse, web-extract, web-act, linkedin
src/packs/browser/lib/*.ts       -- browserbase.ts
src/packs/admin/index.ts         -- Admin pack (mcp-logs, my-context)
src/lib/logging.ts               -- Shared: withLogging (used by all packs)
app/api/[transport]/route.ts     -- Thin: imports registry, loops to register
```

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `mcp.config.ts` | Declares enabled packs + user settings (timezone, name) | Read by registry |
| `src/registry/` | Collects ToolDefinition[] from enabled packs | Reads config, imports packs, consumed by route.ts |
| `src/packs/*/index.ts` | Pack manifest: exports array of ToolDefinition | Imports from own tools/, uses own lib/ |
| `src/packs/*/tools/*.ts` | Individual tool (schema + handler) | Uses pack's lib/ and shared lib/ |
| `src/packs/*/lib/*.ts` | Pack-specific API wrappers | Called by tools in same pack |
| `src/lib/` | Shared utilities (logging, auth) | Used by all packs |
| `app/api/[transport]/route.ts` | MCP endpoint: auth + tool registration | Calls registry, passes tools to mcp-handler |

### Data Flow

```
Cold Start:
  mcp.config.ts (user config)
       |
       v
  registry/index.ts reads config.packs[]
       |
       v
  For each enabled pack:
    import pack/index.ts -> get ToolDefinition[]
       |
       v
  Flatten all tools into single ToolDefinition[]
       |
       v
  route.ts: createMcpHandler((server) => {
    tools.forEach(t => server.tool(t.name, t.description, t.schema, withLogging(t.name, t.handler)))
  })
       |
       v
  MCP handler ready to serve requests

Request:
  HTTP request -> auth check -> mcpHandler(request) -> MCP SDK routes to tool -> handler runs -> response
```

### Core Types

```typescript
// src/registry/types.ts
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;  // Zod schema object
  handler: (params: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

export interface PackManifest {
  name: string;           // "vault", "google", "browser", "admin"
  description: string;
  tools: ToolDefinition[];
  requiredEnv?: string[]; // Env vars needed for this pack to work
}
```

### Config File

```typescript
// mcp.config.ts
import type { PackManifest } from "@/registry/types";

export interface McpConfig {
  server: {
    name: string;
    version: string;
  };
  user: {
    name: string;
    timezone: string;
    locale: string;
  };
  packs: string[];  // ["vault", "google", "browser", "admin"]
}

const config: McpConfig = {
  server: {
    name: "MyMCP",
    version: "5.0.0",
  },
  user: {
    name: "Yassine",
    timezone: "Europe/Paris",
    locale: "fr-FR",
  },
  packs: ["vault", "google", "browser", "admin"],
};

export default config;
```

### Registry

```typescript
// src/registry/index.ts
import config from "../../mcp.config";
import type { ToolDefinition } from "./types";

// Static pack imports (webpack can tree-shake unused packs)
const packLoaders: Record<string, () => ToolDefinition[]> = {
  vault: () => require("@/packs/vault").tools,
  google: () => require("@/packs/google").tools,
  browser: () => require("@/packs/browser").tools,
  admin: () => require("@/packs/admin").tools,
};

export function getEnabledTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const packName of config.packs) {
    const loader = packLoaders[packName];
    if (!loader) {
      console.warn(`[MyMCP] Unknown pack: ${packName}, skipping`);
      continue;
    }
    // Also check required env vars at runtime
    tools.push(...loader());
  }
  return tools;
}
```

### Route.ts (After Refactor)

```typescript
// app/api/[transport]/route.ts
import { createMcpHandler } from "mcp-handler";
import { timingSafeEqual } from "crypto";
import { withLogging } from "@/lib/logging";
import { getEnabledTools } from "@/registry";
import config from "../../mcp.config";

const tools = getEnabledTools();

const mcpHandler = createMcpHandler(
  (server) => {
    for (const tool of tools) {
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        withLogging(tool.name, async (params) => tool.handler(params))
      );
    }
  },
  { serverInfo: { name: config.server.name, version: config.server.version } },
  { basePath: "/api", maxDuration: 60 }
);

// ... auth + handler unchanged
```

### Pack Manifest Example

```typescript
// src/packs/vault/index.ts
import type { ToolDefinition } from "@/registry/types";
import { vaultReadSchema, handleVaultRead } from "./tools/vault-read";
import { vaultWriteSchema, handleVaultWrite } from "./tools/vault-write";
// ... other vault tools

export const tools: ToolDefinition[] = [
  {
    name: "vault_read",
    description: "Read a note from the Obsidian vault...",
    schema: vaultReadSchema,
    handler: handleVaultRead,
  },
  {
    name: "vault_write",
    description: "Create or update a note in the Obsidian vault...",
    schema: vaultWriteSchema,
    handler: handleVaultWrite,
  },
  // ... all vault tools
];
```

## Architecture Options Considered

### Option A: Registry Pattern with Tool Packs (RECOMMENDED)

**What:** Static pack imports with config-driven enablement. Packs are directories containing a manifest (index.ts) that exports an array of ToolDefinitions. Config file lists which packs to enable.

**Pros:**
- Simple to understand (no magic, no dynamic imports)
- TypeScript type safety throughout
- Webpack can tree-shake disabled packs (if using conditional imports)
- Individual tool files stay unchanged (only move directories)
- Easy for users to fork and add/remove packs
- Works perfectly with Next.js/Vercel bundling

**Cons:**
- Adding a new pack requires editing the `packLoaders` map in registry
- Not zero-config (user must edit config file)

**Complexity:** Low. ~200 lines of new code (registry + types + config).

**Build order:** Types -> Config -> Pack manifests -> Registry -> Route.ts refactor

### Option B: Filesystem Auto-Discovery

**What:** Scan `src/packs/*/index.ts` at build time. Any directory with an index.ts that exports a PackManifest gets auto-registered. No central pack list needed.

**Pros:**
- Zero registration: drop a folder, it appears
- Closest to mcp-framework's approach

**Cons:**
- Cannot use filesystem scanning at runtime on Vercel (serverless, no fs access to source)
- Requires a build step (codegen or webpack plugin) to generate a pack manifest
- Added complexity for marginal gain (how often are new packs added?)
- Harder to debug (which packs loaded? why didn't mine load?)
- Next.js has no built-in `require.context` or glob imports like Webpack raw

**Complexity:** Medium-High. Requires custom webpack config or codegen script.

**Verdict:** Over-engineered for this use case. A framework with 4-6 packs does not need auto-discovery. The registry map in Option A is 6 lines.

### Option C: Dynamic Import with Async Loading

**What:** Use `await import()` to load packs at runtime based on config. The `createMcpHandler` callback becomes async (or tools are pre-loaded before calling createMcpHandler).

**Pros:**
- True runtime flexibility
- Could load packs based on runtime env vars (not just build-time)

**Cons:**
- `createMcpHandler` callback is synchronous -- cannot await inside it
- Must pre-load all tools before calling createMcpHandler (adds startup complexity)
- Dynamic imports in Next.js serverless have cold-start implications
- No real benefit over static imports for a known set of packs

**Complexity:** Medium. Requires async initialization pattern wrapping the handler.

**Verdict:** Unnecessary complexity. Static imports with conditional registration achieve the same result more simply.

### Option D: Monorepo with Separate Pack Packages

**What:** Each pack is its own npm package in a monorepo (e.g., `@mymcp/pack-vault`, `@mymcp/pack-google`). Users install only the packs they want.

**Pros:**
- Clean separation, independent versioning
- Users install only what they need
- Could publish to npm for community packs later

**Cons:**
- Massive over-engineering for a personal tool framework
- Monorepo tooling (turborepo, nx) adds complexity
- Users must manage multiple dependencies
- Deployment becomes harder (install specific packages on Vercel)
- The PROJECT.md explicitly puts "tool marketplace or plugin system" in Out of Scope

**Complexity:** High. Requires monorepo setup, build pipeline, dependency management.

**Verdict:** Wrong abstraction level. This is a single-deploy personal server, not a plugin ecosystem. If adoption warrants it later, Option A can evolve to this.

## Patterns to Follow

### Pattern 1: Pack-Level Env Var Gating

**What:** Each pack declares its required env vars. The registry skips packs whose env vars are missing, with a warning.

**When:** Always. This is the primary mechanism for conditional tool loading.

```typescript
// src/packs/google/index.ts
export const requiredEnv = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];

export function isAvailable(): boolean {
  return requiredEnv.every(key => !!process.env[key]);
}
```

```typescript
// registry/index.ts — enhanced
import config from "../../mcp.config";

export function getEnabledTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const packName of config.packs) {
    const pack = packLoaders[packName]?.();
    if (!pack) continue;
    if (pack.requiredEnv?.some(key => !process.env[key])) {
      console.warn(`[MyMCP] Pack "${packName}" disabled: missing env vars`);
      continue;
    }
    tools.push(...pack.tools);
  }
  return tools;
}
```

### Pattern 2: User Config Injection

**What:** Pass user config (name, timezone, locale) to tool handlers via a shared context, eliminating hardcoded "Yassine" and "Europe/Paris" references.

**When:** Any tool that formats dates, references the user by name, or uses locale-specific logic.

```typescript
// src/lib/user-context.ts
import config from "../../mcp.config";

export const userConfig = {
  name: config.user.name,
  timezone: config.user.timezone,
  locale: config.user.locale,
};
```

Tools import `userConfig` instead of hardcoding values. This is simpler than dependency injection and sufficient for a single-user server.

### Pattern 3: Shared Lib vs Pack Lib

**What:** Code used by multiple packs lives in `src/lib/`. Code used by only one pack lives in `src/packs/<pack>/lib/`.

**When:** Always. This prevents cross-pack coupling.

```
src/lib/logging.ts        -- Used by all packs (shared)
src/lib/user-context.ts   -- Used by all packs (shared)
src/packs/google/lib/google-auth.ts  -- Only Google pack (pack-local)
src/packs/vault/lib/github.ts        -- Only Vault pack (pack-local)
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: God Registry File
**What:** Moving all 38 tool registrations from route.ts into a single registry file.
**Why bad:** Same problem, different file. No modularity gained.
**Instead:** Each pack owns its tool list via its manifest.

### Anti-Pattern 2: Over-Abstracted Tool Base Class
**What:** Creating an abstract `BaseTool` class that all tools must extend.
**Why bad:** The existing `{ schema, handler }` pattern is already clean and simple. A class hierarchy adds boilerplate and inheritance complexity for zero benefit.
**Instead:** Keep the current functional pattern. Just add a ToolDefinition interface for the manifest.

### Anti-Pattern 3: Runtime Filesystem Scanning
**What:** Using `fs.readdirSync` to discover tool files at runtime.
**Why bad:** Does not work on Vercel serverless (no source files in runtime). Even if it did, it breaks webpack tree-shaking and type safety.
**Instead:** Static imports in pack manifests.

### Anti-Pattern 4: Separate Config Per Pack
**What:** Each pack has its own config file (vault.config.ts, google.config.ts).
**Why bad:** Users must edit 4+ files to configure their server. Single config file is much friendlier.
**Instead:** One `mcp.config.ts` with a `packs` array and a `user` section.

## Scalability Considerations

| Concern | Current (1 user) | Framework (10 users) | Community (100+ forks) |
|---------|------------------|---------------------|----------------------|
| Tool count | 38 static imports | 4-6 packs, ~40 tools | Same structure, users add custom packs |
| Config | Hardcoded | Single config file | Same config file, documented clearly |
| New pack | Edit route.ts | Add pack dir + 1 line in registry map | Same, with template/example pack |
| Build time | ~10s | ~10s (same imports, different structure) | Same |
| Cold start | All tools loaded | All enabled tools loaded | Same (serverless = full load each time) |

Cold start is not a concern here: Vercel serverless always loads the full bundle. There is no benefit to lazy-loading individual tools. The pack-level gating (skip disabled packs) is purely about user experience, not performance.

## Suggested Build Order

Build order is constrained by dependencies:

1. **Types first** (`src/registry/types.ts`) - No dependencies. Defines ToolDefinition and PackManifest interfaces.

2. **Config file** (`mcp.config.ts`) - Depends on types. User-facing configuration.

3. **Reorganize tools into packs** - Move files from `src/tools/` and `src/lib/` into `src/packs/*/`. This is the biggest task (file moves, import path updates) but is purely mechanical.

4. **Pack manifests** (`src/packs/*/index.ts`) - Each pack exports its tools array. Depends on tools being in the right directory.

5. **Registry** (`src/registry/index.ts`) - Depends on types, config, and pack manifests. Collects and filters tools.

6. **Route.ts refactor** - Depends on registry. Replace 38 imports + 38 server.tool() calls with a loop.

7. **User config injection** - Replace hardcoded values (timezone, name, locale) with imports from user-context. Can be done incrementally per pack.

**Critical path:** Types -> Pack reorg -> Manifests -> Registry -> Route.ts. Steps 2 and 7 can happen in parallel with the critical path.

**Risk:** Step 3 (reorganizing files) is the highest-risk step because it touches every file. Should be done as a single atomic commit with all import paths updated. Automated tests or a build check immediately after is essential.

## Sources

- [mcp-handler (Vercel)](https://github.com/vercel/mcp-handler) - createMcpHandler API
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Server tool registration
- [mcp-framework (QuantGeekDev)](https://github.com/QuantGeekDev/mcp-framework) - Auto-discovery pattern reference
- [Next.js Environment Variables](https://nextjs.org/docs/pages/guides/environment-variables) - Build-time vs runtime env
- Codebase analysis: route.ts, tool files, lib files (direct inspection)
