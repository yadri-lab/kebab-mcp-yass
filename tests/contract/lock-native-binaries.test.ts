/**
 * Contract test: package-lock.json MUST contain Linux-x64 native binaries
 * for the build toolchain.
 *
 * Why this exists (2026-04-29):
 *   v0.16 hit a CI rabbit-hole because npm on Windows omits foreign-platform
 *   `optionalDependencies` from the lockfile by default. When a contributor
 *   runs `npm install` on Windows and commits the regenerated lock, CI on
 *   Ubuntu fails with:
 *     "Cannot find module ../lightningcss.linux-x64-gnu.node"
 *     "Cannot find module @tailwindcss/oxide-linux-x64-gnu"
 *     "Cannot find module @next/swc-linux-x64-gnu"
 *
 *   The previous workaround was to add these as explicit
 *   `optionalDependencies` in package.json. This test enforces that they
 *   actually land in the committed lockfile so we catch the divergence
 *   pre-merge instead of mid-CI.
 *
 *   To regenerate the lock with all platforms in scope (recommended after
 *   bumping next/tailwind/lightningcss):
 *     - On Linux/macOS:  `npm install --package-lock-only`
 *     - On Windows:      `bash scripts/regen-lock-linux.sh` (uses Docker)
 *
 *   Bypass: if you genuinely need to drop a binary (e.g. the project no
 *   longer builds with Tailwind), update REQUIRED_BINARIES below and
 *   document why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_BINARIES = [
  "lightningcss-linux-x64-gnu",
  "@next/swc-linux-x64-gnu",
  "@tailwindcss/oxide-linux-x64-gnu",
];

describe("contract: package-lock.json includes Linux-x64 native binaries", () => {
  const lockPath = join(process.cwd(), "package-lock.json");
  const lockText = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(lockText) as {
    packages?: Record<string, { version?: string; os?: string[] }>;
  };

  for (const bin of REQUIRED_BINARIES) {
    it(`contains node_modules/${bin}`, () => {
      const key = `node_modules/${bin}`;
      const entry = lock.packages?.[key];
      expect(
        entry,
        `package-lock.json is missing "${key}". This means \`npm ci\` on Linux ` +
          `will fail to install the native binary, and CI will error with ` +
          `"Cannot find module".\n\n` +
          `Fix: regenerate the lock with all platforms in scope.\n` +
          `  - On Linux/macOS:  npm install --package-lock-only\n` +
          `  - On Windows:      bash scripts/regen-lock-linux.sh (Docker required)\n\n` +
          `Then commit the updated package-lock.json.`
      ).toBeDefined();
      expect(entry?.version, `${key} has no version pinned`).toBeTruthy();
    });
  }
});
