/**
 * Component test setup — imported by each component test file.
 *
 * Provides:
 * - @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Automatic DOM cleanup between tests
 * - Global fetch mock (returns empty JSON by default), restored after each test
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

const _originalFetch = globalThis.fetch;

// Mock fetch before each test, restore after
beforeEach(() => {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response)
  );
});

// Ensure DOM is cleaned up and fetch restored between tests
afterEach(() => {
  cleanup();
  globalThis.fetch = _originalFetch;
});
