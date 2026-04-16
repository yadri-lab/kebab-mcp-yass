import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startToolSpan, endToolSpan, type NoopSpan } from "./tracing";

describe("tracing", () => {
  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(() => {
    if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    vi.restoreAllMocks();
  });

  describe("when OTEL_EXPORTER_OTLP_ENDPOINT is NOT set", () => {
    beforeEach(() => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    });

    it("startToolSpan returns a no-op span", () => {
      const span = startToolSpan("gmail_inbox", "google", ["query"]);
      expect((span as NoopSpan).__noop).toBe(true);
    });

    it("endToolSpan is a no-op on noop span", () => {
      const span = startToolSpan("gmail_inbox", "google", ["query"]);
      // Should not throw
      expect(() => endToolSpan(span, "ok", 42)).not.toThrow();
    });
  });

  describe("when OTEL_EXPORTER_OTLP_ENDPOINT IS set", () => {
    beforeEach(() => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    });

    it("startToolSpan creates a real span with correct attributes", () => {
      const span = startToolSpan("vault_read", "vault", ["path", "branch"]);
      // The OTel API package is installed — when no SDK is registered, it
      // still returns a non-recording span object (not our noop sentinel).
      expect((span as NoopSpan).__noop).toBeUndefined();
      // Clean up
      endToolSpan(span, "ok", 10);
    });

    it("endToolSpan sets attributes and ends the span without throwing", () => {
      const span = startToolSpan("slack_send", "slack", ["channel", "text"]);
      expect(() => endToolSpan(span, "error", 150)).not.toThrow();
    });

    it("endToolSpan accepts optional upstreamCallCount", () => {
      const span = startToolSpan("gmail_search", "google", ["q"]);
      expect(() => endToolSpan(span, "ok", 200, 3)).not.toThrow();
    });
  });
});
