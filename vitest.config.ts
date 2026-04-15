import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // first-run tests share OS /tmp paths; run files sequentially to avoid
    // cross-worker races on BOOTSTRAP_PATH.
    fileParallelism: false,
    // v0.6 NIT-05: tests historically relied on `http://localhost/...`
    // URLs being recognized as loopback. Production now requires explicit
    // opt-in via MYMCP_TRUST_URL_HOST=1. Set it for the test environment
    // so legacy tests keep their original semantics without rewriting
    // every fixture to add an x-forwarded-for header.
    env: {
      MYMCP_TRUST_URL_HOST: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
