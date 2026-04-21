/**
 * Destructive env-var registry (SAFE-01) + startup validation (SAFE-04).
 *
 * Motivation: the 2026-04-20 durability debugging session revealed
 * `MYMCP_RECOVERY_RESET=1` as a silent foot-gun — an operator who left it
 * set in production had their first-run bootstrap wiped on every cold
 * lambda. The fix is not to remove the recovery switch but to make it
 * visible: register every env var that can destroy state, surface a
 * warning when one is active in an environment it wasn't designed for,
 * and refuse to boot on reject-severity misconfigurations.
 *
 * This module is the single source of truth for "what env vars are
 * dangerous". Adding a new destructive switch means PR'ing a row to the
 * `DESTRUCTIVE_ENV_VARS` array — lower bar than a registration API, and
 * the surface is visible in one file at code-review time.
 *
 * See .planning/milestones/v0.10-durability-ROADMAP.md Phase 38.
 */

export type DestructiveSeverity = "warn" | "reject";

export interface DestructiveEnvVar {
  name: string;
  effect: string;
  allowedEnvs: Array<"development" | "production" | "test">;
  severity: DestructiveSeverity;
}

export interface ActiveDestructiveVar {
  var: DestructiveEnvVar;
  /** Presence marker only. Actual env value is NEVER exposed. */
  value: string;
  /** True iff `process.env.NODE_ENV` is in `var.allowedEnvs`. */
  allowed: boolean;
}

/**
 * Registry of environment variables with destructive side-effects.
 * Every entry is grep-confirmed against src/ and app/ at time of writing
 * or annotated "forward-compat" — included so operators / fork
 * maintainers can cite them without adding code for every new switch.
 */
export const DESTRUCTIVE_ENV_VARS: DestructiveEnvVar[] = [
  {
    name: "MYMCP_RECOVERY_RESET",
    effect:
      "Wipes first-run bootstrap state on every cold lambda start: rotates HMAC signing secret, clears MCP_AUTH_TOKEN, deletes the welcome cookie. All previously-minted welcome cookies stop verifying. Intended as an emergency unlock for a stuck welcome flow — leave it set in production and the instance wipes itself.",
    allowedEnvs: ["development"],
    severity: "warn",
  },
  {
    name: "MYMCP_ALLOW_EPHEMERAL_SECRET",
    effect:
      "Permits a /tmp-based HMAC seed when no durable KV is configured. Claim cookies do not survive lambda cold starts under this mode. Only safe for local dev — production deploys must set UPSTASH_REDIS_REST_URL (or KV_REST_API_URL) instead.",
    allowedEnvs: ["development"],
    severity: "warn",
  },
  {
    name: "MYMCP_DEBUG_LOG_SECRETS",
    effect:
      "Logs full credential values at DEBUG level. Never safe in production. (Forward-compat entry — not currently consumed, reserved for connector authors who need a debug path.)",
    allowedEnvs: ["development"],
    severity: "reject",
  },
  {
    name: "MYMCP_RATE_LIMIT_INMEMORY",
    effect:
      "Forces in-memory rate-limit storage. Under N-replica scaling each replica keeps its own counters and the effective limit is N× the configured RPM. Use Upstash KV for any deployment with more than one replica.",
    allowedEnvs: ["development"],
    severity: "warn",
  },
  {
    name: "MYMCP_SKIP_TOOL_TOGGLE_CHECK",
    effect:
      "Bypasses the disabled-tools allowlist enforced at invocation time. Any previously-disabled tool becomes callable. (Forward-compat entry — not currently consumed.)",
    allowedEnvs: ["development"],
    severity: "reject",
  },
];

/**
 * Env vars watched by `/api/admin/status` for presence diagnostics.
 * Union of destructive vars, core infra, and commonly-asked-about
 * runtime hints. VALUES ARE NEVER LOGGED — only presence booleans.
 */
export const WATCHED_ENV_KEYS: readonly string[] = [
  // Destructive vars
  ...DESTRUCTIVE_ENV_VARS.map((v) => v.name),
  // Core infra
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "MCP_AUTH_TOKEN",
  "ADMIN_AUTH_TOKEN",
  // Runtime hints
  "VERCEL",
  "VERCEL_URL",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_GIT_COMMIT_SHA",
  "NODE_ENV",
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "MYMCP_DURABLE_LOGS",
  "MYMCP_RATE_LIMIT_ENABLED",
];

/**
 * Returns presence booleans for every watched env var.
 * Only `!!process.env[key]` — never the value itself.
 */
export function getEnvPresence(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of WATCHED_ENV_KEYS) {
    out[key] = !!process.env[key];
  }
  return out;
}

function currentNodeEnv(): "development" | "production" | "test" {
  const raw = process.env.NODE_ENV;
  if (raw === "production" || raw === "development" || raw === "test") return raw;
  return "development";
}

/**
 * Treat "1", "true", "yes", "on" as truthy set values. Empty string,
 * "0", "false", "no", "off", undefined → unset. Matches the convention
 * used elsewhere in the codebase (e.g. `MYMCP_RECOVERY_RESET === "1"`).
 */
function isVarActive(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "0") return false;
  const lower = trimmed.toLowerCase();
  if (lower === "false" || lower === "no" || lower === "off") return false;
  return true;
}

/**
 * Returns an entry per destructive env var currently active in
 * `process.env`. Each entry includes `allowed` — true iff the current
 * NODE_ENV is in the var's `allowedEnvs` list.
 */
export function getActiveDestructiveVars(): ActiveDestructiveVar[] {
  const nodeEnv = currentNodeEnv();
  const out: ActiveDestructiveVar[] = [];
  for (const v of DESTRUCTIVE_ENV_VARS) {
    if (!isVarActive(process.env[v.name])) continue;
    out.push({
      var: v,
      value: "<set>",
      allowed: v.allowedEnvs.includes(nodeEnv),
    });
  }
  return out;
}

/**
 * Startup validator. Returns structured warnings and rejections — does
 * not itself log or terminate the process. The caller (`config.ts`
 * bootstrap hook) decides what to do.
 */
export function validateDestructiveVarsAtStartup(): {
  warnings: string[];
  rejections: string[];
} {
  const active = getActiveDestructiveVars();
  const warnings: string[] = [];
  const rejections: string[] = [];
  const nodeEnv = currentNodeEnv();
  for (const entry of active) {
    if (entry.allowed) continue;
    const msg = `[ENV-SAFETY] ${entry.var.name} is set in NODE_ENV=${nodeEnv} (allowed: ${entry.var.allowedEnvs.join(",") || "none"}); effect: ${entry.var.effect}`;
    if (entry.var.severity === "reject") rejections.push(msg);
    else warnings.push(msg);
  }
  return { warnings, rejections };
}
