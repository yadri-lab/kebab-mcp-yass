"use client";

import { useState, useCallback } from "react";

// ── Types ───────────────────────────────────────────────────────────

interface PackVar {
  key: string;
  label: string;
  help?: string;
  helpUrl?: string;
  placeholder?: string;
  sensitive?: boolean;
  optional?: boolean;
}

interface PackDef {
  id: string;
  name: string;
  description: string;
  toolCount: number;
  icon: string;
  setupGuide: string[];
  vars: PackVar[];
}

// ── Pack definitions ────────────────────────────────────────────────

const PACKS: PackDef[] = [
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail, Calendar, Contacts, Drive",
    toolCount: 18,
    icon: "G",
    setupGuide: [
      "Go to Google Cloud Console \u2192 APIs & Credentials",
      "Create an OAuth 2.0 Client (Web application type)",
      "Add your callback URL in Authorized redirect URIs",
      "Copy the Client ID and Client Secret below",
    ],
    vars: [
      {
        key: "GOOGLE_CLIENT_ID",
        label: "OAuth Client ID",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        placeholder: "123456789-abc.apps.googleusercontent.com",
      },
      {
        key: "GOOGLE_CLIENT_SECRET",
        label: "OAuth Client Secret",
        placeholder: "GOCSPX-...",
        sensitive: true,
      },
      {
        key: "GOOGLE_REFRESH_TOKEN",
        label: "OAuth Refresh Token",
        help: "You can generate this after deploy via the /api/auth/google flow.",
        placeholder: "1//...",
        sensitive: true,
        optional: true,
      },
    ],
  },
  {
    id: "vault",
    name: "Obsidian Vault",
    description: "Read, write, search, backlinks, web clipper",
    toolCount: 15,
    icon: "V",
    setupGuide: [
      "Push your Obsidian vault to a GitHub repository",
      "Generate a Personal Access Token with 'repo' scope",
      "Enter the repo in owner/repo format (or paste the GitHub URL)",
    ],
    vars: [
      {
        key: "GITHUB_PAT",
        label: "GitHub Personal Access Token",
        helpUrl: "https://github.com/settings/tokens",
        help: "Needs 'repo' scope to read/write vault files.",
        placeholder: "ghp_...",
        sensitive: true,
      },
      {
        key: "GITHUB_REPO",
        label: "GitHub Repository",
        help: "You can paste the full URL \u2014 it will be converted automatically.",
        placeholder: "yourname/your-vault",
      },
    ],
  },
  {
    id: "browser",
    name: "Browser Automation",
    description: "Web browse, extract, act, LinkedIn feed",
    toolCount: 4,
    icon: "B",
    setupGuide: [
      "Create a Browserbase account for cloud browser sessions",
      "Create an OpenRouter account for AI-powered extraction",
      "Copy your API keys and project ID below",
    ],
    vars: [
      {
        key: "BROWSERBASE_API_KEY",
        label: "Browserbase API Key",
        helpUrl: "https://browserbase.com",
        placeholder: "bb_live_...",
        sensitive: true,
      },
      {
        key: "BROWSERBASE_PROJECT_ID",
        label: "Browserbase Project ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        helpUrl: "https://openrouter.ai/keys",
        placeholder: "sk-or-v1-...",
        sensitive: true,
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, messages, threads, profiles, search",
    toolCount: 6,
    icon: "S",
    setupGuide: [
      "Create a Slack App at api.slack.com/apps",
      "Add Bot Token Scopes: channels:history, channels:read, chat:write, search:read",
      "Install the app to your workspace",
      "Copy the Bot User OAuth Token below",
    ],
    vars: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot User OAuth Token",
        helpUrl: "https://api.slack.com/apps",
        help: "Starts with xoxb-",
        placeholder: "xoxb-...",
        sensitive: true,
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read, create, update, query databases",
    toolCount: 5,
    icon: "N",
    setupGuide: [
      "Create an Internal Integration at notion.so/my-integrations",
      "Share your target pages/databases with the integration",
      "Copy the Internal Integration Token below",
    ],
    vars: [
      {
        key: "NOTION_API_KEY",
        label: "Internal Integration Token",
        helpUrl: "https://www.notion.so/my-integrations",
        help: "Starts with ntn_ or secret_",
        placeholder: "ntn_...",
        sensitive: true,
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    description: "1000+ app integrations (Jira, HubSpot, Salesforce...)",
    toolCount: 2,
    icon: "C",
    setupGuide: [
      "Create a Composio account at composio.dev",
      "Go to Settings to find your API key",
      "Connect your apps in the Composio dashboard",
    ],
    vars: [
      {
        key: "COMPOSIO_API_KEY",
        label: "API Key",
        helpUrl: "https://composio.dev",
        placeholder: "ck_...",
        sensitive: true,
      },
    ],
  },
];

const STEPS = [
  { label: "Tools", description: "Choose packs & enter credentials" },
  { label: "Settings", description: "Personalize your instance" },
  { label: "Save", description: "Finish setup" },
];

// ── Helpers ─────────────────────────────────────────────────────────

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeGitHubRepo(value: string): string {
  const cleaned = value.trim().replace(/\/+$/, "");
  const match = cleaned.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1] : cleaned;
}

function cleanCredential(value: string): string {
  return value.trim().replace(/^[A-Z_]+=/, "");
}

// ── Small components ────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="relative group/tip inline-flex items-center">
      {children}
      <span className="invisible group-hover/tip:visible absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-1.5 rounded-md bg-text text-bg text-xs whitespace-nowrap z-50 shadow-lg max-w-64 text-center">
        {text}
        <span className="absolute left-1/2 -translate-x-1/2 top-full w-2 h-2 rotate-45 bg-text -mt-1" />
      </span>
    </span>
  );
}

function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-muted"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4m0-4h.01" />
    </svg>
  );
}

function ExtIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline ml-1 opacity-50"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// ── Main Component ──────────────────────────────────────────────────

export function SetupWizard({ firstTime, isVercel }: { firstTime: boolean; isVercel: boolean }) {
  const [step, setStep] = useState(0);
  const [selectedPacks, setSelectedPacks] = useState<Set<string>>(new Set(["google", "vault"]));
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState({
    timezone: "Europe/Paris",
    locale: "fr-FR",
    displayName: "",
  });
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string; detail?: string }>
  >({});
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const mcpToken = useState(() => generateToken())[0];

  const togglePack = useCallback((id: string) => {
    setSelectedPacks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateCredential = useCallback((key: string, rawValue: string) => {
    setCredentials((prev) => ({ ...prev, [key]: cleanCredential(rawValue) }));
  }, []);

  const testPack = useCallback(
    async (packId: string) => {
      setTestResults((prev) => ({ ...prev, [packId]: { ok: false, message: "Testing..." } }));
      setExpandedError(null);
      try {
        const res = await fetch("/api/setup/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pack: packId, credentials }),
        });
        const data = await res.json();
        setTestResults((prev) => ({ ...prev, [packId]: data }));
      } catch {
        setTestResults((prev) => ({
          ...prev,
          [packId]: {
            ok: false,
            message: "Connection failed",
            detail: "Network error — is the dev server running?",
          },
        }));
      }
    },
    [credentials]
  );

  const buildEnvVars = useCallback(() => {
    const env: Record<string, string> = {
      MCP_AUTH_TOKEN: mcpToken,
      MYMCP_TIMEZONE: settings.timezone,
      MYMCP_LOCALE: settings.locale,
      MYMCP_DISPLAY_NAME: settings.displayName || "User",
    };
    for (const pack of PACKS) {
      if (!selectedPacks.has(pack.id)) continue;
      for (const v of pack.vars) {
        const val = credentials[v.key];
        if (val) env[v.key] = v.key === "GITHUB_REPO" ? normalizeGitHubRepo(val) : val;
      }
    }
    return env;
  }, [mcpToken, settings, selectedPacks, credentials]);

  const saveEnv = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/setup/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envVars: buildEnvVars() }),
      });
      const data = await res.json();
      if (data.ok) setSaved(true);
      else alert(data.error || "Save failed");
    } catch {
      alert("Failed to save .env file");
    }
    setSaving(false);
  }, [buildEnvVars]);

  const copyEnv = useCallback(() => {
    const env = buildEnvVars();
    navigator.clipboard.writeText(
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [buildEnvVars]);

  const activePacks = PACKS.filter((p) => selectedPacks.has(p.id));
  const totalTools = activePacks.reduce((sum, p) => sum + p.toolCount, 0);
  const isPackReady = (pack: PackDef) =>
    pack.vars.filter((v) => !v.optional).every((v) => credentials[v.key]);

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <p className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-2">
            {firstTime ? "First-time setup" : "Configuration"}
          </p>
          <h1 className="text-2xl font-bold tracking-tight">MyMCP Setup</h1>
          <p className="text-text-dim mt-1.5 text-sm">
            {firstTime
              ? "Welcome! Configure your personal MCP server step by step."
              : "Update your server configuration."}
          </p>
        </div>

        {/* Step indicator — 3 steps now */}
        <div className="flex items-center justify-between mb-10 px-8">
          {STEPS.map((s, i) => (
            <div key={s.label} className="flex items-center gap-0 flex-1">
              <button
                onClick={() => i <= step + 1 && setStep(i)}
                className={`flex flex-col items-center gap-1 transition-all ${i <= step + 1 ? "cursor-pointer" : "cursor-default"}`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${i === step ? "bg-accent text-white" : i < step ? "bg-green text-white" : "bg-bg-muted text-text-muted"}`}
                >
                  {i < step ? "\u2713" : i + 1}
                </div>
                <span
                  className={`text-[10px] font-medium ${i === step ? "text-accent" : i < step ? "text-green" : "text-text-muted"}`}
                >
                  {s.label}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-px mx-3 mt-[-12px] ${i < step ? "bg-green" : "bg-border"}`}
                />
              )}
            </div>
          ))}
        </div>

        {/* ─── Step 0: Packs + Credentials (merged) ─────────────── */}
        {step === 0 && (
          <div>
            <div className="mb-6">
              <h2 className="font-semibold text-lg">Choose your tools</h2>
              <p className="text-sm text-text-dim mt-1">
                Toggle packs on, then enter the credentials for each. If you paste a{" "}
                <code className="bg-bg-muted px-1 py-0.5 rounded text-xs">KEY=value</code> line, the
                prefix is stripped automatically.
              </p>
            </div>

            {/* Summary bar */}
            <div className="flex items-center gap-3 mb-5 p-3 bg-bg-muted rounded-lg text-sm">
              <span className="font-semibold text-accent">{activePacks.length}</span>
              <span className="text-text-dim">packs</span>
              <span className="text-text-muted">&middot;</span>
              <span className="font-semibold text-accent">{totalTools}</span>
              <span className="text-text-dim">tools</span>
            </div>

            <div className="space-y-3">
              {PACKS.map((pack) => {
                const selected = selectedPacks.has(pack.id);
                const ready = isPackReady(pack);
                const test = testResults[pack.id];
                const guideOpen = expandedGuide === pack.id;
                const errorOpen = expandedError === pack.id;

                return (
                  <div
                    key={pack.id}
                    className={`border rounded-lg overflow-hidden transition-all ${selected ? "border-accent" : "border-border"}`}
                  >
                    {/* Pack header — always visible, toggles the pack */}
                    <button
                      onClick={() => togglePack(pack.id)}
                      className={`w-full text-left flex items-center justify-between px-5 py-4 transition-colors ${selected ? "bg-accent/5" : "hover:bg-bg-muted"}`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm ${selected ? "bg-accent text-white" : "bg-bg-muted text-text-muted border border-border-light"}`}
                        >
                          {pack.icon}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-sm">{pack.name}</p>
                            <span
                              className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${selected ? "text-accent bg-accent/10" : "text-text-muted bg-bg-muted"}`}
                            >
                              {pack.toolCount} tools
                            </span>
                            {selected && test && (
                              <span
                                className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${test.message === "Testing..." ? "text-accent bg-accent/10" : test.ok ? "text-green bg-green-bg" : "text-red bg-red-bg"}`}
                              >
                                {test.message}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-text-dim mt-0.5">{pack.description}</p>
                        </div>
                      </div>
                      <div
                        className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${selected ? "bg-accent" : "bg-bg-muted border border-border"}`}
                      >
                        <div
                          className={`w-4 h-4 rounded-full bg-white shadow-sm absolute top-1 transition-all ${selected ? "left-6" : "left-1"}`}
                        />
                      </div>
                    </button>

                    {/* Credentials — shown when pack is selected */}
                    {selected && (
                      <div className="px-5 py-4 border-t border-border bg-bg">
                        {/* Setup guide */}
                        <button
                          onClick={() => setExpandedGuide(guideOpen ? null : pack.id)}
                          className="flex items-center gap-1.5 text-xs text-accent hover:underline mb-4"
                        >
                          <ChevronIcon open={guideOpen} />
                          How to get these credentials
                        </button>

                        {guideOpen && (
                          <div className="bg-bg-muted rounded-md p-4 mb-4 text-sm text-text-dim space-y-2">
                            {pack.setupGuide.map((line, i) => (
                              <div key={i} className="flex gap-2">
                                <span className="text-accent font-semibold shrink-0">{i + 1}.</span>
                                <span>{line}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Credential fields */}
                        <div className="space-y-4">
                          {pack.vars.map((v) => (
                            <div key={v.key}>
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <label className="text-sm font-medium">{v.label}</label>
                                {v.optional && (
                                  <span className="text-[11px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded">
                                    optional
                                  </span>
                                )}
                                {v.help && (
                                  <Tooltip text={v.help}>
                                    <InfoIcon />
                                  </Tooltip>
                                )}
                              </div>
                              {v.helpUrl && (
                                <a
                                  href={v.helpUrl}
                                  target="_blank"
                                  rel="noopener"
                                  className="text-xs text-accent hover:underline mb-1.5 inline-block"
                                >
                                  Get it here <ExtIcon />
                                </a>
                              )}
                              <input
                                type={v.sensitive ? "password" : "text"}
                                placeholder={v.placeholder || v.key}
                                value={credentials[v.key] || ""}
                                onChange={(e) => updateCredential(v.key, e.target.value)}
                                className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                              />
                            </div>
                          ))}
                        </div>

                        {/* Test button + error detail */}
                        <div className="mt-4 flex items-center gap-3">
                          <button
                            onClick={() => testPack(pack.id)}
                            disabled={!ready}
                            className={`text-sm font-medium px-4 py-1.5 rounded-md transition-colors ${ready ? "bg-bg-muted text-text-dim hover:bg-border-light hover:text-text" : "bg-bg-muted text-text-muted cursor-not-allowed"}`}
                          >
                            Test connection
                          </button>
                          {test && !test.ok && test.detail && (
                            <button
                              onClick={() => setExpandedError(errorOpen ? null : pack.id)}
                              className="text-xs text-text-muted hover:text-text"
                            >
                              {errorOpen ? "Hide details" : "Show error details"}
                            </button>
                          )}
                        </div>

                        {errorOpen && test && !test.ok && test.detail && (
                          <div className="mt-3 bg-red-bg border border-red/10 rounded-md p-3 text-xs font-mono text-red">
                            {test.detail}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-8 flex justify-between items-center">
              <p className="text-xs text-text-muted">Admin pack (logs) is always active.</p>
              <button
                onClick={() => setStep(1)}
                className="bg-accent text-white px-6 py-2.5 rounded-md text-sm font-medium hover:bg-accent/90 transition-colors"
              >
                Next &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 1: Settings ────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <div className="mb-6">
              <h2 className="font-semibold text-lg">Personalize your instance</h2>
              <p className="text-sm text-text-dim mt-1">
                These settings customize how your MCP server formats dates and identifies itself.
                All can be changed later in{" "}
                <code className="bg-bg-muted px-1 py-0.5 rounded text-xs">.env</code>.
              </p>
            </div>

            <div className="border border-border rounded-lg p-5 space-y-5">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Display Name</label>
                <input
                  type="text"
                  placeholder="Your name (shown in dashboard)"
                  value={settings.displayName}
                  onChange={(e) => setSettings((s) => ({ ...s, displayName: e.target.value }))}
                  className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <label className="text-sm font-medium">Timezone</label>
                    <Tooltip text="Used for formatting dates in tool responses. IANA format.">
                      <InfoIcon />
                    </Tooltip>
                  </div>
                  <input
                    type="text"
                    placeholder="Europe/Paris"
                    value={settings.timezone}
                    onChange={(e) => setSettings((s) => ({ ...s, timezone: e.target.value }))}
                    className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-text-muted mt-1">
                    Europe/Paris, America/New_York, Asia/Tokyo...
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <label className="text-sm font-medium">Locale</label>
                    <Tooltip text="Used for formatting numbers and currencies.">
                      <InfoIcon />
                    </Tooltip>
                  </div>
                  <input
                    type="text"
                    placeholder="fr-FR"
                    value={settings.locale}
                    onChange={(e) => setSettings((s) => ({ ...s, locale: e.target.value }))}
                    className="w-full bg-bg-muted border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-text-muted mt-1">fr-FR, en-US, de-DE...</p>
                </div>
              </div>
            </div>

            {/* Auth Token */}
            <div className="border border-border rounded-lg p-5 mt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium">Auth Token</p>
                  <Tooltip text="Secures your MCP endpoint. Use it to connect Claude, ChatGPT, or any MCP client.">
                    <InfoIcon />
                  </Tooltip>
                </div>
                <button
                  onClick={() => setShowToken(!showToken)}
                  className="text-xs text-accent hover:underline"
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
              <p className="text-xs text-text-muted mb-2">
                Auto-generated. You&rsquo;ll need this to connect your AI clients.
              </p>
              <code className="text-xs font-mono bg-bg-muted px-3 py-2 rounded-md border border-border block overflow-x-auto select-all">
                {showToken
                  ? mcpToken
                  : `${mcpToken.slice(0, 8)}${"•".repeat(24)}${mcpToken.slice(-4)}`}
              </code>
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(0)}
                className="text-text-dim hover:text-text text-sm px-4 py-2.5"
              >
                &larr; Tools
              </button>
              <button
                onClick={() => setStep(2)}
                className="bg-accent text-white px-6 py-2.5 rounded-md text-sm font-medium hover:bg-accent/90 transition-colors"
              >
                Next &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 2: Save ────────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <div className="mb-6">
              <h2 className="font-semibold text-lg">Save & Deploy</h2>
              <p className="text-sm text-text-dim mt-1">
                {isVercel
                  ? "Copy your environment variables and add them in the Vercel dashboard."
                  : "Save your .env file, then restart the dev server to apply."}
              </p>
            </div>

            {/* Summary */}
            <div className="border border-border rounded-lg p-5 mb-6">
              <p className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
                Configuration Summary
              </p>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-text-muted mb-1.5">Packs</p>
                  <div className="flex flex-wrap gap-1.5">
                    {activePacks.map((p) => (
                      <span
                        key={p.id}
                        className="text-[11px] font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-full"
                      >
                        {p.name} ({p.toolCount})
                      </span>
                    ))}
                    {activePacks.length === 0 && (
                      <span className="text-[11px] text-text-muted">None selected</span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4 pt-2 border-t border-border">
                  <div>
                    <p className="text-xs text-text-muted">Display Name</p>
                    <p className="text-sm font-medium">{settings.displayName || "User"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-text-muted">Timezone</p>
                    <p className="text-sm font-mono">{settings.timezone}</p>
                  </div>
                  <div>
                    <p className="text-xs text-text-muted">Locale</p>
                    <p className="text-sm font-mono">{settings.locale}</p>
                  </div>
                </div>
                <div className="pt-2 border-t border-border">
                  <p className="text-xs text-text-muted mb-1.5">Pack status</p>
                  <div className="space-y-1">
                    {activePacks.map((p) => {
                      const ready = isPackReady(p);
                      const test = testResults[p.id];
                      const tested = test && test.ok;
                      return (
                        <div key={p.id} className="flex items-center gap-2 text-sm">
                          <div
                            className={`w-1.5 h-1.5 rounded-full ${tested ? "bg-green" : ready ? "bg-accent" : "bg-orange"}`}
                          />
                          <span className="text-text-dim">{p.name}</span>
                          <span
                            className={`text-xs ${tested ? "text-green" : ready ? "text-accent" : "text-orange"}`}
                          >
                            {tested
                              ? "verified"
                              : ready
                                ? "credentials set"
                                : "missing credentials"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-3">
              {!isVercel && (
                <button
                  onClick={saveEnv}
                  disabled={saving || saved}
                  className={`w-full py-3 rounded-lg text-sm font-medium transition-colors ${saved ? "bg-green-bg text-green border border-green/20" : "bg-accent text-white hover:bg-accent/90"} disabled:opacity-60`}
                >
                  {saved
                    ? "\u2713 .env saved successfully"
                    : saving
                      ? "Saving..."
                      : "Save .env file"}
                </button>
              )}
              <button
                onClick={copyEnv}
                className={`w-full py-3 rounded-lg text-sm font-medium border transition-colors ${copied ? "border-green/20 bg-green-bg text-green" : "border-border hover:bg-bg-muted text-text-dim"}`}
              >
                {copied ? "\u2713 Copied to clipboard!" : "Copy env vars to clipboard"}
              </button>
            </div>

            {/* Next steps */}
            {saved && (
              <div className="mt-6 border border-border rounded-lg p-5">
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
                  Next Steps
                </p>
                <div className="space-y-3 text-sm">
                  <div className="flex gap-3">
                    <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold shrink-0">
                      1
                    </span>
                    <div>
                      <p className="font-medium">Restart the dev server</p>
                      <code className="text-xs font-mono bg-bg-muted px-2 py-1 rounded mt-1 inline-block">
                        npm run dev
                      </code>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold shrink-0">
                      2
                    </span>
                    <div>
                      <p className="font-medium">Connect your AI client</p>
                      <div className="mt-1 bg-bg-muted rounded-md p-3 text-xs font-mono text-text-dim space-y-1">
                        <p>
                          Endpoint: <span className="text-text">http://localhost:3000/api/mcp</span>
                        </p>
                        <p>
                          Token:{" "}
                          <span className="text-text select-all">{mcpToken.slice(0, 16)}...</span>
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold shrink-0">
                      3
                    </span>
                    <div>
                      <p className="font-medium">Deploy to Vercel when ready</p>
                      <code className="text-xs font-mono bg-bg-muted px-2 py-1 rounded mt-1 inline-block">
                        vercel
                      </code>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-8 flex justify-start">
              <button
                onClick={() => setStep(1)}
                className="text-text-dim hover:text-text text-sm px-4 py-2.5"
              >
                &larr; Settings
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
