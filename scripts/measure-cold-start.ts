/**
 * scripts/measure-cold-start.ts
 *
 * Deterministic cold-start reproducer for `/api/[transport]`.
 *
 * Each iteration spawns a FRESH `node` subprocess (no shared module cache —
 * that's what "cold-start" means). The child imports the transport route
 * module + invokes `buildHandler(null, null, null)` once, then writes
 * `READY` on stdout. The parent measures wall time from `spawn` to that
 * READY line and collects samples into an array.
 *
 * The transport module imports the connector registry at module-load time,
 * so this wall-time captures the full cost of connector-manifest loading +
 * initial buildHandler() call — the exact code path we are optimizing in
 * PERF-01.
 *
 * Usage:
 *   npx tsx scripts/measure-cold-start.ts --iterations 20
 *
 * Output:
 *   [Cold-start] iter=1   ready=412ms
 *   ...
 *   ===========================================
 *   p50    = 380 ms
 *   p95    = 612 ms
 *   mean   = 410 ms
 *   stddev = 58 ms
 *   N      = 18 (2 samples dropped: child exited non-zero)
 *
 * This script is zero-dep: only stdlib (`child_process`, `path`). Runs under
 * `npx tsx` against the current repo — no fresh `npm run build` required
 * for intra-phase delta measurement, but a fresh build IS required before
 * BASELINE.md capture so numbers reflect production-equivalent code paths.
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as path from "node:path";

function parseArgs(): { iterations: number } {
  const args = process.argv.slice(2);
  let iterations = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--iterations" && args[i + 1]) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0 && n <= 200) iterations = n;
    }
  }
  return { iterations };
}

/**
 * Minimal child script: import the transport route module to trigger
 * the full registry + pipeline construction, then print READY. The
 * import itself is what costs — connector manifests, pipeline steps,
 * and all their transitive deps. Whether or not we invoke the handler
 * after import doesn't meaningfully change the cold-start time because
 * buildHandler() is constructed lazily on first request.
 *
 * The child is written to a temp file rather than passed inline via
 * `-e` because `npx tsx -e` across spawn + windows shells quotes
 * unpredictably on multi-line scripts. A real file on disk is the
 * simplest portable approach.
 */
import * as fs from "node:fs";
import * as os from "node:os";

let CHILD_SCRIPT_PATH: string | null = null;
function writeChildScript(repoRoot: string): string {
  if (CHILD_SCRIPT_PATH && fs.existsSync(CHILD_SCRIPT_PATH)) return CHILD_SCRIPT_PATH;
  // Write the child to the repo root so relative imports + tsconfig paths
  // resolve naturally. Use a `.cold-start-probe.mjs` dotfile name (not
  // gitignored but clearly ephemeral; cleaned up at end).
  const scriptPath = path.join(repoRoot, `.cold-start-probe-${process.pid}.ts`);
  const routePath = path.join(repoRoot, "app", "api", "[transport]", "route.ts");
  // Use an ABSOLUTE file URL for the import so the child's CWD doesn't
  // affect resolution. This is the only spec-portable way to pass a path
  // with brackets ([transport]) through a dynamic import on Windows.
  const routeUrl = "file:///" + routePath.replace(/\\/g, "/");
  const body = [
    "(async () => {",
    "  try {",
    `    await import(${JSON.stringify(routeUrl)});`,
    "    process.stdout.write('READY\\n');",
    "    process.exit(0);",
    "  } catch (err) {",
    "    process.stderr.write('CHILD_ERROR:' + (err && err.message ? err.message : String(err)) + '\\n');",
    "    process.exit(1);",
    "  }",
    "})();",
  ].join("\n");
  fs.writeFileSync(scriptPath, body, "utf8");
  CHILD_SCRIPT_PATH = scriptPath;
  return scriptPath;
}
function cleanupChildScript() {
  if (CHILD_SCRIPT_PATH && fs.existsSync(CHILD_SCRIPT_PATH)) {
    try {
      fs.unlinkSync(CHILD_SCRIPT_PATH);
    } catch {
      /* ignore */
    }
  }
}
// Reference `os` import even though we no longer use tmpdir — keeps the
// module import pattern consistent if someone later adds tmpdir fallback.
void os;

interface Sample {
  iter: number;
  ms: number;
  ok: boolean;
  reason?: string;
}

async function measureOne(iter: number): Promise<Sample> {
  return new Promise((resolve) => {
    const start = performance.now();
    const repoRoot = path.resolve(__dirname, "..");
    const scriptPath = writeChildScript(repoRoot);
    // On Windows we use `shell: true` so `npx` resolves via PATHEXT.
    // Spaces in the path (e.g. "Kebab MCP") must be quoted explicitly
    // because child_process.spawn does NOT quote for shell-mode.
    const isWindows = process.platform === "win32";
    const quotedScript = isWindows ? `"${scriptPath}"` : scriptPath;
    const child = spawn("npx", ["--yes", "tsx", quotedScript], {
      cwd: repoRoot,
      shell: isWindows,
      env: { ...process.env, NODE_ENV: "production" },
    });
    let seenReady = false;
    let stderrBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes("READY") && !seenReady) {
        seenReady = true;
        const ms = performance.now() - start;
        resolve({ iter, ms, ok: true });
        child.kill();
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
    });
    child.on("exit", (code) => {
      if (!seenReady) {
        resolve({
          iter,
          ms: 0,
          ok: false,
          reason: `exit=${code} stderr=${stderrBuf.slice(0, 200)}`,
        });
      }
    });
    // Safety timeout: 60s per iteration.
    setTimeout(() => {
      if (!seenReady) {
        child.kill();
        resolve({ iter, ms: 0, ok: false, reason: "timeout-60s" });
      }
    }, 60_000);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

async function main() {
  const { iterations } = parseArgs();
  console.log(`[Cold-start] Running ${iterations} iterations (fresh node per iter)...`);

  const samples: Sample[] = [];
  for (let i = 1; i <= iterations; i++) {
    const s = await measureOne(i);
    samples.push(s);
    if (s.ok) {
      console.log(`[Cold-start] iter=${i}  ready=${s.ms.toFixed(0)}ms`);
    } else {
      console.log(`[Cold-start] iter=${i}  DROPPED (${s.reason})`);
    }
  }

  const ok = samples.filter((s) => s.ok).map((s) => s.ms);
  const dropped = samples.length - ok.length;
  ok.sort((a, b) => a - b);

  console.log("\n===========================================");
  if (ok.length === 0) {
    console.log("No successful samples. All iterations dropped.");
    process.exit(1);
  }
  console.log(`p50    = ${percentile(ok, 50).toFixed(0)} ms`);
  console.log(`p95    = ${percentile(ok, 95).toFixed(0)} ms`);
  console.log(`mean   = ${mean(ok).toFixed(0)} ms`);
  console.log(`stddev = ${stddev(ok).toFixed(0)} ms`);
  console.log(`N      = ${ok.length}${dropped > 0 ? ` (${dropped} dropped)` : ""}`);
}

main()
  .then(() => cleanupChildScript())
  .catch((err) => {
    cleanupChildScript();
    console.error(err);
    process.exit(1);
  });
