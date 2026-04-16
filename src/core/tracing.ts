/**
 * OpenTelemetry tracing facade for MyMCP.
 *
 * Uses `@opentelemetry/api` as a facade only — if no SDK is registered
 * (the default), all operations are no-ops with zero overhead. When a
 * user installs the full OTel SDK and configures an exporter, our spans
 * automatically flow through their pipeline.
 *
 * Activation: spans are only created when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set. Without it, `startToolSpan` returns a no-op sentinel and
 * `endToolSpan` is a no-op.
 */

import type { Span } from "@opentelemetry/api";

const TRACER_NAME = "mymcp";

/** Sentinel returned when tracing is disabled — all methods are no-ops. */
const NOOP_SPAN: NoopSpan = {
  __noop: true,
};

export interface NoopSpan {
  __noop: true;
}

export type ToolSpan = Span | NoopSpan;

function isNoopSpan(span: ToolSpan): span is NoopSpan {
  return (span as NoopSpan).__noop === true;
}

function isTracingEnabled(): boolean {
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/**
 * Start a span for a tool invocation.
 *
 * Returns a no-op sentinel when tracing is disabled (no env var set) or
 * when `@opentelemetry/api` is not available.
 */
export function startToolSpan(toolName: string, connectorId: string, argKeys: string[]): ToolSpan {
  if (!isTracingEnabled()) return NOOP_SPAN;

  try {
    // Dynamic import avoidance: require at call time so the module
    // loads only when tracing is actually enabled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const tracer = api.trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(`tool.${toolName}`, {
      attributes: {
        "mymcp.tool.name": toolName,
        "mymcp.connector.id": connectorId,
        "mymcp.args.keys": JSON.stringify(argKeys),
      },
    });
    return span;
  } catch {
    // @opentelemetry/api not installed or not resolvable — silent no-op.
    return NOOP_SPAN;
  }
}

/**
 * End a tool span with status and duration.
 */
export function endToolSpan(
  span: ToolSpan,
  status: "ok" | "error",
  durationMs: number,
  upstreamCallCount?: number
): void {
  if (isNoopSpan(span)) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const realSpan = span as Span;
    realSpan.setAttribute("mymcp.duration_ms", durationMs);
    realSpan.setAttribute("mymcp.status", status);
    if (upstreamCallCount !== undefined) {
      realSpan.setAttribute("mymcp.upstream_call_count", upstreamCallCount);
    }
    if (status === "error") {
      realSpan.setStatus({ code: api.SpanStatusCode.ERROR });
    } else {
      realSpan.setStatus({ code: api.SpanStatusCode.OK });
    }
    realSpan.end();
  } catch {
    // Swallow — tracing must never break tool execution.
  }
}
