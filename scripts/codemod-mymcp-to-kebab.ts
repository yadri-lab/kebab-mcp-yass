/**
 * Codemod: replace getConfig("MYMCP_*") and getConfigInt("MYMCP_*", ...)
 * with their KEBAB_* equivalents in src/ and app/.
 *
 * The config-facade already handles KEBAB_→MYMCP_ fallback (resolveAlias),
 * so this rename is safe: existing MYMCP_* env vars keep working until
 * operators migrate.
 *
 * Usage:
 *   pnpm tsx scripts/codemod-mymcp-to-kebab.ts          # dry run (default)
 *   pnpm tsx scripts/codemod-mymcp-to-kebab.ts --write  # apply
 *
 * Excluded:
 *   tests/**             — assert the MYMCP_ fallback explicitly
 *   src/core/config-facade.ts — owns the alias resolution
 *   src/core/constants/brand.ts — owns the literal strings
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PROJECT_ROOT = join(__dirname, "..");
const WRITE = process.argv.includes("--write");
const SCAN_ROOTS = ["src", "app"];
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);
const EXCLUDE_FILES = new Set(["src/core/config-facade.ts", "src/core/constants/brand.ts"]);

// Matches getConfig("MYMCP_FOO") or getConfigInt("MYMCP_FOO", default)
// Captures the quote char and the suffix after MYMCP_
const RE = /(getConfig(?:Int)?)\(\s*(['"])MYMCP_([A-Z][A-Z0-9_]*)\2/g;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

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
    } else if (
      st.isFile() &&
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
}

let totalFiles = 0;
let totalRewrites = 0;

for (const root of SCAN_ROOTS) {
  const files: string[] = [];
  walk(join(PROJECT_ROOT, root), files);

  for (const abs of files) {
    const rel = toPosix(relative(PROJECT_ROOT, abs));
    if (EXCLUDE_FILES.has(rel)) continue;

    const original = readFileSync(abs, "utf-8");
    const rewritten = original.replace(
      RE,
      (_match, fn, quote, suffix) => `${fn}(${quote}KEBAB_${suffix}${quote}`
    );

    if (rewritten !== original) {
      totalFiles++;
      const matches = [...original.matchAll(RE)];
      totalRewrites += matches.length;

      if (WRITE) {
        writeFileSync(abs, rewritten, "utf-8");
        console.log(`  [write] ${rel} (${matches.length} rewrite(s))`);
      } else {
        console.log(`  [dry]   ${rel} (${matches.length} rewrite(s)):`);
        for (const m of matches) {
          console.log(`            ${m[0]} → ${m[1]}("KEBAB_${m[3]}${m[2]}`);
        }
      }
    }
  }
}

console.log(
  `\n${WRITE ? "Applied" : "Dry run"}: ${totalRewrites} rewrite(s) across ${totalFiles} file(s).`
);
if (!WRITE) {
  console.log("Run with --write to apply.");
}
