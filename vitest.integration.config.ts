import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Separate vitest config for integration tests.
 *
 * Integration tests start a real Next.js server and hit HTTP endpoints.
 * They require `npm run build` to have been run first.
 *
 * Run via: npm run test:integration
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
