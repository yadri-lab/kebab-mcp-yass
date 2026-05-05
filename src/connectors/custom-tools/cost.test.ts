import { describe, it, expect } from "vitest";
import { estimateToolCost, getMaxCostPerRun, type CostRegistry } from "./cost";
import type { CustomTool, CustomToolWriteInput } from "./types";

/**
 * Cost estimator unit tests.
 *
 * The estimator is decoupled from the registry — it takes a flat
 * `name → packId` map plus a `id → CustomTool` map for recursion.
 * That lets us assert behaviour without standing up the full
 * registry / KV stack.
 */

function makeRegistry(
  toolPacks: Record<string, string>,
  customTools: Array<CustomTool | CustomToolWriteInput> = []
): CostRegistry {
  const knownTools = new Map<string, { packId: string }>();
  for (const [name, packId] of Object.entries(toolPacks)) {
    knownTools.set(name, { packId });
  }
  const customToolsById = new Map<string, CustomTool | CustomToolWriteInput>();
  for (const t of customTools) customToolsById.set(t.id, t);
  return { knownTools, customToolsById };
}

function makeTool(id: string, steps: CustomToolWriteInput["steps"]): CustomToolWriteInput {
  return {
    id,
    description: "test tool",
    destructive: false,
    inputs: [],
    steps,
  };
}

describe("estimateToolCost", () => {
  it("returns 0 for a transform-only tool (5 transforms)", () => {
    const tool = makeTool("transforms_only", [
      { kind: "transform", template: "a", saveAs: "a" },
      { kind: "transform", template: "b", saveAs: "b" },
      { kind: "transform", template: "c", saveAs: "c" },
      { kind: "transform", template: "d", saveAs: "d" },
      { kind: "transform", template: "e", saveAs: "e" },
    ]);
    const reg = makeRegistry({});
    expect(estimateToolCost(tool, reg)).toBe(0);
  });

  it("sums per-pack cost for mixed steps (2 vault + 1 slack = 1+1+2 = 4)", () => {
    const tool = makeTool("mixed", [
      { kind: "tool", toolName: "vault_read", args: {} },
      { kind: "tool", toolName: "vault_write", args: {} },
      { kind: "tool", toolName: "slack_send_message", args: {} },
    ]);
    const reg = makeRegistry({
      vault_read: "vault",
      vault_write: "vault",
      slack_send_message: "slack",
    });
    expect(estimateToolCost(tool, reg)).toBe(4);
  });

  it("includes transforms (cost 0) interleaved with tool steps", () => {
    const tool = makeTool("interleaved", [
      { kind: "transform", template: "{{x}}", saveAs: "y" },
      { kind: "tool", toolName: "vault_read", args: {} },
      { kind: "transform", template: "z", saveAs: "z" },
      { kind: "tool", toolName: "slack_send_message", args: {} },
    ]);
    const reg = makeRegistry({
      vault_read: "vault",
      slack_send_message: "slack",
    });
    expect(estimateToolCost(tool, reg)).toBe(3); // 0 + 1 + 0 + 2
  });

  it("flags a 6× browser tool as over-cost (60 > 50 cap)", () => {
    const tool = makeTool("browser_heavy", [
      { kind: "tool", toolName: "web_agent", args: {} },
      { kind: "tool", toolName: "web_agent", args: {} },
      { kind: "tool", toolName: "web_agent", args: {} },
      { kind: "tool", toolName: "web_agent", args: {} },
      { kind: "tool", toolName: "web_agent", args: {} },
      { kind: "tool", toolName: "web_agent", args: {} },
    ]);
    const reg = makeRegistry({ web_agent: "browser" });
    const cost = estimateToolCost(tool, reg);
    expect(cost).toBe(60);
    expect(cost).toBeGreaterThan(getMaxCostPerRun());
  });

  it("composes cost recursively when one Custom Tool calls another", () => {
    // Inner: 2 slack + 1 vault → 2 + 2 + 1 = 5
    const inner: CustomToolWriteInput = makeTool("inner_ct", [
      { kind: "tool", toolName: "slack_send_message", args: {} },
      { kind: "tool", toolName: "slack_search", args: {} },
      { kind: "tool", toolName: "vault_read", args: {} },
    ]);
    // Outer: 1 vault + 1 (call to inner CT) → 1 + 5 = 6
    const outer: CustomToolWriteInput = makeTool("outer_ct", [
      { kind: "tool", toolName: "vault_read", args: {} },
      { kind: "tool", toolName: "inner_ct", args: {} },
    ]);
    const reg = makeRegistry(
      {
        slack_send_message: "slack",
        slack_search: "slack",
        vault_read: "vault",
        inner_ct: "custom-tools",
      },
      [inner, outer]
    );
    expect(estimateToolCost(outer, reg)).toBe(6);
  });

  it("guards against A→B→A cycles without stack overflow (returns bounded cost)", () => {
    // A calls B, B calls A. The estimator should return without
    // throwing, with a finite cost — the runner's own recursion
    // guard refuses to actually execute the cycle.
    const a: CustomToolWriteInput = makeTool("ct_a", [
      { kind: "tool", toolName: "vault_read", args: {} },
      { kind: "tool", toolName: "ct_b", args: {} },
    ]);
    const b: CustomToolWriteInput = makeTool("ct_b", [
      { kind: "tool", toolName: "slack_send_message", args: {} },
      { kind: "tool", toolName: "ct_a", args: {} },
    ]);
    const reg = makeRegistry(
      {
        vault_read: "vault",
        slack_send_message: "slack",
        ct_a: "custom-tools",
        ct_b: "custom-tools",
      },
      [a, b]
    );
    // Estimating A: vault(1) + B { slack(2) + A_cycle(0) } = 3
    expect(estimateToolCost(a, reg)).toBe(3);
    // Estimating B: slack(2) + A { vault(1) + B_cycle(0) } = 3
    expect(estimateToolCost(b, reg)).toBe(3);
  });

  it("charges 1 (over-allow) for unknown toolName so cost.ts doesn't double-error", () => {
    // The store.ts toolName validator already rejects unknown
    // toolNames as a hard error; cost.ts intentionally over-allows
    // here so it stays decoupled.
    const tool = makeTool("unknown_tool", [
      { kind: "tool", toolName: "definitely_not_a_tool", args: {} },
    ]);
    const reg = makeRegistry({});
    expect(estimateToolCost(tool, reg)).toBe(1);
  });

  it("charges MAX_COST_PER_RUN for a forward reference to an undeclared Custom Tool", () => {
    // step references a custom-tools pack tool that has no row in
    // customToolsById — without this the estimator would silently
    // approve it. Charge the cap so the write is rejected.
    const tool = makeTool("forward_ref", [{ kind: "tool", toolName: "ghost_ct", args: {} }]);
    const reg = makeRegistry({ ghost_ct: "custom-tools" }, []);
    const cost = estimateToolCost(tool, reg);
    expect(cost).toBe(getMaxCostPerRun());
  });

  it("caps deeply-nested chains at MAX_COST_PER_RUN past depth 3", () => {
    // Build a chain A→B→C→D→E where each step adds a tool call to
    // the next CT. Past depth 3 the estimator returns the cap so a
    // deeply nested chain is rejected rather than approved.
    const e = makeTool("e_ct", [{ kind: "tool", toolName: "vault_read", args: {} }]);
    const d = makeTool("d_ct", [{ kind: "tool", toolName: "e_ct", args: {} }]);
    const c = makeTool("c_ct", [{ kind: "tool", toolName: "d_ct", args: {} }]);
    const b = makeTool("b_ct", [{ kind: "tool", toolName: "c_ct", args: {} }]);
    const a = makeTool("a_ct", [{ kind: "tool", toolName: "b_ct", args: {} }]);
    const reg = makeRegistry(
      {
        vault_read: "vault",
        e_ct: "custom-tools",
        d_ct: "custom-tools",
        c_ct: "custom-tools",
        b_ct: "custom-tools",
      },
      [e, d, c, b, a]
    );
    const cost = estimateToolCost(a, reg);
    expect(cost).toBeGreaterThanOrEqual(getMaxCostPerRun());
  });
});
