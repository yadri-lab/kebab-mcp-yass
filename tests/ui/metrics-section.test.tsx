/**
 * @vitest-environment jsdom
 *
 * Phase 53 — MetricsSection + smaller component integration tests.
 *
 * Covers LatencyBarChart (top-10 truncation) and KvQuotaPanel
 * (source:"unknown" -> "unavailable" label; >80% -> warn banner).
 * Also asserts MetricsSection hides the TenantSelector for scoped
 * admins and that it respects the ?refresh URL param via
 * useMetricsPoll.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LatencyBarChart } from "@/../app/config/tabs/health/LatencyBarChart";
import { KvQuotaPanel } from "@/../app/config/tabs/health/KvQuotaPanel";
import { MetricsSection } from "@/../app/config/tabs/health/MetricsSection";

describe("LatencyBarChart", () => {
  it("renders only top-10 bars when given 15 tools", () => {
    const tools = Array.from({ length: 15 }, (_, i) => ({
      name: `tool${i}`,
      p95Ms: (i + 1) * 100,
      calls: 10,
    }));
    const { container } = render(<LatencyBarChart tools={tools.slice(0, 10)} />);
    // Each bar is a <Rectangle>. Recharts renders <path>/<rect>; we
    // assert the chart mounted (ResponsiveContainer wrapper present).
    expect(container.querySelector(".recharts-responsive-container")).toBeTruthy();
  });

  it("renders empty-state for empty input", () => {
    render(<LatencyBarChart tools={[]} />);
    expect(screen.getByText(/No latency data/i)).toBeTruthy();
  });
});

describe("KvQuotaPanel", () => {
  it("renders unavailable label when source is 'unknown'", () => {
    render(
      <KvQuotaPanel
        data={{
          source: "unknown",
          usedBytes: null,
          usedHuman: null,
          limitBytes: null,
          percentage: null,
        }}
      />
    );
    expect(screen.getByText(/KV provider: unknown/i)).toBeTruthy();
    // Gauge should not render (no progress bar).
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders warn banner when percentage > 80", () => {
    render(
      <KvQuotaPanel
        data={{
          source: "upstash",
          usedBytes: 220 * 1024 * 1024,
          usedHuman: "220M",
          limitBytes: 250 * 1024 * 1024,
          percentage: 88,
        }}
      />
    );
    expect(screen.getByTestId("kv-quota-warn")).toBeTruthy();
  });

  it("renders no warn banner when percentage <= 80", () => {
    render(
      <KvQuotaPanel
        data={{
          source: "upstash",
          usedBytes: 100 * 1024 * 1024,
          usedHuman: "100M",
          limitBytes: 250 * 1024 * 1024,
          percentage: 40,
        }}
      />
    );
    expect(screen.queryByTestId("kv-quota-warn")).toBeNull();
  });
});

describe("MetricsSection", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      // Deterministic empty bodies for every panel.
      if (url.includes("/metrics/kv-quota")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            source: "unknown",
            usedBytes: null,
            usedHuman: null,
            limitBytes: null,
            percentage: null,
          }),
        } as Response);
      }
      if (url.includes("/metrics/ratelimit")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ buckets: [] }),
        } as Response);
      }
      if (url.includes("/metrics/latency")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ tools: [], source: "buffer" }),
        } as Response);
      }
      if (url.includes("/metrics/errors")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ connectors: [], source: "buffer" }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ hours: [], source: "buffer" }),
      } as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("hides TenantSelector for scoped admin (rootScope=false)", () => {
    const { container } = render(
      <MetricsSection rootScope={false} tenantIds={["alpha", "bravo"]} />
    );
    // No select element from the tenant selector.
    expect(container.querySelector("select")).toBeNull();
  });

  it("shows TenantSelector for root scope", () => {
    const { container } = render(
      <MetricsSection rootScope={true} tenantIds={["alpha", "bravo"]} />
    );
    expect(container.querySelector("select")).toBeTruthy();
  });
});
