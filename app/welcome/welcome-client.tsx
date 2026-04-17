"use client";

import { useCallback, useEffect, useState } from "react";
import { McpClientSnippets } from "../components/mcp-client-snippets";

type ClaimStatus = "loading" | "new" | "claimer" | "claimed-by-other" | "already-initialized";

interface InitResponse {
  ok: boolean;
  token: string;
  instanceUrl: string;
  autoMagic?: boolean;
  envWritten?: boolean;
  redeployTriggered?: boolean;
  redeployError?: string;
}

interface AutoMagicState {
  autoMagic: boolean;
  envWritten: boolean;
  redeployTriggered: boolean;
  redeployError?: string;
}

interface StatusResponse {
  initialized: boolean;
  permanent: boolean;
  isBootstrap: boolean;
}

interface WelcomeClientProps {
  initialBootstrap: boolean;
  previewMode?: boolean;
  previewToken?: string;
  previewInstanceUrl?: string;
}

type StorageMode = "kv" | "file" | "static" | "kv-degraded";

interface StorageStatus {
  mode: StorageMode;
  reason: string;
  dataDir: string | null;
  kvUrl: string | null;
  error: string | null;
  /** True only for file mode on Vercel /tmp — saves vanish on cold start. */
  ephemeral?: boolean;
}

type AckValue = "static" | "ephemeral" | null;
/**
 * Cookie name is versioned. v2 used `mymcp.storage.ack` with boolean "1"
 * (always meant static-mode ack, because v2 didn't differentiate
 * ephemeral). v3 uses `mymcp.storage.ack.v3` with semantic values. V2
 * cookies are explicitly NOT honored post-upgrade: the v2 → v3 UX is
 * materially different (3-card educational view, ephemeral-aware), so
 * users deserve to see the new flow once. The old cookie is also
 * cleared on first v3 mount to avoid ambiguity.
 */
const ACK_COOKIE = "mymcp.storage.ack.v3";
const LEGACY_ACK_COOKIE = "mymcp.storage.ack";

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

/**
 * Persist the user's acknowledgment of a non-ideal storage mode.
 *
 *   - "static" → user explicitly chose env-vars-only (no runtime saves).
 *   - "ephemeral" → user knows Vercel /tmp is temporary and accepts it.
 *
 * Scoped to the MODE it was given in: if the instance later flips to a
 * different non-ideal mode, the user is re-prompted because it's a
 * different decision. Cookie + localStorage for durability under strict
 * browser privacy settings (Brave shields, Safari ITP).
 */
function readAck(): AckValue {
  if (typeof document === "undefined") return null;
  for (const raw of document.cookie.split(";")) {
    const c = raw.trim();
    if (c.startsWith(`${ACK_COOKIE}=`)) {
      const value = c.slice(ACK_COOKIE.length + 1);
      if (value === "static" || value === "ephemeral") return value;
    }
  }
  try {
    const ls = window.localStorage.getItem(ACK_COOKIE);
    if (ls === "static" || ls === "ephemeral") return ls as AckValue;
  } catch {
    // localStorage blocked — fine, cookie is the source of truth
  }
  return null;
}

/**
 * Clear any legacy v2 cookie / localStorage key so it can't silently gate
 * a user on v3 who was v2-acked before the UX overhaul.
 */
function purgeLegacyAck(): void {
  deleteCookie(LEGACY_ACK_COOKIE);
  try {
    window.localStorage.removeItem(LEGACY_ACK_COOKIE);
  } catch {
    // ignore
  }
}

function writeAck(value: "static" | "ephemeral"): { persisted: boolean } {
  if (typeof document === "undefined") return { persisted: false };
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const secureFlag = isHttps ? "; Secure" : "";
  // Shorter TTL than v2 (30 days instead of 1 year). Storage modes change
  // more often than users expect — an instance moved between deploys, a
  // user set up Upstash and forgot. Forcing a re-confirm once a month
  // catches stale acks that misrepresent the current decision.
  document.cookie = `${ACK_COOKIE}=${value}; path=/; max-age=2592000; samesite=lax${secureFlag}`;
  const cookieOk = document.cookie.split(";").some((c) => c.trim() === `${ACK_COOKIE}=${value}`);
  let storageOk: boolean;
  try {
    window.localStorage.setItem(ACK_COOKIE, value);
    storageOk = window.localStorage.getItem(ACK_COOKIE) === value;
  } catch {
    storageOk = false;
  }
  return { persisted: cookieOk || storageOk };
}

/** Remove the current ack. Called when the user transitions to a healthy mode. */
function clearAck(): void {
  deleteCookie(ACK_COOKIE);
  try {
    window.localStorage.removeItem(ACK_COOKIE);
  } catch {
    // ignore
  }
}

export default function WelcomeClient({
  initialBootstrap,
  previewMode = false,
  previewToken = "",
  previewInstanceUrl = "",
}: WelcomeClientProps) {
  const [claim, setClaim] = useState<ClaimStatus>(previewMode ? "claimer" : "loading");
  const [token, setToken] = useState<string | null>(previewMode ? previewToken : null);
  const [instanceUrl, setInstanceUrl] = useState<string>(previewMode ? previewInstanceUrl : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [permanent, setPermanent] = useState(previewMode);
  const [autoMagicState, setAutoMagicState] = useState<AutoMagicState | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [skipTest, setSkipTest] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);
  const [ack, setAck] = useState<AckValue>(null);
  const [ackPersisted, setAckPersisted] = useState(true);

  // Hydrate ack flag from cookie/localStorage on mount (avoid SSR mismatch by
  // reading post-mount). Also nuke any leftover v2 cookie — v3 has a
  // materially different UX and a v2-acked user should see it at least once.
  useEffect(() => {
    purgeLegacyAck();
    setAck(readAck());
  }, []);

  // Auto-clear ack when the mode transitions to a healthy state. If the
  // user acks ephemeral, then sets up Upstash (mode becomes kv), then later
  // removes Upstash and drops to static, we want them re-prompted — not
  // silently ready because of a stale ephemeral ack from six months ago.
  useEffect(() => {
    if (!storageStatus) return;
    const healthyMode =
      storageStatus.mode === "kv" || (storageStatus.mode === "file" && !storageStatus.ephemeral);
    if (healthyMode && ack !== null) {
      clearAck();
      setAck(null);
    }
  }, [storageStatus, ack]);

  // Step 1: claim the instance. If we re-enter with bootstrap already active
  // (user came back to /welcome before the redeploy), auto-call init so we
  // can re-display the token without forcing them to click again. /init is
  // idempotent and returns the existing token.
  useEffect(() => {
    if (previewMode) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/welcome/claim", { method: "POST" });
        const data = (await res.json()) as { status: ClaimStatus };
        if (cancelled) return;
        setClaim(data.status);
        if (
          !cancelled &&
          initialBootstrap &&
          (data.status === "claimer" || data.status === "new")
        ) {
          try {
            const initRes = await fetch("/api/welcome/init", { method: "POST" });
            const initData = (await initRes.json()) as InitResponse | { error: string };
            if (!cancelled && initRes.ok && "token" in initData) {
              setToken(initData.token);
              setInstanceUrl(initData.instanceUrl || window.location.origin);
              setAutoMagicState({
                autoMagic: Boolean(initData.autoMagic),
                envWritten: Boolean(initData.envWritten),
                redeployTriggered: Boolean(initData.redeployTriggered),
                redeployError: initData.redeployError,
              });
            }
          } catch {
            // Silent — user can still click "Initialize" manually below.
          }
        }
      } catch {
        if (!cancelled) setError("Could not reach this instance. Try refreshing.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialBootstrap, previewMode]);

  // Poll status to detect "permanent" state (env var set in Vercel + redeployed).
  useEffect(() => {
    if (previewMode) return;
    if (permanent) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/welcome/status");
        const data = (await res.json()) as StatusResponse;
        if (data.permanent) setPermanent(true);
      } catch {
        // Ignore transient errors.
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [permanent, previewMode]);

  // Load the unified storage mode (kv / file / static / kv-degraded).
  // This replaces the legacy isolated "Upstash configured?" check and feeds
  // the welcome storage step + the MCP-client step list.
  const [storageFailures, setStorageFailures] = useState(0);
  const loadStorageStatus = useCallback(async (force = false) => {
    setStorageChecking(true);
    try {
      const res = await fetch(`/api/storage/status${force ? "?force=1" : ""}`, {
        credentials: "include",
      });
      if (!res.ok) {
        setStorageFailures((n) => n + 1);
        return;
      }
      const data = (await res.json()) as StorageStatus;
      setStorageStatus(data);
      setStorageFailures(0);
    } catch {
      // Count failures so the UI can offer a "continue anyway" escape
      // hatch after repeated detection errors (network partition, 500
      // loop). Without this, a user with a flaky network is stuck on
      // Welcome with the Continue button permanently disabled.
      setStorageFailures((n) => n + 1);
    } finally {
      setStorageChecking(false);
    }
  }, []);

  // Initial load on mount, refresh after token issued (so we re-fetch with
  // bearer cookie set by /init), and auto-refresh every 20s while the page
  // is open and the user hasn't yet reached a settled mode.
  useEffect(() => {
    void loadStorageStatus(false);
  }, [loadStorageStatus, token]);

  useEffect(() => {
    // Auto-poll while in transient states where the user is waiting on an
    // infrastructure change (kv-degraded recovery, ephemeral /tmp awaiting
    // Upstash setup, static awaiting Upstash setup). Stop once settled
    // (kv, non-ephemeral file) or once the user has explicitly acked the
    // non-ideal mode they're on.
    if (!storageStatus) return;
    const { mode, ephemeral } = storageStatus;
    if (mode === "kv") return;
    if (mode === "file" && !ephemeral) return;
    if (mode === "file" && ephemeral && ack === "ephemeral") return;
    if (mode === "static" && ack === "static") return;
    const id = setInterval(() => loadStorageStatus(true), 20_000);
    return () => clearInterval(id);
  }, [storageStatus, ack, loadStorageStatus]);

  const acknowledge = useCallback((value: "static" | "ephemeral") => {
    const { persisted } = writeAck(value);
    setAckPersisted(persisted);
    setAck(value);
  }, []);

  // "Ready" = user has a durable storage strategy. KV always ready. File
  // only ready when non-ephemeral OR when user explicitly acked ephemeral.
  // Static only ready when acked. Degraded never ready. Also: if we've
  // failed to detect the mode 3+ times in a row, treat as ready so the
  // user isn't trapped on welcome by a flaky network — server-side saves
  // still validate independently.
  const detectionTrapped = storageStatus === null && storageFailures >= 3;
  const storageReady =
    storageStatus?.mode === "kv" ||
    (storageStatus?.mode === "file" && !storageStatus.ephemeral) ||
    (storageStatus?.mode === "file" && storageStatus.ephemeral && ack === "ephemeral") ||
    (storageStatus?.mode === "static" && ack === "static") ||
    detectionTrapped;

  // Ack/mode mismatch: an existing ack stored for a different non-ideal
  // mode (e.g. user acked "static" in a previous session, instance later
  // flipped to file-ephemeral). storageReady will correctly gate them, but
  // we owe them a hint explaining why the "Continue" button is greyed out
  // despite a previous ack.
  const ackMismatch =
    ack !== null &&
    storageStatus &&
    !(storageStatus.mode === "kv") &&
    !(storageStatus.mode === "file" && !storageStatus.ephemeral) &&
    !(storageStatus.mode === "file" && storageStatus.ephemeral && ack === "ephemeral") &&
    !(storageStatus.mode === "static" && ack === "static");

  const initialize = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/welcome/init", { method: "POST" });
      const data = (await res.json()) as InitResponse | { error: string };
      if (!res.ok || !("token" in data)) {
        setError(("error" in data && data.error) || "Initialization failed.");
        return;
      }
      setToken(data.token);
      setInstanceUrl(data.instanceUrl || window.location.origin);
      setAutoMagicState({
        autoMagic: Boolean(data.autoMagic),
        envWritten: Boolean(data.envWritten),
        redeployTriggered: Boolean(data.redeployTriggered),
        redeployError: data.redeployError,
      });
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }, []);

  const runMcpTest = useCallback(async () => {
    if (!token) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      const res = await fetch("/api/welcome/test-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setTestStatus("ok");
      } else {
        setTestStatus("fail");
        setTestError(data.error || "MCP test failed");
      }
    } catch {
      setTestStatus("fail");
      setTestError("Network error");
    }
  }, [token]);

  const copyToken = useCallback(async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore.
    }
  }, [token]);

  // Vercel doesn't expose precise team/project slugs at runtime without a
  // VERCEL_TOKEN — we link to the dashboard root and let the user navigate.
  const vercelEnvUrl = "https://vercel.com/dashboard";
  const vercelDeployUrl = "https://vercel.com/dashboard";

  // ── Render branches ─────────────────────────────────────────────────

  if (claim === "loading") {
    return (
      <Shell>
        <p className="text-slate-400">Connecting to this instance…</p>
      </Shell>
    );
  }

  if (claim === "already-initialized") {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-white mb-2">Already initialized</h1>
        <p className="text-slate-400 mb-6">
          This instance has a permanent token. Head to the dashboard.
        </p>
        <a
          href="/config"
          className="inline-block bg-blue-500 hover:bg-blue-400 text-white px-5 py-2.5 rounded-lg font-semibold text-sm"
        >
          Open dashboard →
        </a>
      </Shell>
    );
  }

  if (claim === "claimed-by-other") {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-white mb-2">Instance locked</h1>
        <p className="text-slate-400">
          Another browser is currently initializing this instance. Wait for them to finish, or
          contact the operator who deployed it.
        </p>
      </Shell>
    );
  }

  // claim === "new" or "claimer" — allow init.
  if (!token && !initialBootstrap) {
    return (
      <Shell>
        <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">Welcome to MyMCP</h1>
        <p className="text-slate-400 mb-8 leading-relaxed">
          Click below to generate your permanent auth token and unlock this instance. The token will
          be shown once — save it somewhere safe.
        </p>
        {error && (
          <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        <button
          type="button"
          onClick={initialize}
          disabled={busy}
          className="bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-semibold text-sm transition-colors"
        >
          {busy ? "Generating…" : "Initialize this instance"}
        </button>
        <a href="/config" className="block mt-4 text-sm text-slate-500 hover:text-slate-300">
          Or explore the dashboard first →
        </a>
        <RecoveryFooter />
      </Shell>
    );
  }

  // Token visible: either freshly minted or we re-entered with bootstrap active.
  return (
    <Shell wide>
      {previewMode && (
        <div className="mb-6 rounded-lg border border-purple-800 bg-purple-950/40 px-4 py-3 text-sm text-purple-200">
          <strong className="font-semibold">Preview mode</strong> — read-only rendering against your
          live instance. No state is mutated. Close this tab when done.
        </div>
      )}
      {permanent &&
        !(
          autoMagicState?.autoMagic &&
          autoMagicState.envWritten &&
          autoMagicState.redeployTriggered
        ) && (
          <div className="mb-6 rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
            Setup complete — your Vercel deployment is now using the permanent token.
          </div>
        )}

      <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">Your auth token</h1>
      <p className="text-slate-400 mb-6 leading-relaxed">
        This is your permanent token.{" "}
        <span className="text-amber-300 font-medium">
          Save it now — you won&apos;t see it again.
        </span>
      </p>

      {token && (
        <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-start gap-3">
            <code className="flex-1 break-all text-sm text-blue-300 font-mono">{token}</code>
            <button
              type="button"
              onClick={copyToken}
              className="shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded text-xs font-semibold"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {(() => {
        const autoMagicSuccess =
          autoMagicState?.autoMagic &&
          autoMagicState.envWritten &&
          autoMagicState.redeployTriggered;
        const autoMagicPartial =
          autoMagicState?.autoMagic &&
          (!autoMagicState.envWritten || !autoMagicState.redeployTriggered);

        if (autoMagicSuccess) {
          return (
            <ol className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300">Token generated</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300">Written to Vercel env vars</span>
              </li>
              <li className="flex items-start gap-3">
                <span
                  className={permanent ? "text-emerald-400 mt-0.5" : "text-amber-400 mt-0.5"}
                  aria-hidden
                >
                  {permanent ? "✓" : "⏳"}
                </span>
                <span className="text-slate-300">
                  {permanent ? "Redeployed — your instance is permanent." : "Redeploying… (~60s)"}
                </span>
              </li>
              <StorageStepLine status={storageStatus} ack={ack} />
              <li className="flex items-start gap-3">
                <span className="text-slate-500 mt-0.5">□</span>
                <span className="text-slate-300">Configure your MCP client (snippet below)</span>
              </li>
            </ol>
          );
        }

        return (
          <>
            {autoMagicPartial && (
              <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
                Auto-deploy partially failed
                {autoMagicState?.redeployError ? ` (${autoMagicState.redeployError})` : ""} — fall
                back to manual steps below.
              </div>
            )}
            <ol className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300">Token generated</span>
              </li>
              <li className="flex items-start gap-3">
                <span
                  className={permanent ? "text-emerald-400 mt-0.5" : "text-slate-500 mt-0.5"}
                  aria-hidden
                >
                  {permanent ? "✓" : "□"}
                </span>
                <span className="text-slate-300">
                  Add token to Vercel as <code className="text-blue-300">MCP_AUTH_TOKEN</code> →{" "}
                  <a
                    href={vercelEnvUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    Open Vercel dashboard
                  </a>
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span
                  className={permanent ? "text-emerald-400 mt-0.5" : "text-slate-500 mt-0.5"}
                  aria-hidden
                >
                  {permanent ? "✓" : "□"}
                </span>
                <span className="text-slate-300">
                  Redeploy from the Deployments tab →{" "}
                  <a
                    href={vercelDeployUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    Open Vercel dashboard
                  </a>
                </span>
              </li>
              <StorageStepLine status={storageStatus} ack={ack} />
              <li className="flex items-start gap-3">
                <span className="text-slate-500 mt-0.5">□</span>
                <span className="text-slate-300">Configure your MCP client (snippet below)</span>
              </li>
            </ol>
          </>
        );
      })()}

      {permanent && storageStatus && (
        <>
          {ackMismatch && (
            <div className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
              <strong className="font-semibold">Your previous choice needs re-confirming.</strong>{" "}
              This instance&apos;s storage changed since you last acked — pick an option from the
              cards below to continue.
            </div>
          )}
          <WelcomeStorageStep
            status={storageStatus}
            checking={storageChecking}
            ack={ack}
            onRecheck={() => loadStorageStatus(true)}
            onAcknowledge={acknowledge}
          />
          {ack !== null && !ackPersisted && (
            <div className="mb-6 rounded-lg border border-orange-900/60 bg-orange-950/30 px-4 py-3 text-xs text-orange-200">
              <strong className="font-semibold">Your browser blocked our cookie.</strong> Your
              choice will not persist across reloads — re-confirm if you come back, or unblock
              cookies for this origin.
            </div>
          )}
        </>
      )}
      {permanent && detectionTrapped && (
        <div className="mb-6 rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 text-xs text-amber-200">
          <p className="font-semibold mb-1">Storage detection failed</p>
          <p className="leading-relaxed mb-2">
            We couldn&apos;t reach <code className="font-mono">/api/storage/status</code> after
            several tries. Continue is unblocked so a flaky network doesn&apos;t trap you here — but
            saves from the dashboard may fail until the server responds again. Retry detection:
          </p>
          <button
            type="button"
            onClick={() => loadStorageStatus(true)}
            disabled={storageChecking}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold"
          >
            {storageChecking ? "Rechecking…" : "Retry"}
          </button>
        </div>
      )}

      {token && <TokenUsagePanel token={token} instanceUrl={instanceUrl} />}
      <MultiClientNote />

      {token && <StarterSkillsPanel />}

      <TestMcpPanel
        permanent={permanent}
        testStatus={testStatus}
        testError={testError}
        runMcpTest={runMcpTest}
      />

      {(() => {
        const canContinue = (permanent && testStatus === "ok" && storageReady) || skipTest;
        return (
          <div className="flex items-center gap-4">
            <a
              href={canContinue ? "/config" : undefined}
              aria-disabled={!canContinue}
              onClick={(e) => {
                if (!canContinue) e.preventDefault();
              }}
              className={`inline-block px-6 py-3 rounded-lg font-semibold text-sm transition-colors ${
                canContinue
                  ? "bg-blue-500 hover:bg-blue-400 text-white cursor-pointer"
                  : "bg-slate-800 text-slate-500 cursor-not-allowed"
              }`}
            >
              Continue to dashboard →
            </a>
            {!canContinue && !skipTest && (
              <button
                type="button"
                onClick={() => setSkipTest(true)}
                className="text-xs text-slate-600 hover:text-slate-400 underline"
              >
                Skip test and continue anyway
              </button>
            )}
          </div>
        );
      })()}
      <RecoveryFooter />
    </Shell>
  );
}

/**
 * Single line in the welcome step list reflecting current storage mode.
 *
 * - kv / file → green checkmark "Storage ready"
 * - static + acknowledged → grey checkmark "Static mode (env vars only)"
 * - static + not acknowledged → empty checkbox "Storage decision needed"
 * - kv-degraded → red ✗ "KV unreachable"
 * - null (still loading) → grey "Checking storage…"
 */
function StorageStepLine({ status, ack }: { status: StorageStatus | null; ack: AckValue }) {
  if (!status) {
    return (
      <li className="flex items-start gap-3">
        <span className="text-slate-500 mt-0.5">…</span>
        <span className="text-slate-300">Checking storage…</span>
      </li>
    );
  }
  if (status.mode === "kv") {
    return (
      <li className="flex items-start gap-3">
        <span className="text-emerald-400 mt-0.5">✓</span>
        <span className="text-slate-300">Storage: Upstash Redis ready</span>
      </li>
    );
  }
  if (status.mode === "file") {
    // Ephemeral /tmp on Vercel is a SILENT TRAP in v2: saves appear to work
    // but evaporate on the next cold start. We never show green here, even
    // after the user acks — only amber/warn. Acknowledgment lets them
    // continue but doesn't upgrade the tone because the underlying storage
    // is still temporary.
    if (status.ephemeral) {
      if (ack === "ephemeral") {
        return (
          <li className="flex items-start gap-3">
            <span className="text-amber-400 mt-0.5">⚠</span>
            <span className="text-slate-300">
              Storage: Vercel /tmp (temporary — saves will vanish on cold start, by your choice)
            </span>
          </li>
        );
      }
      return (
        <li className="flex items-start gap-3">
          <span className="text-amber-400 mt-0.5">□</span>
          <span className="text-slate-300">
            Choose your storage strategy — current /tmp is temporary (see below)
          </span>
        </li>
      );
    }
    return (
      <li className="flex items-start gap-3">
        <span className="text-emerald-400 mt-0.5">✓</span>
        <span className="text-slate-300">Storage: file-based (writable)</span>
      </li>
    );
  }
  if (status.mode === "static") {
    if (ack === "static") {
      return (
        <li className="flex items-start gap-3">
          <span className="text-slate-400 mt-0.5">✓</span>
          <span className="text-slate-300">
            Storage: env-vars only (saves disabled, by your choice)
          </span>
        </li>
      );
    }
    return (
      <li className="flex items-start gap-3">
        <span className="text-amber-400 mt-0.5">□</span>
        <span className="text-slate-300">Choose your storage strategy (see below)</span>
      </li>
    );
  }
  // kv-degraded
  return (
    <li className="flex items-start gap-3">
      <span className="text-red-400 mt-0.5">✗</span>
      <span className="text-slate-300">Storage: KV unreachable — see below</span>
    </li>
  );
}

/**
 * Full storage configuration panel inside the welcome flow (v3).
 *
 * **Design principle:** the welcome page is the pedagogical moment. Even
 * when detection resolves a mode automatically, we SHOW the three options
 * with tradeoffs so first-time users learn what's available and what they
 * might be giving up. Compact banner-only rendering is fine for the
 * dashboard (settled state), not here.
 *
 * Mode-specific behavior:
 *   - kv → green confirmation + collapsible "See other options"
 *   - file (non-ephemeral, Docker/dev) → green confirmation + collapsible
 *   - file (ephemeral, Vercel /tmp) → AMBER warning + 3 cards always visible
 *     with explicit "Keep temporary (not recommended)" acknowledgment
 *   - static → 3 cards always visible, ack required to continue
 *   - kv-degraded → red error banner (don't show 3 cards — infra broken)
 */
function WelcomeStorageStep({
  status,
  checking,
  ack,
  onRecheck,
  onAcknowledge,
}: {
  status: StorageStatus;
  checking: boolean;
  ack: AckValue;
  onRecheck: () => void;
  onAcknowledge: (value: "static" | "ephemeral") => void;
}) {
  if (status.mode === "kv-degraded") {
    return (
      <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 p-5">
        <p className="text-sm font-semibold text-red-300 mb-1">KV configured but unreachable</p>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
          We don&apos;t silently downgrade to file storage during a temporary KV outage — that would
          cause data loss when Upstash recovers. Check that your Upstash database is online and your
          token is valid, then click recheck.
        </p>
        {status.error && (
          <p className="text-[11px] font-mono text-red-200 bg-red-950/60 p-2 rounded mb-3">
            {status.error}
          </p>
        )}
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 px-4 py-2 rounded-md text-xs font-semibold"
        >
          {checking ? "Rechecking…" : "Retry detection"}
        </button>
      </div>
    );
  }

  const settled = status.mode === "kv" || (status.mode === "file" && !status.ephemeral);

  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5 space-y-4">
      {/* Header: intent + status */}
      {status.mode === "kv" && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          ✓ Storage ready — Upstash Redis connected. Saves persist instantly across deploys.
        </div>
      )}
      {status.mode === "file" && !status.ephemeral && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          ✓ Storage ready — file-based at <code className="font-mono">{status.dataDir}</code>. Saves
          persist locally.
        </div>
      )}
      {status.mode === "file" && status.ephemeral && (
        <div className="rounded-md border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          <p className="font-semibold mb-1">
            ⚠ Your storage is temporary — saves will vanish on cold start
          </p>
          <p className="text-[12px] text-amber-200/90 leading-relaxed">
            Vercel reset <code className="font-mono">/tmp</code> on every container recycle
            (typically every 15–30 min of inactivity). Credentials saved from the dashboard{" "}
            <strong>will be silently lost</strong>. Pick a real storage option below.
          </p>
        </div>
      )}
      {status.mode === "static" && (
        <div>
          <p className="text-sm font-semibold text-white mb-1">Choose your storage strategy</p>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            This instance has no persistent storage configured. Your filesystem is read-only and no
            KV backend is set up. Pick one of the paths below.
          </p>
        </div>
      )}

      {/* 3-card choice layout — always rendered for ephemeral/static,
          collapsible for settled modes (KV / non-ephemeral file). */}
      {settled ? (
        <details>
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200">
            See all storage options
          </summary>
          <div className="mt-3">
            <StorageChoiceCards
              status={status}
              ack={ack}
              checking={checking}
              onRecheck={onRecheck}
              onAcknowledge={onAcknowledge}
            />
          </div>
        </details>
      ) : (
        <StorageChoiceCards
          status={status}
          ack={ack}
          checking={checking}
          onRecheck={onRecheck}
          onAcknowledge={onAcknowledge}
        />
      )}

      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">
          What&apos;s the difference?
        </summary>
        <div className="mt-2 space-y-1.5 leading-relaxed">
          <p>
            <strong className="text-slate-300">Live database (Upstash):</strong> a hosted
            Redis-compatible store. Saves from the dashboard go straight to Upstash and are
            immediately visible to every connector. Works identically on Vercel, Docker, or any
            other deploy. Free tier covers personal use.
          </p>
          <p>
            <strong className="text-slate-300">Local file:</strong> MyMCP writes to{" "}
            <code className="font-mono">./data/kv.json</code> and <code>.env</code> on disk. Great
            for Docker with a mounted volume or local dev. Doesn&apos;t work for multi-instance
            deploys because each instance has its own file.
          </p>
          <p>
            <strong className="text-slate-300">Env vars only:</strong> no dashboard saves. Set
            credentials in your deploy environment (Vercel → Settings → Environment Variables),
            redeploy, done. Good for infra-as-code teams who version everything.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * 3-card grid surfacing the storage options with tradeoffs. Highlights the
 * current mode with a badge, recommends the best upgrade when the current
 * one is sub-optimal, and exposes exactly one action per card.
 */
function StorageChoiceCards({
  status,
  ack,
  checking,
  onRecheck,
  onAcknowledge,
}: {
  status: StorageStatus;
  ack: AckValue;
  checking: boolean;
  onRecheck: () => void;
  onAcknowledge: (value: "static" | "ephemeral") => void;
}) {
  const isKv = status.mode === "kv";
  const isFile = status.mode === "file";
  const isEphemeral = isFile && Boolean(status.ephemeral);
  const isStatic = status.mode === "static";
  // KV is "recommended" when the user's current mode is sub-optimal:
  // ephemeral file or static. For healthy kv/file, no recommendation badge.
  const kvRecommended = isEphemeral || isStatic;

  return (
    <div className="grid sm:grid-cols-3 gap-3">
      {/* Card 1 — Live database (Upstash) */}
      <Card
        tone={isKv ? "current" : "default"}
        title="Live database"
        subtitle="(Upstash Redis)"
        currentBadge={isKv}
        recommendedBadge={kvRecommended}
      >
        <ul className="text-[11px] text-slate-400 list-disc list-inside space-y-0.5">
          <li>Instant saves from the dashboard</li>
          <li>Survives cold starts &amp; redeploys</li>
          <li>Works on any host (Vercel, Docker, …)</li>
          <li>Free tier available</li>
        </ul>
        {isKv ? (
          <p className="text-[11px] text-emerald-300 font-medium">Active — nothing to do.</p>
        ) : (
          <>
            <ol className="text-[11px] text-slate-400 list-decimal list-inside space-y-0.5">
              <li>
                Open{" "}
                <a
                  href="https://vercel.com/integrations/upstash"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Vercel → Integrations → Upstash
                </a>
              </li>
              <li>Add the integration to this project</li>
              <li>Wait for auto-redeploy, then recheck</li>
            </ol>
            <button
              type="button"
              onClick={onRecheck}
              disabled={checking}
              className="w-full bg-blue-500 hover:bg-blue-400 disabled:opacity-40 text-white px-3 py-1.5 rounded-md text-xs font-semibold"
            >
              {checking ? "Rechecking…" : "I added Upstash — recheck"}
            </button>
          </>
        )}
      </Card>

      {/* Card 2 — Local file.
          When ephemeral, the warning badge IS the current-mode indicator;
          showing both emerald "← Your setup" AND amber "⚠ Temporary" was
          visually contradictory (emerald on amber). Suppress the emerald
          current-badge in the ephemeral case. */}
      <Card
        tone={isFile && !isEphemeral ? "current" : isEphemeral ? "warning" : "default"}
        title="Local file"
        subtitle={isEphemeral ? "(serverless /tmp — temporary!)" : "(Docker / dev)"}
        currentBadge={isFile && !isEphemeral}
        warningBadge={isEphemeral}
      >
        {isEphemeral ? (
          <>
            <ul className="text-[11px] text-amber-200 list-disc list-inside space-y-0.5">
              <li className="font-semibold">⚠ Vercel /tmp resets on every cold start</li>
              <li>Saves look like they work, then silently disappear</li>
              <li>Not viable for real use — only fine if you&apos;re actively testing</li>
            </ul>
            <button
              type="button"
              onClick={() => onAcknowledge("ephemeral")}
              disabled={ack === "ephemeral"}
              className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-amber-200 px-3 py-1.5 rounded-md text-xs font-semibold border border-amber-900/60"
            >
              {ack === "ephemeral"
                ? "Acknowledged — saves are temporary"
                : "I understand, keep temporary storage"}
            </button>
          </>
        ) : (
          <>
            <ul className="text-[11px] text-slate-400 list-disc list-inside space-y-0.5">
              <li>Saves persist across restarts (with a mounted volume)</li>
              <li>Good for single-instance Docker or local dev</li>
              <li>Not suited to multi-instance deploys</li>
              <li>Export .env anytime for backup/migration</li>
            </ul>
            {isFile ? (
              <p className="text-[11px] text-emerald-300 font-medium">
                Active at <code className="font-mono">{status.dataDir}</code>.
              </p>
            ) : (
              <p className="text-[11px] text-slate-500">
                Not available on this deploy — filesystem is read-only.
              </p>
            )}
          </>
        )}
      </Card>

      {/* Card 3 — Env vars only */}
      <Card
        tone={isStatic ? "current" : "default"}
        title="Env vars only"
        subtitle="(no runtime saves)"
        currentBadge={isStatic}
      >
        <ul className="text-[11px] text-slate-400 list-disc list-inside space-y-0.5">
          <li>Set credentials in your deploy env</li>
          <li>Each change requires a redeploy</li>
          <li>Dashboard saves disabled (you get .env stub helpers)</li>
          <li>Fits infra-as-code workflows</li>
        </ul>
        {isStatic ? (
          <button
            type="button"
            onClick={() => onAcknowledge("static")}
            disabled={ack === "static"}
            className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 px-3 py-1.5 rounded-md text-xs font-semibold"
          >
            {ack === "static" ? "Acknowledged — env-vars only" : "Continue env-vars only"}
          </button>
        ) : (
          <p className="text-[11px] text-slate-500">
            Switch by removing KV and any writable FS, then redeploy. Rarely what you want.
          </p>
        )}
      </Card>
    </div>
  );
}

function Card({
  tone,
  title,
  subtitle,
  currentBadge,
  recommendedBadge,
  warningBadge,
  children,
}: {
  tone: "current" | "warning" | "default";
  title: string;
  subtitle: string;
  currentBadge?: boolean;
  recommendedBadge?: boolean;
  warningBadge?: boolean;
  children: React.ReactNode;
}) {
  const border =
    tone === "current"
      ? "border-emerald-700/80"
      : tone === "warning"
        ? "border-amber-700/80"
        : "border-slate-700";
  const bg =
    tone === "current"
      ? "bg-emerald-950/30"
      : tone === "warning"
        ? "bg-amber-950/30"
        : "bg-slate-950";
  return (
    <div className={`rounded-md border ${border} ${bg} p-4 space-y-2 flex flex-col`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {currentBadge && (
          <span className="text-[9px] font-semibold text-emerald-300 bg-emerald-950/60 px-1.5 py-0.5 rounded uppercase tracking-wide">
            ← Your setup
          </span>
        )}
        {recommendedBadge && (
          <span className="text-[9px] font-semibold text-blue-300 bg-blue-950/60 px-1.5 py-0.5 rounded uppercase tracking-wide">
            ★ Recommended
          </span>
        )}
        {warningBadge && (
          <span className="text-[9px] font-semibold text-amber-300 bg-amber-950/60 px-1.5 py-0.5 rounded uppercase tracking-wide">
            ⚠ Temporary
          </span>
        )}
      </div>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-[11px] text-slate-500">{subtitle}</p>
      </div>
      <div className="space-y-2 flex-1">{children}</div>
    </div>
  );
}

function TestMcpPanel({
  permanent,
  testStatus,
  testError,
  runMcpTest,
}: {
  permanent: boolean;
  testStatus: "idle" | "testing" | "ok" | "fail";
  testError: string | null;
  runMcpTest: () => void;
}) {
  return (
    <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-sm font-semibold text-white mb-1">Verify your install</p>
      <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
        Test that your token authenticates against <code className="font-mono">/api/mcp</code> on
        this instance. The dashboard unlocks only once the redeploy is live <em>and</em> the test
        passes.
      </p>

      <ol className="space-y-2 mb-4 text-xs">
        <li className="flex items-center gap-2">
          <span aria-hidden>{permanent ? "✓" : "⏳"}</span>
          <span className={permanent ? "text-emerald-300" : "text-amber-300"}>
            {permanent
              ? "Permanent token active in Vercel"
              : "Waiting for Vercel redeploy (auto-polling)…"}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden>{testStatus === "ok" ? "✓" : testStatus === "fail" ? "✗" : "□"}</span>
          <span
            className={
              testStatus === "ok"
                ? "text-emerald-300"
                : testStatus === "fail"
                  ? "text-red-300"
                  : "text-slate-400"
            }
          >
            {testStatus === "idle" && "MCP endpoint not tested yet"}
            {testStatus === "testing" && "Testing MCP endpoint…"}
            {testStatus === "ok" && "MCP endpoint responded — install confirmed"}
            {testStatus === "fail" && `Test failed: ${testError ?? "unknown error"}`}
          </span>
        </li>
      </ol>

      <button
        type="button"
        onClick={runMcpTest}
        disabled={!permanent || testStatus === "testing"}
        className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 px-4 py-2 rounded-md text-xs font-semibold transition-colors"
      >
        {testStatus === "testing"
          ? "Testing…"
          : testStatus === "ok"
            ? "Re-run test"
            : "Test MCP connection"}
      </button>
      {!permanent && (
        <span className="ml-3 text-[11px] text-slate-600">
          (enabled once the redeploy finishes)
        </span>
      )}
    </div>
  );
}

function TokenUsagePanel({ token, instanceUrl }: { token: string; instanceUrl: string }) {
  const baseUrl = instanceUrl || "https://YOUR-INSTANCE.vercel.app";

  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-sm font-semibold text-white mb-3">How to use this token</p>
      <McpClientSnippets baseUrl={baseUrl} token={token} theme="welcome" />
    </div>
  );
}

interface StarterSkill {
  id: string;
  name: string;
  description: string;
  icon: string;
}

function StarterSkillsPanel() {
  const [skills, setSkills] = useState<StarterSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/welcome/starter-skills", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setLoading(false);
          return;
        }
        const data = (await res.json()) as { skills: StarterSkill[] };
        if (!cancelled) {
          setSkills(data.skills || []);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/welcome/starter-skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setInstalled((s) => {
          const next = new Set(s);
          next.add(id);
          return next;
        });
      } else {
        setError(data.error || "Install failed");
      }
    } catch {
      setError("Network error");
    }
    setBusy(null);
  };

  if (loading) return null;
  if (skills.length === 0) return null;

  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <p className="text-sm font-semibold text-white">Or skip credentials — start with a skill</p>
        <span className="text-[11px] text-slate-500">No connector setup required</span>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
        Skills are reusable prompt templates exposed to your AI client as MCP tools. These three
        starters work in any client without needing Google, Notion, GitHub, or any other
        credentials. Install one now to feel the value, then come back to set up real connectors
        when you&apos;re ready.
      </p>
      <ul className="space-y-2">
        {skills.map((s) => {
          const done = installed.has(s.id);
          return (
            <li
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-slate-800 bg-slate-950 p-3"
            >
              <span className="text-xl leading-none mt-0.5" aria-hidden>
                {s.icon}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200">
                  <code className="font-mono text-blue-300">skill_{s.name}</code>
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">{s.description}</p>
              </div>
              <button
                type="button"
                onClick={() => !done && install(s.id)}
                disabled={done || busy === s.id}
                className={`shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-md transition-colors ${
                  done
                    ? "bg-emerald-900/60 text-emerald-300 cursor-default"
                    : "bg-blue-500 hover:bg-blue-400 text-white disabled:opacity-50"
                }`}
              >
                {done ? "Installed ✓" : busy === s.id ? "Installing…" : "Install"}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mt-3 text-[11px] text-red-300">
          {error} — you can also add starter skills later from /config → Skills.
        </p>
      )}
    </div>
  );
}

function MultiClientNote() {
  return (
    <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
      <p className="text-xs font-semibold text-slate-300 mb-1">One token, any number of clients</p>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        The same token works in <strong className="text-slate-300">every</strong> MCP client —
        Claude Desktop, Claude Code, Cursor, ChatGPT, etc. Just paste it everywhere. Use multiple
        comma-separated tokens (in the{" "}
        <code className="font-mono text-slate-400">MCP_AUTH_TOKEN</code> env var) only if you want
        to revoke one client without breaking the others.
      </p>
    </div>
  );
}

function RecoveryFooter() {
  return (
    <details className="mt-12 text-xs text-slate-600">
      <summary className="cursor-pointer hover:text-slate-400">Locked out? Recover access</summary>
      <p className="mt-2 leading-relaxed">
        If you&apos;ve lost access to this instance, set{" "}
        <code className="text-slate-500">MYMCP_RECOVERY_RESET=1</code> in your Vercel project&apos;s
        environment variables and trigger a redeploy. After the new deployment boots, the bootstrap
        state will be cleared and you can claim this instance again from <code>/welcome</code>.
        Remove <code className="text-slate-500">MYMCP_RECOVERY_RESET</code> after recovery —
        otherwise it resets on every cold start.
      </p>
    </details>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className={`mx-auto px-6 py-20 ${wide ? "max-w-2xl" : "max-w-xl"}`}>
        <p className="text-xs font-mono text-blue-400 mb-4 tracking-wider uppercase">
          MyMCP · First-run setup
        </p>
        {children}
      </div>
    </div>
  );
}
