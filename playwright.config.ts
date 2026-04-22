import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env so tests can read MCP_AUTH_TOKEN for dashboard auth
try {
  const envFile = readFileSync(resolve(__dirname, ".env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  }
} catch {
  // No .env file — tests use fallback tokens
}

// Phase 49 / exactOptionalPropertyTypes: webServer + storageState are
// omitted entirely in the CI/e2e branches rather than set to undefined
// — Playwright's TestConfig types don't accept `undefined` as a value
// under the strict flag, so we build the config conditionally.
export default defineConfig({
  // Root testDir unused — each project below declares its own testDir.
  // Kept for back-compat with bare `npx playwright test` invocations
  // that don't pass --project.
  testDir: "tests/visual",
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    // Headless by default
    headless: true,
  },
  // Don't start a dev server automatically — caller must provide one.
  // Run `npm run dev` in a separate terminal, or set PLAYWRIGHT_BASE_URL.
  ...(process.env.CI
    ? {}
    : {
        webServer: {
          command: "npm run dev",
          port: 3000,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
  projects: [
    // Visual regression project — snapshot-based, read-only. Unchanged.
    {
      name: "visual",
      testDir: "tests/visual",
      use: { browserName: "chromium" },
    },
    // Kept as an alias so the pre-existing `--project=chromium` invocation
    // still works for anyone who scripted it before the rename.
    {
      name: "chromium",
      testDir: "tests/visual",
      use: { browserName: "chromium" },
    },
    // E2E project (TEST-02) — state-mutating, black-box. Different test
    // dir + no storageState reuse (each test resets cookies/KV).
    {
      name: "e2e",
      testDir: "tests/e2e",
      retries: process.env.CI ? 1 : 0,
      use: {
        browserName: "chromium",
      },
    },
  ],
});
