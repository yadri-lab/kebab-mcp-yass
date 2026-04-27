---
title: Welcome to Kebab MCP
summary: Tour the dashboard in 60 seconds and pick where to go next
order: 1
---

## What this dashboard is for

You're looking at the **Kebab MCP dashboard** — the control panel for your personal MCP server. From here you wire up connectors (Gmail, Notion, Slack, Obsidian, …), author skills, watch tool calls in real time, and check that your storage is healthy. None of this is required to start using the MCP endpoint, but it's the difference between "Kebab MCP works" and "Kebab MCP works the way I want."

If you just deployed and got dropped here from the Welcome wizard: skip to [Where to start](#where-to-start). Otherwise read on for a tab-by-tab tour.

## Tab-by-tab guide

### Overview

The default landing tab. Shows your **instance health widget** (token status, Vercel auto-deploy availability, endpoint URL), a **setup health widget**, and a snapshot of how many connectors and tools are active. If you ever come back wondering "is everything OK," start here.

The Overview tab also surfaces an **upstream updates banner**: when your Vercel fork drifts behind `Yassinello/kebab-mcp`, you'll see how many commits are pending, the list of incoming commits, any breaking-change warnings, and an **Update now** button that calls GitHub's `merge-upstream` API + triggers a Vercel redeploy. A daily cron pre-fetches the status, so the banner loads instantly. The refresh icon (↻) next to "checked Xh ago" forces a live re-check (30s debounce). Configure the PAT once in Settings → Advanced → Updates; see [Configuring updates](#configuring-updates) for the full setup.

### Connectors

The credential surface for every connector Kebab MCP ships. Each one knows its required env vars, exposes a per-connector setup guide, and a **Test connection** button that verifies the credentials are real before you trust them.

→ See [Connector setup](#connectors) for per-connector instructions.

### Tools

A live list of every registered tool, grouped by connector, with per-tool toggles. Use this to disable individual tools without removing the whole connector — useful if you want Gmail read but not Gmail send, or Calendar but not RSVP.

### Skills

Browse, edit, and create skills (prompt templates exposed as MCP tools and prompts). Two ways to author:

- **From scratch** — write the prompt body, declare arguments, save
- **Compose** — pick an existing tool, pre-fill some arguments, expose the rest as `{{placeholders}}`

→ See [Authoring skills](#skills).

### Playground

A mini-chat UI for invoking any registered tool with custom arguments, seeing the raw response, and timing the call. Use this to sanity-check a connector after setup, or to debug a tool that's misbehaving in your AI client.

### Logs

Recent tool calls with timestamp, latency, status, and error. Persists across requests when KV is configured (`MYMCP_DURABLE_LOGS=true`); ephemeral otherwise. Filter by connector, tool, or status.

### Storage

Shows which storage mode you're in (`KV`, `File`, `Static`, or one of the warning states), the data directory or KV endpoint, latency, and key counts. This tab is where you upgrade from file → KV, recover from KV-degraded, or react to the `/tmp` ephemeral trap.

→ See [Storage modes & data persistence](#storage).

### Settings

Instance-wide settings: timezone, locale, display name, context file path, tool timeout, error webhook URL. Plus backup/restore (export/import skills + settings as JSON).

## Where to start

Pick the path that matches what you came here to do.

### "I want to add a connector"

1. Open **Connectors**
2. Find the connector you want (Google, Notion, Slack, …)
3. Click the per-connector setup guide for env-var instructions
4. Paste credentials in the dashboard, hit **Test connection**
5. Once it shows green, the connector's tools auto-register at the MCP endpoint

If the **Storage** badge is orange (`Filesystem (temporary)`), fix that first — your credentials will vanish otherwise. See [Storage](#storage).

### "I want to try a skill"

1. Open **Skills**
2. Click **Compose** to wrap an existing tool, or **New** for a from-scratch prompt template
3. Save — the skill registers as `skill_<name>` immediately
4. Open **Playground**, pick `skill_<name>`, run it with sample inputs

### "I want to test a tool"

1. Open **Playground**
2. Pick the tool from the dropdown
3. Fill the schema fields, click **Run**
4. Inspect the response, latency, and (on error) the structured error code

### "I want to keep my fork up to date with upstream"

1. Open **Settings → Advanced → Updates**
2. Paste a GitHub Personal Access Token — `public_repo` scope (or `repo` for private forks). Fine-grained PATs need *Contents: read/write* on your fork.
3. Click **Save token** then **Test connection** — green confirms it works
4. Switch back to **Overview** — banner shows live status

After that, a daily cron at 8h UTC pre-fetches upstream commits into KV. When new commits land, you'll see a banner with the count, the commit list, and an **Update now** button that calls GitHub's `merge-upstream` API. Vercel redeploys automatically afterwards.

The ↻ icon next to "checked Xh ago" forces a re-check between cron runs (30s debounce). The cache is auto-invalidated whenever you save a new PAT, so token rotations take effect immediately.

If your fork has diverged (you committed locally on `main`), the auto-update is blocked — resolve manually on GitHub. If your PAT expires or has insufficient scope, the banner shows a dedicated "GitHub authentication failed" message with reconfiguration link.

To disable the feature entirely, set `KEBAB_DISABLE_UPDATE_API=1` in your Vercel env vars.

## When stuck

- Check the **Logs** tab for the most recent invocation — error column shows what went wrong
- Read [Troubleshooting](#troubleshooting) — covers the dozen most common issues including all v3 storage failure modes
- Read the [FAQ](#faq) for design-decision questions ("can I run multi-user?", "what happens on cold starts?", …)
- Still stuck? [Open an issue](https://github.com/Yassinello/kebab-mcp/issues) — include Kebab MCP version (sidebar footer), connector affected, and the Logs entry if applicable

## See also

→ [Getting started](#getting-started) — the 5-minute deploy if you skipped it
→ [Storage](#storage) — durability of your saves, when to use which mode
→ [Connector setup](#connectors) — per-connector credential walkthroughs
