/**
 * Shared Vercel "Deploy to Vercel" URL for the Kebab MCP template.
 *
 * We pre-attach Upstash Redis via Vercel's `stores` query param so the
 * one-click deploy provisions durable storage alongside the project,
 * instead of leaving the user to install the integration separately
 * after the fact. Without pre-attachment, fresh deploys land on
 * serverless `/tmp` and silently lose all welcome-flow state on the
 * first cold-start (~15 min) — the bug that motivated the v4 welcome
 * refactor.
 *
 * Endpoint choice: `/new/deploy` (not `/new/clone`).
 *
 * `/new/clone` creates a new GitHub repo in the user's account by
 * snapshotting the upstream — but the new repo is a STANDALONE repo,
 * not a GitHub fork (no `parent`, no shared history with upstream).
 * The dashboard's `/api/config/update` route relies on GitHub's
 * Compare API + merge-upstream API, both of which only behave correctly
 * on real forks. With a clone-deployed instance the user is silently
 * stuck on the snapshot they got at deploy time and never receives
 * upstream fixes. We hit this with kebab-mcp-yass on 2026-04-28.
 *
 * `/new/deploy` deploys directly from Yassinello/kebab-mcp — every push
 * to upstream main triggers a redeploy on the user's project. No fork,
 * no copy, no divergence. Trade-off: the Vercel UI for /new/deploy is
 * the generic "New project" screen instead of the dedicated template
 * flow, which is a one-time UX cost vs the alternative ("you never get
 * a security or feature update again").
 *
 * Power users who want to modify the code can fork manually on GitHub
 * and point a fresh Vercel deploy at their fork — that's the documented
 * advanced path, not the default.
 *
 * Spec: https://vercel.com/docs/deployments/deploy-button
 * Integration slug: `upstash` · product slug: `upstash-kv` (KV / Redis).
 */
export const REPO_URL = "https://github.com/Yassinello/kebab-mcp";

export const UPSTREAM_OWNER = REPO_URL.split("/").at(-2)!; // "Yassinello"
export const UPSTREAM_REPO_SLUG = REPO_URL.split("/").at(-1)!; // "kebab-mcp"

const STORES = [
  {
    type: "integration",
    integrationSlug: "upstash",
    productSlug: "upstash-kv",
  },
];

export const VERCEL_DEPLOY_URL =
  "https://vercel.com/new/deploy?" +
  new URLSearchParams({
    "repository-url": REPO_URL,
    "project-name": "kebab-mcp",
    stores: JSON.stringify(STORES),
  }).toString();
