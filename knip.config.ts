import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["app/**/*.{ts,tsx}", "src/**/*.ts"],
  project: ["app/**/*.{ts,tsx}", "src/**/*.ts"],
  ignoreDependencies: [
    // @opentelemetry/sdk-node provides sdk-trace-node, sdk-trace-base, resources
    // as transitive deps. tracing.ts imports from sub-packages via dynamic require.
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/resources",
    // postcss is a transitive dep of @tailwindcss/postcss, loaded via config
    "postcss",
    // Tailwind v4 loaded via CSS @import, not a JS import
    "tailwindcss",
    // Testing libs used in test files (excluded from entry points by knip's defaults)
    "@testing-library/jest-dom",
    "@testing-library/user-event",
  ],
  ignoreBinaries: [
    // tsx is invoked via npx in package.json scripts
    "tsx",
  ],
};

export default config;
