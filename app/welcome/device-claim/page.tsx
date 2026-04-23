/**
 * Phase 52 follow-up / blocker fix:
 *
 * The second-device mini-welcome page. The operator pastes the HMAC-signed
 * invite URL from the first device's /config → Devices → Add device modal
 * into the second device's browser. This page POSTs the token to
 * /api/welcome/device-claim and surfaces the minted MCP_AUTH_TOKEN once,
 * never re-fetchable.
 *
 * The API route does all the validation (HMAC + expiry + nonce consumption
 * + env-store write). This page is a thin client shell that renders the
 * token copy-UI or the error state.
 */
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toMsg } from "@/core/error-utils";

type State =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "minted"; token: string; label: string }
  | { kind: "error"; status: number; message: string };

function useClaimToken(token: string | null): State {
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (!token) {
      setState({ kind: "error", status: 400, message: "Missing ?token in URL." });
      return;
    }
    let cancelled = false;
    setState({ kind: "claiming" });
    fetch("/api/welcome/device-claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (cancelled) return;
        const data = (await res.json().catch(() => ({}))) as {
          token?: string;
          label?: string;
          error?: string;
          message?: string;
        };
        if (res.ok && data.token) {
          setState({
            kind: "minted",
            token: data.token,
            label: data.label ?? "New device",
          });
        } else {
          const msg =
            data.message ??
            (data.error ? `${data.error} (${res.status})` : `Request failed (${res.status})`);
          setState({ kind: "error", status: res.status, message: msg });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", status: 0, message: toMsg(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return state;
}

function ClaimShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-text flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold mb-2">Claim this device</h1>
        {children}
      </div>
    </div>
  );
}

function MintedView({ token, label }: { token: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // silent-swallow-ok: clipboard API may be unavailable; user can select manually
    }
  }
  return (
    <>
      <p className="text-sm text-text-dim mb-3">
        Device <strong>{label}</strong> added. Copy the token into your MCP client config.{" "}
        <strong>This token is shown once</strong> — copy it now.
      </p>
      <div className="font-mono text-xs break-all rounded border border-border bg-bg p-3 mb-3 select-all">
        {token}
      </div>
      <button
        type="button"
        onClick={copy}
        className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90"
      >
        {copied ? "Copied!" : "Copy token"}
      </button>
      <p className="mt-4 text-[10px] text-text-muted">
        You can now close this tab. The operator will see this device listed in{" "}
        <code>/config → Devices</code>.
      </p>
    </>
  );
}

function ErrorView({ status, message }: { status: number; message: string }) {
  const hint = (() => {
    switch (status) {
      case 410:
        return "The invite URL expired. Ask the operator for a fresh one.";
      case 409:
        return "This invite was already used. Ask the operator for a fresh one.";
      case 401:
        return "The invite URL is invalid or tampered. Ask the operator for a fresh one.";
      case 503:
        return "The server's signing secret is unavailable. The operator must configure durable KV storage.";
      default:
        return "Retry, or ask the operator for a fresh invite URL.";
    }
  })();
  return (
    <>
      <p className="text-sm text-red-500 mb-2">Could not claim device ({status || "network"}).</p>
      <p className="text-xs text-text-dim mb-3 break-words">{message}</p>
      <p className="text-[10px] text-text-muted">{hint}</p>
    </>
  );
}

export default function DeviceClaimPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const state = useClaimToken(token);

  if (state.kind === "claiming" || state.kind === "idle") {
    return (
      <ClaimShell>
        <p className="text-sm text-text-dim">Claiming…</p>
      </ClaimShell>
    );
  }
  if (state.kind === "error") {
    return (
      <ClaimShell>
        <ErrorView status={state.status} message={state.message} />
      </ClaimShell>
    );
  }
  return (
    <ClaimShell>
      <MintedView token={state.token} label={state.label} />
    </ClaimShell>
  );
}
