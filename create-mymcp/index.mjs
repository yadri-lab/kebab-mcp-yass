#!/usr/bin/env node

// create-mymcp — Interactive installer for MyMCP
// Usage: npx @yassinello/create-mymcp@latest

import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const log = (msg) => console.log(msg);
const step = (n, msg) => log(`\n${CYAN}[${n}]${RESET} ${BOLD}${msg}${RESET}`);
const ok = (msg) => log(`  ${GREEN}✓${RESET} ${msg}`);
const warn = (msg) => log(`  ${YELLOW}!${RESET} ${msg}`);
const info = (msg) => log(`  ${DIM}${msg}${RESET}`);

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
  } catch {
    return null;
  }
}

function hasCommand(cmd) {
  const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
  return run(check) !== null;
}

async function confirm(msg, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await ask(`  ${msg} [${hint}] `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Strip surrounding quotes and trim whitespace */
function cleanPath(input) {
  return input.trim().replace(/^["']|["']$/g, "");
}

/** Check if a directory exists and is non-empty */
function isDirNonEmpty(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Clean a credential value:
 * - Strip "KEY=" prefix if user pasted "GOOGLE_CLIENT_ID=value"
 * - Return null for non-values like "NA", "N/A", "none", "skip", "-", ""
 */
function cleanCredential(value, expectedKey) {
  let cleaned = value.trim();

  // Strip "KEY=" prefix if user pasted the whole line
  const prefixPattern = new RegExp(`^${expectedKey}\\s*=\\s*`, "i");
  cleaned = cleaned.replace(prefixPattern, "");

  // Also strip any generic KEY= prefix (e.g., user pasted from .env)
  cleaned = cleaned.replace(/^[A-Z_]+=/, "");

  // Detect non-values
  const skipValues = ["na", "n/a", "none", "skip", "-", "no", ""];
  if (skipValues.includes(cleaned.toLowerCase())) {
    return null;
  }

  return cleaned;
}

/**
 * Normalize a timezone input:
 * - "Paris" → "Europe/Paris"
 * - "New York" → "America/New_York"
 * - "UTC" → "UTC"
 */
const TIMEZONE_SHORTCUTS = {
  paris: "Europe/Paris",
  london: "Europe/London",
  berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam",
  brussels: "Europe/Brussels",
  madrid: "Europe/Madrid",
  rome: "Europe/Rome",
  lisbon: "Europe/Lisbon",
  zurich: "Europe/Zurich",
  tokyo: "Asia/Tokyo",
  shanghai: "Asia/Shanghai",
  singapore: "Asia/Singapore",
  dubai: "Asia/Dubai",
  mumbai: "Asia/Kolkata",
  sydney: "Australia/Sydney",
  auckland: "Pacific/Auckland",
  "new york": "America/New_York",
  "new_york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  "los_angeles": "America/Los_Angeles",
  chicago: "America/Chicago",
  denver: "America/Denver",
  toronto: "America/Toronto",
  "sao paulo": "America/Sao_Paulo",
  "são paulo": "America/Sao_Paulo",
  montreal: "America/Montreal",
  utc: "UTC",
  gmt: "UTC",
};

function normalizeTimezone(input) {
  const lower = input.trim().toLowerCase();
  if (TIMEZONE_SHORTCUTS[lower]) return TIMEZONE_SHORTCUTS[lower];
  // If it already looks like a valid IANA timezone (contains /), return as-is
  if (input.includes("/")) return input.trim();
  // Default
  return input.trim();
}

/**
 * Normalize a locale input:
 * - "fr" → "fr-FR"
 * - "en" → "en-US"
 * - "de" → "de-DE"
 */
const LOCALE_SHORTCUTS = {
  fr: "fr-FR",
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-PT",
  nl: "nl-NL",
  ja: "ja-JP",
  zh: "zh-CN",
  ko: "ko-KR",
  ar: "ar-SA",
  ru: "ru-RU",
};

function normalizeLocale(input) {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (LOCALE_SHORTCUTS[lower]) return LOCALE_SHORTCUTS[lower];
  return trimmed;
}

/**
 * Extract owner/repo from a GitHub URL or return as-is
 * - "https://github.com/Yassinello/obsidyass" → "Yassinello/obsidyass"
 * - "Yassinello/obsidyass" → "Yassinello/obsidyass"
 */
function normalizeGitHubRepo(input) {
  const cleaned = input.trim().replace(/\/+$/, ""); // strip trailing slashes
  const urlMatch = cleaned.match(/github\.com\/([^/]+\/[^/]+)/);
  if (urlMatch) return urlMatch[1];
  return cleaned;
}

/**
 * Slugify a project name for Vercel:
 * - Lowercase, replace spaces with dashes, strip invalid chars
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/---+/g, "--") // Vercel doesn't allow ---
    .slice(0, 100);
}

/**
 * Mask a secret for display: show first 4 chars, then ***
 */
function maskSecret(value) {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

// ── Pack definitions ─────────────────────────────────────────────────

const PACKS = [
  {
    id: "google",
    name: "Google Workspace",
    tools: "Gmail, Calendar, Contacts, Drive (18 tools)",
    vars: [
      {
        key: "GOOGLE_CLIENT_ID",
        prompt: "Google OAuth Client ID",
        help: "https://console.cloud.google.com/apis/credentials",
      },
      { key: "GOOGLE_CLIENT_SECRET", prompt: "Google OAuth Client Secret", sensitive: true },
      {
        key: "GOOGLE_REFRESH_TOKEN",
        prompt: "Google OAuth Refresh Token",
        help: "Run the OAuth flow after deploy at /api/auth/google",
        optional: true,
        sensitive: true,
      },
    ],
  },
  {
    id: "vault",
    name: "Obsidian Vault",
    tools: "Read, write, search, backlinks, web clipper (15 tools)",
    vars: [
      {
        key: "GITHUB_PAT",
        prompt: "GitHub PAT (with repo scope)",
        help: "https://github.com/settings/tokens",
        sensitive: true,
      },
      {
        key: "GITHUB_REPO",
        prompt: "GitHub repo",
        example: "owner/repo or https://github.com/owner/repo",
        transform: normalizeGitHubRepo,
      },
    ],
  },
  {
    id: "browser",
    name: "Browser Automation",
    tools: "Web browse, extract, act, LinkedIn feed (4 tools)",
    vars: [
      {
        key: "BROWSERBASE_API_KEY",
        prompt: "Browserbase API key",
        help: "https://browserbase.com",
        sensitive: true,
      },
      { key: "BROWSERBASE_PROJECT_ID", prompt: "Browserbase Project ID" },
      {
        key: "OPENROUTER_API_KEY",
        prompt: "OpenRouter API key",
        help: "https://openrouter.ai/keys",
        sensitive: true,
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    tools: "Channels, messages, threads, profiles, search (6 tools)",
    vars: [
      {
        key: "SLACK_BOT_TOKEN",
        prompt: "Slack Bot User OAuth Token",
        help: "https://api.slack.com/apps → OAuth & Permissions",
        sensitive: true,
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    tools: "Search, read, create, update, query databases (5 tools)",
    vars: [
      {
        key: "NOTION_API_KEY",
        prompt: "Notion Internal Integration Token",
        help: "https://www.notion.so/my-integrations",
        sensitive: true,
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    tools: "1000+ app integrations — Jira, HubSpot, Salesforce, Airtable... (2 tools)",
    vars: [
      {
        key: "COMPOSIO_API_KEY",
        prompt: "Composio API key",
        help: "https://composio.dev → Settings",
        sensitive: true,
      },
    ],
  },
];

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  log("");
  log(
    `${BOLD}  ╔══════════════════════════════════════════╗${RESET}`
  );
  log(
    `${BOLD}  ║          ${CYAN}create-mymcp${RESET}${BOLD}                    ║${RESET}`
  );
  log(
    `${BOLD}  ║  Your personal AI backend in minutes     ║${RESET}`
  );
  log(
    `${BOLD}  ╚══════════════════════════════════════════╝${RESET}`
  );

  // ── Step 1: Project directory ────────────────────────────────────

  step("1/5", "Project setup");

  const defaultDir = "mymcp";
  info(`Just type a folder name, or a full path. Default: ${defaultDir}`);
  const rawInput = (await ask(`  Project directory [${defaultDir}]: `)).trim();
  const cleaned = cleanPath(rawInput) || defaultDir;

  const projectDir = isAbsolute(cleaned) ? cleaned : resolve(cleaned);
  const projectName = projectDir.split(/[/\\]/).pop();

  if (existsSync(projectDir) && isDirNonEmpty(projectDir)) {
    log(`  ${RED}✗${RESET} Directory "${projectDir}" already exists and is not empty.`);
    rl.close();
    process.exit(1);
  }

  info(`Will create: ${projectDir}`);

  // ── Step 2: Clone ────────────────────────────────────────────────

  step("2/5", "Cloning MyMCP");

  if (!hasCommand("git")) {
    log(`  ${RED}✗${RESET} git is required. Install it from https://git-scm.com`);
    rl.close();
    process.exit(1);
  }

  const cloneResult = spawnSync(
    "git",
    ["clone", "https://github.com/Yassinello/mymcp.git", projectDir],
    { stdio: "inherit" }
  );

  if (cloneResult.status !== 0) {
    log(`  ${RED}✗${RESET} Failed to clone repository.`);
    rl.close();
    process.exit(1);
  }

  run(`git -C "${projectDir}" remote rename origin upstream`);
  ok("Cloned and upstream remote configured");
  info("Run `npm run update` to pull updates anytime");

  // ── Step 3: Pick packs ───────────────────────────────────────────

  step("3/5", "Choose your tool packs");
  info("Press Enter to accept the default (shown in uppercase).");
  log("");

  const selectedPacks = [];
  for (const pack of PACKS) {
    const defaultOn = pack.id === "vault" || pack.id === "google";
    const yes = await confirm(
      `${BOLD}${pack.name}${RESET} — ${pack.tools}?`,
      defaultOn
    );
    if (yes) selectedPacks.push(pack);
  }

  if (selectedPacks.length === 0) {
    warn("No packs selected. You can add them later in your .env file.");
  } else {
    ok(`Selected: ${selectedPacks.map((p) => p.name).join(", ")}`);
  }

  // ── Step 4: Collect credentials ──────────────────────────────────

  step("4/5", "Configure credentials");
  info("Paste just the value — not the KEY=value format.");
  info("Type 'skip' or press Enter on optional fields to skip.");

  const envVars = {};
  const mcpToken = randomBytes(32).toString("hex");
  envVars.MCP_AUTH_TOKEN = mcpToken;
  ok(`MCP_AUTH_TOKEN generated: ${maskSecret(mcpToken)}`);

  // Instance settings
  log("");
  const tzRaw = (await ask(`  Timezone (e.g. Europe/Paris, Tokyo, UTC) [UTC]: `)).trim() || "UTC";
  const tz = normalizeTimezone(tzRaw);
  if (tz !== tzRaw && tzRaw.toLowerCase() !== "utc") {
    info(`Normalized to: ${tz}`);
  }

  const localeRaw = (await ask(`  Locale (e.g. fr, en-US, de) [en-US]: `)).trim() || "en-US";
  const locale = normalizeLocale(localeRaw);
  if (locale !== localeRaw) {
    info(`Normalized to: ${locale}`);
  }

  const displayName = (await ask(`  Display name [User]: `)).trim() || "User";

  envVars.MYMCP_TIMEZONE = tz;
  envVars.MYMCP_LOCALE = locale;
  envVars.MYMCP_DISPLAY_NAME = displayName;

  // Pack credentials
  const packStatus = []; // Track for recap

  for (const pack of selectedPacks) {
    log("");
    log(`  ${BOLD}${pack.name}${RESET}`);
    let allSet = true;

    for (const v of pack.vars) {
      if (v.help) info(v.help);
      if (v.example) info(`Format: ${v.example}`);
      if (v.optional) info("(optional — press Enter to skip)");

      const rawValue = (await ask(`  ${v.prompt}: `)).trim();
      const cleaned = cleanCredential(rawValue, v.key);

      if (cleaned) {
        // Apply transform if defined (e.g., GitHub URL → owner/repo)
        const finalValue = v.transform ? v.transform(cleaned) : cleaned;
        envVars[v.key] = finalValue;

        if (v.sensitive) {
          ok(`${v.key} set (${maskSecret(finalValue)})`);
        } else {
          ok(`${v.key} = ${finalValue}`);
        }
      } else if (v.optional) {
        info(`${v.key} skipped`);
      } else {
        warn(`${v.key} skipped — ${pack.name} pack won't activate until set`);
        allSet = false;
      }
    }

    packStatus.push({ name: pack.name, active: allSet });
  }

  // ── Write .env ───────────────────────────────────────────────────

  const envPath = join(projectDir, ".env");
  const envExamplePath = join(projectDir, ".env.example");

  let envContent = "# MyMCP — Generated by create-mymcp\n";
  envContent += `# Created: ${new Date().toISOString().split("T")[0]}\n\n`;

  const writtenVars = new Set();

  if (existsSync(envExamplePath)) {
    const example = readFileSync(envExamplePath, "utf-8");
    const lines = example.split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && envVars[match[1]] !== undefined) {
        envContent += `${match[1]}=${envVars[match[1]]}\n`;
        writtenVars.add(match[1]);
      } else {
        envContent += line + "\n";
      }
    }
  }

  for (const [key, value] of Object.entries(envVars)) {
    if (!writtenVars.has(key)) {
      envContent += `${key}=${value}\n`;
    }
  }

  writeFileSync(envPath, envContent);
  ok(".env file created");

  // ── Step 5: Install & Deploy ─────────────────────────────────────

  step("5/5", "Install & deploy");

  log("");
  info("Installing dependencies...");
  const installResult = spawnSync("npm", ["install"], {
    cwd: projectDir,
    stdio: "inherit",
    shell: true,
  });

  if (installResult.status !== 0) {
    warn("npm install failed — you can run it manually later");
  } else {
    ok("Dependencies installed");
  }

  // Offer Vercel deploy
  log("");
  const deployVercel = await confirm(
    "Deploy to Vercel now? (requires Vercel CLI)",
    false
  );

  let deploySucceeded = false;

  if (deployVercel) {
    if (!hasCommand("vercel")) {
      info("Installing Vercel CLI...");
      spawnSync("npm", ["install", "-g", "vercel"], {
        stdio: "inherit",
        shell: true,
      });
    }

    // Slugify project name for Vercel
    const vercelName = slugify(projectName);
    if (vercelName !== projectName) {
      info(`Vercel project name: ${vercelName} (slugified from "${projectName}")`);
    }

    log("");
    info("Running vercel deploy...");
    const vercelResult = spawnSync("vercel", ["--yes", "--name", vercelName], {
      cwd: projectDir,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    });

    if (vercelResult.status === 0) {
      ok("Deployed to Vercel!");
      deploySucceeded = true;
      log("");
      warn("Don't forget to add your env vars in the Vercel dashboard:");
      info("Vercel → Project Settings → Environment Variables");
      info("Or run: vercel env add MCP_AUTH_TOKEN");
    } else {
      warn("Deploy failed — you can run `vercel` manually in your project dir");
    }
  }

  // ── Done ─────────────────────────────────────────────────────────

  log("");
  log(`${BOLD}  ╔══════════════════════════════════════════╗${RESET}`);
  log(`${BOLD}  ║           ${GREEN}Setup complete!${RESET}${BOLD}                 ║${RESET}`);
  log(`${BOLD}  ╚══════════════════════════════════════════╝${RESET}`);

  // Recap table
  log("");
  log(`  ${BOLD}Pack status:${RESET}`);
  for (const ps of packStatus) {
    const icon = ps.active ? `${GREEN}✓${RESET}` : `${YELLOW}○${RESET}`;
    const status = ps.active ? "ready" : "needs credentials";
    log(`    ${icon} ${ps.name} — ${status}`);
  }

  // Packs not selected
  const selectedIds = new Set(selectedPacks.map((p) => p.id));
  const skippedPacks = PACKS.filter((p) => !selectedIds.has(p.id));
  for (const sp of skippedPacks) {
    log(`    ${DIM}– ${sp.name} — not selected${RESET}`);
  }

  log("");
  log(`  ${BOLD}Next steps:${RESET}`);
  log("");
  log(`  ${CYAN}cd ${projectName}${RESET}`);
  if (!deploySucceeded) {
    log(`  ${CYAN}npm run dev${RESET}              ${DIM}# Start locally at http://localhost:3000${RESET}`);
    log(`  ${CYAN}vercel${RESET}                   ${DIM}# Deploy to Vercel when ready${RESET}`);
  }
  log(`  ${DIM}Then visit: http://localhost:3000/setup${RESET}`);
  log("");
  log(`  ${BOLD}Connect to Claude Desktop / Claude Code:${RESET}`);
  log(`  ${DIM}Endpoint: https://your-app.vercel.app/api/mcp${RESET}`);
  log(`  ${DIM}Token:    ${maskSecret(mcpToken)}${RESET}`);
  log("");
  log(`  ${BOLD}Stay up to date:${RESET}`);
  log(`  ${CYAN}npm run update${RESET}`);
  log("");

  rl.close();
}

main().catch((err) => {
  console.error(`\n${RED}Error:${RESET} ${err.message}`);
  rl.close();
  process.exit(1);
});
