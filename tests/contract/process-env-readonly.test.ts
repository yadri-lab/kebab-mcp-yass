/**
 * Contract test: process.env may only be assigned to from allowlisted
 * files. Defense in depth on top of the ESLint `no-restricted-syntax`
 * rule — a disgruntled `// eslint-disable-next-line` still fails this
 * grep-style test.
 *
 * Allowlist matches the ESLint override in eslint.config.mjs:
 *  - src/core/env-store.ts (dashboard save — transitional, v0.11 removes)
 *  - app/api/storage/migrate/route.ts (admin migration endpoint)
 *  - scripts/**
 *  - tests/** + *.test.ts / *.e2e.test.ts + test-utils
 *  - playwright.config.ts
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ALLOWLIST_PREFIXES = [
  "src/core/env-store.ts",
  "app/api/storage/migrate/route.ts",
  "scripts/",
  "tests/",
  "playwright.config.ts",
  "src/core/test-utils.ts",
];

// Also allow any *.test.ts / *.e2e.test.ts file wherever it lives.
function isTestFile(rel: string): boolean {
  return rel.endsWith(".test.ts") || rel.endsWith(".e2e.test.ts");
}

function isAllowlisted(rel: string): boolean {
  if (isTestFile(rel)) return true;
  return ALLOWLIST_PREFIXES.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

const SCAN_ROOTS = ["src", "app"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      out.push(full);
    }
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

// `process.env.X = ...`
const DOT_ASSIGN_RE = /process\.env\.[A-Z_][A-Z0-9_]*\s*=(?!=)/;
// `process.env[k] = ...`
const BRACKET_ASSIGN_RE = /process\.env\[[^\]]+\]\s*=(?!=)/;

describe("process.env readonly contract (SEC-02)", () => {
  it("process.env is only assigned from allowlisted files", () => {
    const projectRoot = join(__dirname, "..", "..");
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walk(join(projectRoot, root), files);
    }

    const violations: { file: string; line: number; text: string }[] = [];
    for (const abs of files) {
      const rel = toPosix(relative(projectRoot, abs));
      if (isAllowlisted(rel)) continue;
      const contents = readFileSync(abs, "utf-8");
      const lines = contents.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (DOT_ASSIGN_RE.test(line) || BRACKET_ASSIGN_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: trimmed });
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `process.env assignment(s) detected outside the allowlist. These are ` +
          `concurrency-unsafe on warm lambdas (SEC-02).\n\n${summary}\n\n` +
          `Fix: replace with runWithCredentials({ KEY: value }, () => ...) from ` +
          `@/core/request-context. If the callsite is legitimately a one-shot ` +
          `boot-path write, add it to the allowlist in tests/contract/` +
          `process-env-readonly.test.ts AND to the ESLint override in ` +
          `eslint.config.mjs.`
      );
    }

    expect(violations).toEqual([]);
  });
});
