# Contributing to MyMCP

Thank you for considering a contribution. MyMCP grows through community packs — every new integration you add makes the tool more useful for every developer who deploys it.

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Good First Issues](#good-first-issues)
- [Pack Ideas Wanted](#pack-ideas-wanted)
- [Architecture Overview](#architecture-overview)
- [Adding a Tool](#adding-a-tool)
- [Adding a Pack (step by step)](#adding-a-pack-step-by-step)
- [Custom Pack (personal tools)](#custom-pack-for-your-own-tools)
- [Writing Tests](#writing-tests)
- [Code Conventions](#code-conventions)
- [Running Locally](#running-locally)
- [Pull Request Process](#pull-request-process)
- [Commit Convention](#commit-convention)
- [Getting Help](#getting-help)

---

## Ways to Contribute

| Type | What it looks like |
|------|-------------------|
| **New pack** | A new integration with an external service (Linear, Airtable, HubSpot…) |
| **New tool in existing pack** | Add a missing endpoint to Google, Slack, Notion, etc. |
| **Bug fix** | Something isn't working as documented |
| **Docs** | Improve this guide, the README, or inline tool descriptions |
| **Issue triage** | Reproduce bugs, label issues, ask clarifying questions |

Not sure where to start? Check [Good First Issues](#good-first-issues) below.

---

## Good First Issues

Look for the `good first issue` label on GitHub. These are scoped tasks with clear acceptance criteria and no deep architectural knowledge required.

**Examples of what good-first issues look like:**

- Add a missing tool to an existing pack (e.g., `google_drive_upload`, `slack_reactions`)
- Fix a tool description that is confusing or inaccurate
- Add a contract test for a pack that lacks coverage
- Improve error messages in an existing tool handler
- Add `.env.example` documentation for a new env var

If you want to propose a good first issue yourself, open an issue with the `good first issue` label and a short description.

---

## Pack Ideas Wanted

The following packs are on the roadmap and would make great community contributions:

| Pack | Key tools | API docs |
|------|-----------|----------|
| **Linear** | list issues, create issue, update issue, search | [docs](https://developers.linear.app/docs) |
| **Airtable** | list records, create record, update, query | [docs](https://airtable.com/developers/web/api/introduction) |
| **HubSpot** | contacts, companies, deals, notes | [docs](https://developers.hubspot.com/docs/api/overview) |
| **Jira** | list issues, create, update, search | [docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) |
| **GitHub PRs** | list PRs, review, comment | [docs](https://docs.github.com/en/rest) |
| **Todoist** | tasks, projects, labels | [docs](https://developer.todoist.com/rest/v2/) |
| **Raindrop** | bookmarks, collections, search | [docs](https://developer.raindrop.io) |
| **Readwise** | highlights, books, articles | [docs](https://readwise.io/api_deets) |

Have an idea not on this list? Open a [New Pack](https://github.com/Yassinello/mymcp/issues/new?template=new-pack.md) issue.

---

## Architecture Overview

```
src/
  core/           ← Framework-level code (types, registry, config, auth, logging)
  packs/
    google/       ← Google Workspace pack (18 tools)
    vault/        ← Obsidian Vault pack (14 tools)
    browser/      ← Browser Automation pack (4 tools)
    slack/        ← Slack pack (6 tools)
    notion/       ← Notion pack (5 tools)
    apify/        ← Apify — LinkedIn + actors (8 tools)
    admin/        ← Admin & Observability pack (1 tool)
```

### Framework vs Instance

**Framework-level** (lives in code, shared by all users):
- Pack manifests, registry logic, types, auth model, dashboard structure

**Instance-level** (lives in env vars, unique per user):
- Secrets, display name, timezone, locale, active packs

**Rule:** If it's personal or changes per deployment, it MUST be an env var, never hardcoded.

### How a pack activates

1. Pack declares `requiredEnvVars` in its manifest
2. Registry checks at startup: if all required env vars are set → pack activates
3. Tools from active packs are registered on the MCP endpoint
4. Dashboard, health endpoint, and admin API derive their state from the registry

---

## Adding a Tool

1. Create `src/packs/<pack>/tools/my-tool.ts`:

```typescript
import { z } from "zod";

export const myToolSchema = {
  input: z.string().describe("What this input does"),
};

export async function handleMyTool(params: { input: string }) {
  // Your logic here
  return {
    content: [{ type: "text" as const, text: "Result" }],
  };
}
```

2. Add it to the pack manifest (`src/packs/<pack>/manifest.ts`):

```typescript
import { myToolSchema, handleMyTool } from "./tools/my-tool";

// Add to the tools array:
{
  name: "my_tool",
  description: "What this tool does",
  schema: myToolSchema,
  handler: async (params) => handleMyTool(params as { input: string }),
}
```

That's it. The registry picks it up automatically.

---

## Adding a Pack (step by step)

### Step 1 — Create the directory structure

```
src/packs/mypack/
  manifest.ts       ← Pack definition (single source of truth)
  lib/              ← API client, helpers, auth wrappers
  tools/            ← One file per tool
    my-tool-one.ts
    my-tool-two.ts
```

### Step 2 — Write the manifest

```typescript
// src/packs/mypack/manifest.ts
import type { PackManifest } from "@/core/types";
import { myToolOneSchema, handleMyToolOne } from "./tools/my-tool-one";
import { myToolTwoSchema, handleMyToolTwo } from "./tools/my-tool-two";

export const myPack: PackManifest = {
  id: "mypack",
  label: "My Service",
  description: "What this pack enables (one sentence)",
  requiredEnvVars: ["MYSERVICE_API_KEY"],
  tools: [
    {
      name: "mypack_action_one",
      description: "What this tool does. Be specific — this text goes in the MCP tool description.",
      schema: myToolOneSchema,
      handler: async (params) => handleMyToolOne(params as Parameters<typeof handleMyToolOne>[0]),
    },
    {
      name: "mypack_action_two",
      description: "What this tool does.",
      schema: myToolTwoSchema,
      handler: async (params) => handleMyToolTwo(params as Parameters<typeof handleMyToolTwo>[0]),
    },
  ],
};
```

### Step 3 — Write the tools

Each tool file exports a Zod schema and a handler function:

```typescript
// src/packs/mypack/tools/my-tool-one.ts
import { z } from "zod";

export const myToolOneSchema = {
  query: z.string().describe("Search query"),
  limit: z.number().optional().default(10).describe("Max results to return"),
};

export async function handleMyToolOne(params: {
  query: string;
  limit?: number;
}) {
  const apiKey = process.env.MYSERVICE_API_KEY!;
  // Call your API here
  const results = await fetchFromMyService(apiKey, params.query, params.limit ?? 10);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(results, null, 2),
      },
    ],
  };
}
```

### Step 4 — Register the pack

Add your pack to `src/core/registry.ts`:

```typescript
import { myPack } from "@/packs/mypack/manifest";

const ALL_PACKS: PackManifest[] = [
  googlePack,
  vaultPack,
  // ... existing packs ...
  myPack,  // ← Add here
];
```

### Step 5 — Document env vars

Add required env vars to `.env.example`:

```bash
# My Service Pack
# Get your API key at: https://myservice.com/settings/api
MYSERVICE_API_KEY=
```

### Step 6 — Write tests

See [Writing Tests](#writing-tests) below.

### Step 7 — Update the README

Add your pack to the Tool Packs section in `README.md`:

```markdown
### My Service — N tools

| Tool | What it does |
|------|-------------|
| `mypack_action_one` | Description |
| `mypack_action_two` | Description |

**Requires:** `MYSERVICE_API_KEY`
```

Also update the tool count in the README header and architecture diagram.

---

## Custom Pack (for your own tools)

If you want to add personal tools without modifying the framework:

1. Create `src/packs/custom/manifest.ts`:

```typescript
import type { PackManifest } from "@/core/types";
import { myToolSchema, handleMyTool } from "./tools/my-tool";

export const customPack: PackManifest = {
  id: "custom",
  label: "Custom Tools",
  description: "Your personal tools",
  requiredEnvVars: [], // or your own env vars
  tools: [
    {
      name: "my_tool",
      description: "What it does",
      schema: myToolSchema,
      handler: async (params) => handleMyTool(params as { input: string }),
    },
  ],
};
```

2. Register in `src/core/registry.ts`:
```typescript
import { customPack } from "@/packs/custom/manifest";
const ALL_PACKS = [...existing, customPack];
```

3. Add `src/packs/custom/` to `.gitignore` if you don't want it tracked upstream.

---

## Deprecating a Tool

Add a `deprecated` field to the tool definition:

```typescript
{
  name: "old_tool",
  description: "This tool does X",
  deprecated: "Use new_tool instead", // Shows warning in dashboard + MCP description
  schema: oldToolSchema,
  handler: async (params) => handleOldTool(params),
}
```

---

## Writing Tests

### Contract tests (required for new packs)

Contract tests verify tool schemas are valid and tools are registered correctly. Add a contract test for your pack in `src/packs/mypack/__tests__/contract.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { myPack } from "../manifest";

describe("myPack contract", () => {
  it("has required fields", () => {
    expect(myPack.id).toBe("mypack");
    expect(myPack.label).toBeTruthy();
    expect(myPack.requiredEnvVars).toBeInstanceOf(Array);
    expect(myPack.tools.length).toBeGreaterThan(0);
  });

  it("all tools have name and description", () => {
    for (const tool of myPack.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("tool names follow naming convention", () => {
    for (const tool of myPack.tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
```

### Running tests

```bash
npm run test:contract   # Contract tests for all packs
npm run test:e2e        # Full E2E smoke test (starts server, checks tool listing)
npm test                # All tests
```

---

## Code Conventions

- All tool handlers export `{ schema, handler }` pattern
- Every tool is wrapped in `withLogging()` via the registry
- Use `getInstanceConfig()` for timezone/locale, never hardcode
- No personal references in framework code (no "your", "my", specific names in descriptions)
- TypeScript strict mode, no `any` in public APIs
- Tool names: `packid_verb_noun` — e.g., `google_calendar_create`, `slack_send`
- Descriptions are generic and explain what the tool does (not who uses it)

---

## Running Locally

```bash
cp .env.example .env
# Fill in the credentials for the packs you want to test
npm install
npm run dev             # http://localhost:3000
```

To test your pack is registered:
```bash
curl http://localhost:3000/api/health
# Should show your pack in the active packs list
```

Pre-commit hook runs `lint-staged` + contract tests. Fix any failures before pushing.

---

## Pull Request Process

1. **Fork** the repo and create a branch: `feat/mypack-pack` or `fix/slack-send-encoding`
2. **Build your change** following the architecture above
3. **Add tests** — contract tests are required for new packs
4. **Run the full suite** locally: `npm run lint && npm run test:contract && npm run build`
5. **Open a PR** with:
   - A clear title: `feat: add Linear pack (6 tools)` or `fix: handle empty vault search results`
   - A description of what it does and what credentials are needed
   - Any relevant API documentation links
6. **Respond to review** — a maintainer will review within a few days

### PR Checklist

- [ ] New pack: manifest + tools + contract tests + `.env.example` docs + README update
- [ ] New tool in existing pack: tool file + manifest entry + test coverage
- [ ] Bug fix: description of root cause + test that would have caught it
- [ ] No `any` in public APIs
- [ ] Tool descriptions are generic (no personal references)
- [ ] `npm run lint` passes
- [ ] `npm run test:contract` passes
- [ ] `npm run build` passes

---

## Commit Convention

```
feat: add new tool/feature
fix: bug fix
refactor: code restructure
docs: documentation changes
test: test additions or fixes
chore: maintenance
```

Examples:
```
feat: add Linear pack with 6 tools (list, get, create, update, comment, search)
fix: handle empty results in vault_search
docs: add Airtable to pack ideas list
```

---

## Getting Help

- **GitHub Issues** — bug reports and feature requests
- **GitHub Discussions** — questions, ideas, show your setup
- **Discord** — real-time chat with maintainers and contributors

If you're not sure whether an idea is a good fit before writing code, open an issue or discussion first. We'd rather align upfront than have you build something that needs major rework.

---

*MyMCP grows through community contributions. Every pack you add makes it more useful for every developer who deploys it.*
