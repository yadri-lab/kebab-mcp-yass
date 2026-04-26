/**
 * Phase 063 CRON-03 — Refresh icon UI test.
 *
 * Asserts:
 *   - Banner renders 'checked Xh ago' when checkedAt is present in payload
 *   - Refresh button (aria-label="Refresh update check") is rendered
 *   - Click triggers fetch('/api/config/update?force=1')
 *   - Button is disabled while in-flight (debounce + refreshing flag)
 *   - Second click while disabled does NOT trigger another fetch
 *
 * W3 fix: uses `vi.useFakeTimers({ toFake: ["Date"] })` so the
 * 30s debounce assertion is deterministic — only the Date constructor
 * is faked, microtasks (used by RTL waitFor) stay real.
 */
/// <reference lib="dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OverviewTab } from "@/../app/config/tabs/overview";

function defaultProps() {
  return {
    baseUrl: "http://localhost",
    totalTools: 0,
    enabledCount: 0,
    connectorCount: 0,
    logs: [],
    config: { displayName: "Test", timezone: "UTC", locale: "en-US" } as never,
    version: "0.15.0",
    commitSha: undefined,
    tenantId: null,
  };
}

describe("OverviewTab Refresh icon (CRON-03)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const NOW = new Date("2026-04-26T12:00:00Z").getTime();

  beforeEach(() => {
    // W3 fix: freeze Date.now() so the debounce assertion is deterministic.
    // Use the narrow `toFake: ["Date"]` form to avoid faking setTimeout
    // (React Testing Library's waitFor uses real microtasks).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders 'checked Xh ago' indicator and Refresh button when checkedAt is present", async () => {
    const oneHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    // Initial GET /api/config/update returns up-to-date with checkedAt
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: "github-api",
          available: false,
          behind_by: 0,
          ahead_by: 0,
          status: "identical",
          breaking: false,
          breakingReasons: [],
          commits: [],
          totalCommits: 0,
          tokenConfigured: true,
          forkPrivate: false,
          checkedAt: oneHourAgo,
        })
      )
    );

    render(<OverviewTab {...defaultProps()} />);

    await waitFor(() => {
      expect(screen.getByText(/Up to date with upstream/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/1h ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh update check/i })).toBeInTheDocument();
  });

  it("clicking Refresh fetches /api/config/update?force=1", async () => {
    const oneHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: "github-api",
          available: false,
          behind_by: 0,
          ahead_by: 0,
          status: "identical",
          breaking: false,
          breakingReasons: [],
          commits: [],
          totalCommits: 0,
          tokenConfigured: true,
          forkPrivate: false,
          checkedAt: oneHourAgo,
        })
      )
    );
    // Second call (refresh) — fresh response
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: "github-api",
          available: false,
          behind_by: 0,
          ahead_by: 0,
          status: "identical",
          breaking: false,
          breakingReasons: [],
          commits: [],
          totalCommits: 0,
          tokenConfigured: true,
          forkPrivate: false,
          checkedAt: new Date(NOW).toISOString(),
        })
      )
    );

    render(<OverviewTab {...defaultProps()} />);

    const btn = await screen.findByRole("button", { name: /refresh update check/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const secondCallUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondCallUrl).toContain("/api/config/update?force=1");
  });

  it("disables the Refresh button while a refresh is in-flight", async () => {
    const oneHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: "github-api",
          available: false,
          behind_by: 0,
          ahead_by: 0,
          status: "identical",
          breaking: false,
          breakingReasons: [],
          commits: [],
          totalCommits: 0,
          tokenConfigured: true,
          forkPrivate: false,
          checkedAt: oneHourAgo,
        })
      )
    );
    // Second fetch hangs forever — button must remain disabled
    let resolveSecond: ((v: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        })
    );

    render(<OverviewTab {...defaultProps()} />);

    const btn = await screen.findByRole("button", { name: /refresh update check/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
    });
    // Second click should NOT trigger a third fetch (frozen clock keeps debounce active)
    fireEvent.click(btn);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Cleanup: resolve the hung promise so the test runner doesn't leak
    resolveSecond?.(
      new Response(
        JSON.stringify({
          mode: "github-api",
          available: false,
          status: "identical",
          checkedAt: new Date(NOW).toISOString(),
          tokenConfigured: true,
        })
      )
    );
  });
});
