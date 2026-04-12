"use client";

import { useState, useCallback, useEffect } from "react";

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
  { label: "Tools", description: "Pick packs & credentials" },
  { label: "Settings", description: "Personalize" },
  { label: "Save", description: "Finalize" },
];

const STORAGE_KEY = "mymcp-setup-draft";
const INTRO_KEY = "mymcp-setup-intro-dismissed";

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

// ── Icons ───────────────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="relative group/tip inline-flex items-center">
      {children}
      <span className="invisible group-hover/tip:visible absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-1.5 rounded-md bg-text text-bg text-xs whitespace-nowrap z-50 shadow-lg max-w-xs">
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
      className="text-text-muted cursor-help"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4m0-4h.01" />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent"
    >
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4" />
    </svg>
  );
}

function ExtIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline ml-1 opacity-60"
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

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
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
      >
        <path d="m15 18-.722-3.25M2 8a10.645 10.645 0 0 0 20 0M20 15l-1.726-2.05M4 15l1.726-2.05M9 18l.722-3.25" />
      </svg>
    );
  }
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
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ── Credential Input with Show/Hide ──────────────────────────────────

function CredentialInput({
  v,
  value,
  onChange,
}: {
  v: PackVar;
  value: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const filled = value.length > 0;

  return (
    <div className="relative">
      <input
        type={v.sensitive && !revealed ? "password" : "text"}
        placeholder={v.placeholder || v.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-bg-muted border rounded-md pl-3 pr-20 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 transition-colors ${
          filled ? "border-green/40 bg-green-bg/30" : "border-border focus:border-accent"
        }`}
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {filled && (
          <span className="text-green flex items-center pr-1">
            <CheckIcon size={14} />
          </span>
        )}
        {v.sensitive && filled && (
          <button
            type="button"
            onClick={() => setRevealed(!revealed)}
            className="text-text-muted hover:text-text p-1 rounded"
            title={revealed ? "Hide value" : "Show value"}
          >
            <EyeIcon open={revealed} />
          </button>
        )}
      </div>
    </div>
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
  const [introDismissed, setIntroDismissed] = useState(true); // default true to avoid flash
  const [draftLoaded, setDraftLoaded] = useState(false);

  const mcpToken = useState(() => generateToken())[0];

  // ── LocalStorage autosave & restore ────────────────────────────

  useEffect(() => {
    // Load intro dismissed state
    setIntroDismissed(localStorage.getItem(INTRO_KEY) === "true");

    // Load draft
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.selectedPacks) setSelectedPacks(new Set(draft.selectedPacks));
        if (draft.credentials) setCredentials(draft.credentials);
        if (draft.settings) setSettings(draft.settings);
      }
    } catch {
      // Ignore corrupted draft
    }
    setDraftLoaded(true);
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    const draft = {
      selectedPacks: Array.from(selectedPacks),
      credentials,
      settings,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [selectedPacks, credentials, settings, draftLoaded]);

  const dismissIntro = () => {
    setIntroDismissed(true);
    localStorage.setItem(INTRO_KEY, "true");
  };

  const clearDraft = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSelectedPacks(new Set(["google", "vault"]));
    setCredentials({});
    setSettings({ timezone: "Europe/Paris", locale: "fr-FR", displayName: "" });
    setTestResults({});
  };

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
          [packId]: { ok: false, message: "Network error", detail: "Is the dev server running?" },
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
      if (data.ok) {
        setSaved(true);
        // Clear draft after successful save
        localStorage.removeItem(STORAGE_KEY);
      } else alert(data.error || "Save failed");
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

  const packFillStatus = (pack: PackDef) => {
    const required = pack.vars.filter((v) => !v.optional);
    const filled = required.filter((v) => credentials[v.key]);
    return {
      total: required.length,
      filled: filled.length,
      ready: filled.length === required.length,
    };
  };

  const hasAnyDraft = draftLoaded && Object.keys(credentials).length > 0;

  return (
    <div>
      {/* ── Welcome intro card — dismissible ─────────────────────── */}
      {firstTime && !introDismissed && step === 0 && (
        <div className="mb-8 border border-accent/20 bg-accent/5 rounded-lg p-5 relative">
          <button
            onClick={dismissIntro}
            className="absolute top-3 right-3 text-text-muted hover:text-text p-1"
            title="Dismiss"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
              <LightbulbIcon />
            </div>
            <div className="flex-1 pr-6">
              <h3 className="font-semibold text-sm mb-1">What is MyMCP?</h3>
              <p className="text-sm text-text-dim leading-relaxed mb-3">
                MyMCP is a single server that gives Claude, ChatGPT, and other AI clients access to
                your personal tools &mdash; Gmail, Calendar, Obsidian vault, and more. You own
                everything.
              </p>
              <div className="grid grid-cols-3 gap-3 mt-4">
                <div className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                    1
                  </span>
                  <div>
                    <p className="text-xs font-semibold">Pick your tools</p>
                    <p className="text-[11px] text-text-muted">6 packs, 51 tools</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                    2
                  </span>
                  <div>
                    <p className="text-xs font-semibold">Connect accounts</p>
                    <p className="text-[11px] text-text-muted">API keys &amp; OAuth</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                    3
                  </span>
                  <div>
                    <p className="text-xs font-semibold">Save &amp; deploy</p>
                    <p className="text-[11px] text-text-muted">Local or Vercel</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-4">
                <p className="text-[11px] text-text-muted">
                  Takes ~5 min. Credentials stay in your{" "}
                  <code className="bg-bg px-1 py-0.5 rounded">.env</code> &mdash; never sent
                  anywhere.
                </p>
                <button
                  onClick={dismissIntro}
                  className="text-xs font-medium text-accent hover:underline shrink-0 ml-4"
                >
                  Got it &rarr;
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Draft restore banner ───────────────────────────────── */}
      {draftLoaded && hasAnyDraft && !saved && (
        <div className="mb-6 border border-accent/30 bg-accent/5 rounded-lg px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent"
            >
              <path d="M21 12a9 9 0 1 1-6.22-8.56M21 3v6h-6" />
            </svg>
            <span className="text-text-dim">We restored your previous progress.</span>
          </div>
          <button onClick={clearDraft} className="text-xs text-text-muted hover:text-red">
            Start over
          </button>
        </div>
      )}

      {/* ── Step indicator with descriptions ────────────────────── */}
      <div className="flex items-start justify-between mb-10 px-4">
        {STEPS.map((s, i) => (
          <div key={s.label} className="flex items-start gap-0 flex-1">
            <button
              onClick={() => i <= step + 1 && setStep(i)}
              disabled={i > step + 1}
              className={`flex flex-col items-center gap-1.5 transition-all ${i <= step + 1 ? "cursor-pointer" : "cursor-not-allowed"}`}
            >
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all border-2 ${
                  i === step
                    ? "bg-accent text-white border-accent shadow-sm"
                    : i < step
                      ? "bg-green text-white border-green"
                      : "bg-bg border-border text-text-muted"
                }`}
              >
                {i < step ? <CheckIcon size={16} /> : i + 1}
              </div>
              <div className="text-center">
                <p
                  className={`text-xs font-semibold ${i === step ? "text-accent" : i < step ? "text-green" : "text-text-muted"}`}
                >
                  {s.label}
                </p>
                <p className="text-[10px] text-text-muted mt-0.5">{s.description}</p>
              </div>
            </button>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-2 mt-[18px] rounded ${i < step ? "bg-green" : "bg-border"}`}
              />
            )}
          </div>
        ))}
      </div>

      {/* ═══ Step 0: Tools (Packs + Credentials) ═══════════════════ */}
      {step === 0 && (
        <div>
          <div className="mb-6">
            <h2 className="font-semibold text-lg">Choose your tools</h2>
            <p className="text-sm text-text-dim mt-1">
              Click a pack to enable it, then fill in the credentials for that service.
            </p>
          </div>

          {/* Summary bar */}
          <div className="flex items-center justify-between mb-5 p-3 bg-bg-muted rounded-lg text-sm">
            <div>
              <span className="font-semibold text-accent">{activePacks.length}</span>
              <span className="text-text-dim"> of {PACKS.length} packs</span>
              <span className="text-text-muted mx-2">&middot;</span>
              <span className="font-semibold text-accent">{totalTools}</span>
              <span className="text-text-dim"> tools selected</span>
            </div>
            {activePacks.length === 0 && (
              <span className="text-[11px] text-orange">Pick at least one pack</span>
            )}
          </div>

          <div className="space-y-3">
            {PACKS.map((pack) => {
              const selected = selectedPacks.has(pack.id);
              const fillStatus = packFillStatus(pack);
              const test = testResults[pack.id];
              const guideOpen = expandedGuide === pack.id;
              const errorOpen = expandedError === pack.id;

              return (
                <div
                  key={pack.id}
                  className={`border rounded-lg overflow-hidden transition-all ${selected ? "border-accent" : "border-border"}`}
                >
                  <div
                    className={`flex items-center justify-between px-5 py-4 transition-colors ${selected ? "bg-accent/5" : ""}`}
                  >
                    <button
                      onClick={() => togglePack(pack.id)}
                      className="flex items-center gap-3 flex-1 text-left"
                    >
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm ${
                          selected
                            ? "bg-accent text-white"
                            : "bg-bg-muted text-text-muted border border-border-light"
                        }`}
                      >
                        {pack.icon}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm">{pack.name}</p>
                          <span
                            className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                              selected ? "text-accent bg-accent/10" : "text-text-muted bg-bg-muted"
                            }`}
                          >
                            {pack.toolCount} tools
                          </span>
                          {selected && fillStatus.total > 0 && (
                            <span
                              className={`text-[11px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1 ${
                                fillStatus.ready
                                  ? "text-green bg-green-bg"
                                  : "text-orange bg-orange-bg"
                              }`}
                            >
                              {fillStatus.ready && <CheckIcon size={10} />}
                              {fillStatus.filled}/{fillStatus.total} required
                            </span>
                          )}
                          {selected && test && (
                            <span
                              className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                                test.message === "Testing..."
                                  ? "text-accent bg-accent/10"
                                  : test.ok
                                    ? "text-green bg-green-bg"
                                    : "text-red bg-red-bg"
                              }`}
                            >
                              {test.message === "Testing..."
                                ? "Testing..."
                                : test.ok
                                  ? "Verified"
                                  : "Test failed"}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-dim mt-0.5">{pack.description}</p>
                      </div>
                    </button>
                    <button
                      onClick={() => togglePack(pack.id)}
                      className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ml-3 ${
                        selected ? "bg-accent" : "bg-bg-muted border border-border"
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white shadow-sm absolute top-1 transition-all ${
                          selected ? "left-6" : "left-1"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Credentials form — shown when selected */}
                  {selected && (
                    <div className="px-5 py-4 border-t border-border bg-bg">
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
                              {v.helpUrl && (
                                <a
                                  href={v.helpUrl}
                                  target="_blank"
                                  rel="noopener"
                                  className="text-[11px] text-accent hover:underline ml-auto"
                                >
                                  Get it here <ExtIcon />
                                </a>
                              )}
                            </div>
                            <CredentialInput
                              v={v}
                              value={credentials[v.key] || ""}
                              onChange={(val) => updateCredential(v.key, val)}
                            />
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 flex items-center gap-3">
                        <button
                          onClick={() => testPack(pack.id)}
                          disabled={!fillStatus.ready}
                          className={`text-sm font-medium px-4 py-1.5 rounded-md transition-colors ${
                            fillStatus.ready
                              ? "bg-bg-muted text-text-dim hover:bg-border-light hover:text-text"
                              : "bg-bg-muted text-text-muted cursor-not-allowed"
                          }`}
                          title={
                            fillStatus.ready
                              ? "Verify credentials work"
                              : "Fill all required fields first"
                          }
                        >
                          Test connection
                        </button>
                        {test && !test.ok && test.detail && (
                          <button
                            onClick={() => setExpandedError(errorOpen ? null : pack.id)}
                            className="text-xs text-text-muted hover:text-text underline"
                          >
                            {errorOpen ? "Hide error" : "Show error details"}
                          </button>
                        )}
                      </div>

                      {errorOpen && test && !test.ok && test.detail && (
                        <div className="mt-3 bg-red-bg border border-red/20 rounded-md p-3 text-xs font-mono text-red break-all">
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
            <p className="text-xs text-text-muted">Logging is always enabled.</p>
            <button
              onClick={() => setStep(1)}
              disabled={activePacks.length === 0}
              className={`px-6 py-2.5 rounded-md text-sm font-medium transition-colors ${
                activePacks.length > 0
                  ? "bg-accent text-white hover:bg-accent/90"
                  : "bg-bg-muted text-text-muted cursor-not-allowed"
              }`}
            >
              Next &rarr;
            </button>
          </div>
        </div>
      )}

      {/* ═══ Step 1: Settings ══════════════════════════════════════ */}
      {step === 1 && (
        <div>
          <div className="mb-6">
            <h2 className="font-semibold text-lg">Personalize your instance</h2>
            <p className="text-sm text-text-dim mt-1">
              These settings customize how your MCP server formats dates and identifies itself. All
              can be changed later.
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
                className="text-xs text-accent hover:underline flex items-center gap-1"
              >
                <EyeIcon open={showToken} />
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-text-muted mb-2">
              Auto-generated. You&rsquo;ll need this to connect your AI clients.
            </p>
            <code className="text-xs font-mono bg-bg-muted px-3 py-2 rounded-md border border-border block overflow-x-auto select-all break-all">
              {showToken
                ? mcpToken
                : `${mcpToken.slice(0, 8)}${"\u2022".repeat(24)}${mcpToken.slice(-4)}`}
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

      {/* ═══ Step 2: Save ══════════════════════════════════════════ */}
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

          <div className="border border-border rounded-lg p-5 mb-6">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.1em] mb-3">
              Configuration Summary
            </p>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-text-muted mb-1.5">Packs ({activePacks.length})</p>
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
                    const status = packFillStatus(p);
                    const test = testResults[p.id];
                    const tested = test && test.ok;
                    return (
                      <div key={p.id} className="flex items-center gap-2 text-sm">
                        <div
                          className={`w-1.5 h-1.5 rounded-full ${tested ? "bg-green" : status.ready ? "bg-accent" : "bg-orange"}`}
                        />
                        <span className="text-text-dim">{p.name}</span>
                        <span
                          className={`text-xs ${tested ? "text-green" : status.ready ? "text-accent" : "text-orange"}`}
                        >
                          {tested
                            ? "verified"
                            : status.ready
                              ? "credentials set"
                              : `${status.filled}/${status.total} required`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {!isVercel && (
              <button
                onClick={saveEnv}
                disabled={saving || saved}
                className={`w-full py-3 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  saved
                    ? "bg-green-bg text-green border border-green/20"
                    : "bg-accent text-white hover:bg-accent/90"
                } disabled:opacity-60`}
              >
                {saved && <CheckIcon size={16} />}
                {saved ? ".env saved successfully" : saving ? "Saving..." : "Save .env file"}
              </button>
            )}
            <button
              onClick={copyEnv}
              className={`w-full py-3 rounded-lg text-sm font-medium border transition-colors flex items-center justify-center gap-2 ${
                copied
                  ? "border-green/20 bg-green-bg text-green"
                  : "border-border hover:bg-bg-muted text-text-dim"
              }`}
            >
              {copied && <CheckIcon size={16} />}
              {copied ? "Copied to clipboard!" : "Copy env vars to clipboard"}
            </button>
          </div>

          {saved && (
            <div className="mt-6 border border-green/20 bg-green-bg/30 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-green text-white flex items-center justify-center">
                  <CheckIcon size={14} />
                </div>
                <p className="font-semibold text-sm text-green">You&rsquo;re all set!</p>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold shrink-0">
                    1
                  </span>
                  <div>
                    <p className="font-medium">Restart the dev server</p>
                    <code className="text-xs font-mono bg-bg px-2 py-1 rounded mt-1 inline-block">
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
                    <div className="mt-1 bg-bg rounded-md p-3 text-xs font-mono text-text-dim space-y-1 border border-border">
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
                    <code className="text-xs font-mono bg-bg px-2 py-1 rounded mt-1 inline-block">
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
  );
}
