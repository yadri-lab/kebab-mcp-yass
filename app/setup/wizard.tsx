"use client";

import { useState, useCallback } from "react";

// ── Pack definitions (mirrors CLI) ──────────────────────────────────

interface PackVar {
  key: string;
  label: string;
  help?: string;
  example?: string;
  sensitive?: boolean;
  optional?: boolean;
}

interface PackDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  vars: PackVar[];
}

const PACKS: PackDef[] = [
  {
    id: "google",
    name: "Google Workspace",
    description: "Gmail, Calendar, Contacts, Drive — 18 tools",
    icon: "G",
    vars: [
      {
        key: "GOOGLE_CLIENT_ID",
        label: "OAuth Client ID",
        help: "https://console.cloud.google.com/apis/credentials",
      },
      {
        key: "GOOGLE_CLIENT_SECRET",
        label: "OAuth Client Secret",
        sensitive: true,
      },
      {
        key: "GOOGLE_REFRESH_TOKEN",
        label: "OAuth Refresh Token",
        help: "You can get this after deploy via /api/auth/google",
        sensitive: true,
        optional: true,
      },
    ],
  },
  {
    id: "vault",
    name: "Obsidian Vault",
    description: "Read, write, search, backlinks — 15 tools",
    icon: "V",
    vars: [
      {
        key: "GITHUB_PAT",
        label: "GitHub Personal Access Token",
        help: "https://github.com/settings/tokens — needs 'repo' scope",
        sensitive: true,
      },
      {
        key: "GITHUB_REPO",
        label: "GitHub Repository",
        example: "owner/repo",
      },
    ],
  },
  {
    id: "browser",
    name: "Browser Automation",
    description: "Web browse, extract, act, LinkedIn — 4 tools",
    icon: "B",
    vars: [
      {
        key: "BROWSERBASE_API_KEY",
        label: "Browserbase API Key",
        help: "https://browserbase.com",
        sensitive: true,
      },
      {
        key: "BROWSERBASE_PROJECT_ID",
        label: "Browserbase Project ID",
      },
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        help: "https://openrouter.ai/keys",
        sensitive: true,
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, messages, threads, profiles — 6 tools",
    icon: "S",
    vars: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot User OAuth Token",
        help: "https://api.slack.com/apps → OAuth & Permissions",
        sensitive: true,
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read, create, update, query — 5 tools",
    icon: "N",
    vars: [
      {
        key: "NOTION_API_KEY",
        label: "Internal Integration Token",
        help: "https://www.notion.so/my-integrations",
        sensitive: true,
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    description: "1000+ app integrations — 2 tools",
    icon: "C",
    vars: [
      {
        key: "COMPOSIO_API_KEY",
        label: "API Key",
        help: "https://composio.dev → Settings",
        sensitive: true,
      },
    ],
  },
];

const STEPS = ["Packs", "Credentials", "Settings", "Save"];

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
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {}
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const mcpToken = useState(() => generateToken())[0];

  const togglePack = useCallback((id: string) => {
    setSelectedPacks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setCredential = useCallback((key: string, rawValue: string) => {
    const value = cleanCredential(rawValue);
    setCredentials((prev) => ({ ...prev, [key]: value }));
  }, []);

  const testPack = useCallback(
    async (packId: string) => {
      setTestResults((prev) => ({
        ...prev,
        [packId]: { ok: false, message: "Testing..." },
      }));

      try {
        const res = await fetch("/api/setup/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pack: packId,
            credentials,
          }),
        });
        const data = await res.json();
        setTestResults((prev) => ({ ...prev, [packId]: data }));
      } catch {
        setTestResults((prev) => ({
          ...prev,
          [packId]: { ok: false, message: "Test failed" },
        }));
      }
    },
    [credentials]
  );

  // Build the full env vars object
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
        if (val) {
          env[v.key] = v.key === "GITHUB_REPO" ? normalizeGitHubRepo(val) : val;
        }
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
    const text = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [buildEnvVars]);

  const activePacks = PACKS.filter((p) => selectedPacks.has(p.id));

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold tracking-tight">MyMCP Setup</h1>
          <p className="text-text-dim mt-2">
            {firstTime
              ? "Configure your personal MCP server in a few steps."
              : "Update your server configuration."}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <button
                onClick={() => setStep(i)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                  i === step
                    ? "bg-accent text-white"
                    : i < step
                      ? "bg-green/10 text-green"
                      : "bg-bg-muted text-text-muted"
                }`}
              >
                {i < step ? "✓" : i + 1} {label}
              </button>
              {i < STEPS.length - 1 && <div className="w-6 h-px bg-border" />}
            </div>
          ))}
        </div>

        {/* Step 0: Pack Selection */}
        {step === 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-1">Choose your tool packs</h2>
            <p className="text-sm text-text-dim mb-6">
              Toggle the packs you want to activate. You can always change this later.
            </p>
            <div className="space-y-3">
              {PACKS.map((pack) => {
                const selected = selectedPacks.has(pack.id);
                return (
                  <button
                    key={pack.id}
                    onClick={() => togglePack(pack.id)}
                    className={`w-full text-left border rounded-lg p-4 transition-all ${
                      selected
                        ? "border-accent bg-accent/5"
                        : "border-border hover:border-text-muted"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm ${
                            selected ? "bg-accent text-white" : "bg-bg-muted text-text-muted"
                          }`}
                        >
                          {pack.icon}
                        </div>
                        <div>
                          <p className="font-medium">{pack.name}</p>
                          <p className="text-sm text-text-dim">{pack.description}</p>
                        </div>
                      </div>
                      <div
                        className={`w-10 h-6 rounded-full transition-colors relative ${
                          selected ? "bg-accent" : "bg-bg-muted"
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded-full bg-white shadow absolute top-1 transition-all ${
                            selected ? "left-5" : "left-1"
                          }`}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-8 flex justify-end">
              <button
                onClick={() => setStep(1)}
                className="bg-accent text-white px-6 py-2.5 rounded-lg font-medium hover:bg-accent/90 transition-colors"
              >
                Next: Credentials →
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Credentials */}
        {step === 1 && (
          <div>
            <h2 className="text-lg font-semibold mb-1">Enter your credentials</h2>
            <p className="text-sm text-text-dim mb-6">
              Paste just the value — the KEY= prefix is stripped automatically. Optional fields can
              be left empty.
            </p>

            {activePacks.length === 0 ? (
              <p className="text-text-dim text-center py-8">
                No packs selected. Go back to select at least one.
              </p>
            ) : (
              <div className="space-y-8">
                {activePacks.map((pack) => (
                  <div key={pack.id} className="border border-border rounded-lg p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold flex items-center gap-2">
                        <span className="w-7 h-7 rounded bg-accent text-white flex items-center justify-center text-xs font-bold">
                          {pack.icon}
                        </span>
                        {pack.name}
                      </h3>
                      {testResults[pack.id] && (
                        <span
                          className={`text-xs font-medium px-2 py-1 rounded-full ${
                            testResults[pack.id].ok
                              ? "text-green bg-green-bg"
                              : "text-red bg-red-bg"
                          }`}
                        >
                          {testResults[pack.id].message}
                        </span>
                      )}
                    </div>
                    <div className="space-y-4">
                      {pack.vars.map((v) => (
                        <div key={v.key}>
                          <label className="block text-sm font-medium mb-1">
                            {v.label}
                            {v.optional && (
                              <span className="text-text-muted font-normal ml-1">(optional)</span>
                            )}
                          </label>
                          {v.help && (
                            <a
                              href={v.help.startsWith("http") ? v.help : undefined}
                              target="_blank"
                              rel="noopener"
                              className="text-xs text-accent hover:underline mb-1 block"
                            >
                              {v.help}
                            </a>
                          )}
                          <input
                            type={v.sensitive ? "password" : "text"}
                            placeholder={v.example || v.key}
                            value={credentials[v.key] || ""}
                            onChange={(e) => setCredential(v.key, e.target.value)}
                            className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent font-mono"
                          />
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => testPack(pack.id)}
                      className="mt-4 text-sm text-accent hover:underline font-medium"
                    >
                      Test connection
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(0)}
                className="text-text-dim hover:text-text px-4 py-2.5 text-sm"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(2)}
                className="bg-accent text-white px-6 py-2.5 rounded-lg font-medium hover:bg-accent/90 transition-colors"
              >
                Next: Settings →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Instance Settings */}
        {step === 2 && (
          <div>
            <h2 className="text-lg font-semibold mb-1">Instance settings</h2>
            <p className="text-sm text-text-dim mb-6">
              These personalize your MCP server. All are optional.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Display Name</label>
                <input
                  type="text"
                  placeholder="Your name"
                  value={settings.displayName}
                  onChange={(e) => setSettings((s) => ({ ...s, displayName: e.target.value }))}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Timezone</label>
                  <input
                    type="text"
                    placeholder="Europe/Paris"
                    value={settings.timezone}
                    onChange={(e) => setSettings((s) => ({ ...s, timezone: e.target.value }))}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-text-muted mt-1">
                    IANA format: Europe/Paris, America/New_York, Asia/Tokyo
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Locale</label>
                  <input
                    type="text"
                    placeholder="fr-FR"
                    value={settings.locale}
                    onChange={(e) => setSettings((s) => ({ ...s, locale: e.target.value }))}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                  <p className="text-xs text-text-muted mt-1">Examples: fr-FR, en-US, de-DE</p>
                </div>
              </div>

              <div className="mt-4 p-4 bg-bg-muted rounded-lg">
                <p className="text-sm font-medium mb-1">Auth Token</p>
                <p className="text-xs text-text-dim mb-2">
                  Auto-generated. Use this to connect your AI clients.
                </p>
                <code className="text-xs font-mono bg-bg px-2 py-1 rounded border border-border select-all block overflow-x-auto">
                  {mcpToken}
                </code>
              </div>
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="text-text-dim hover:text-text px-4 py-2.5 text-sm"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(3)}
                className="bg-accent text-white px-6 py-2.5 rounded-lg font-medium hover:bg-accent/90 transition-colors"
              >
                Next: Save →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Save */}
        {step === 3 && (
          <div>
            <h2 className="text-lg font-semibold mb-1">Save & Deploy</h2>
            <p className="text-sm text-text-dim mb-6">
              {isVercel
                ? "Copy your environment variables and paste them in the Vercel dashboard."
                : "Save your configuration and restart the dev server."}
            </p>

            {/* Recap */}
            <div className="border border-border rounded-lg p-5 mb-6">
              <h3 className="font-medium mb-3">Configuration summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-dim">Packs</span>
                  <span className="font-medium">
                    {activePacks.map((p) => p.name).join(", ") || "None"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-dim">Timezone</span>
                  <span className="font-mono">{settings.timezone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-dim">Locale</span>
                  <span className="font-mono">{settings.locale}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-dim">Display Name</span>
                  <span>{settings.displayName || "User"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-dim">Auth Token</span>
                  <span className="font-mono text-xs">
                    {mcpToken.slice(0, 8)}...{mcpToken.slice(-4)}
                  </span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-3">
              {!isVercel && (
                <button
                  onClick={saveEnv}
                  disabled={saving || saved}
                  className={`w-full py-3 rounded-lg font-medium text-sm transition-colors ${
                    saved
                      ? "bg-green/10 text-green border border-green/20"
                      : "bg-accent text-white hover:bg-accent/90"
                  } disabled:opacity-50`}
                >
                  {saved
                    ? "✓ .env saved — restart dev server to apply"
                    : saving
                      ? "Saving..."
                      : "Save .env file"}
                </button>
              )}

              <button
                onClick={copyEnv}
                className="w-full py-3 rounded-lg font-medium text-sm border border-border hover:bg-bg-muted transition-colors"
              >
                {copied ? "✓ Copied!" : "Copy all env vars to clipboard"}
              </button>
            </div>

            {/* Connection instructions */}
            {saved && (
              <div className="mt-8 p-5 bg-bg-muted rounded-lg">
                <h3 className="font-medium mb-3">Next steps</h3>
                <ol className="text-sm text-text-dim space-y-2 list-decimal pl-4">
                  <li>
                    Restart the dev server:{" "}
                    <code className="bg-bg px-1.5 py-0.5 rounded text-xs font-mono">
                      npm run dev
                    </code>
                  </li>
                  <li>Visit the dashboard to verify everything works</li>
                  <li>
                    Connect your AI client with:
                    <br />
                    <code className="bg-bg px-1.5 py-0.5 rounded text-xs font-mono mt-1 block">
                      Endpoint: http://localhost:3000/api/mcp
                    </code>
                    <code className="bg-bg px-1.5 py-0.5 rounded text-xs font-mono mt-1 block">
                      Token: {mcpToken.slice(0, 12)}...
                    </code>
                  </li>
                  <li>
                    When ready, deploy:{" "}
                    <code className="bg-bg px-1.5 py-0.5 rounded text-xs font-mono">vercel</code>
                  </li>
                </ol>
              </div>
            )}

            <div className="mt-8 flex justify-start">
              <button
                onClick={() => setStep(2)}
                className="text-text-dim hover:text-text px-4 py-2.5 text-sm"
              >
                ← Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
