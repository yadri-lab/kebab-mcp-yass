/**
 * Custom Tools — write-time cost estimator.
 *
 * Phase 2 of the Custom Tools security/cost work. The runner already
 * caps step count at 32 and applies per-step + total timeouts (see
 * runner.ts), but a 32-step tool that calls `web_agent` 32 times can
 * still spend a significant amount of LLM budget per run. This file
 * lets us assign a coarse-grained cost-per-pack (1–10 points), sum
 * them across the steps, and reject writes whose estimated cost
 * exceeds `MAX_COST_PER_RUN` (default 50, env-overridable).
 *
 * The numbers are deliberately heuristic — the goal is to flag the
 * "32× headless browser" footgun at write time, not to be a precise
 * billing oracle. Authors who hit the cap are pointed at the message
 * with the offending count and the concrete remediation: reduce step
 * count, or use cheaper tools.
 *
 * Recursion: a Custom Tool that invokes another Custom Tool inherits
 * the inner tool's cost (recursive estimation, capped at 3 levels).
 * Beyond the cap we conservatively charge `MAX_COST_PER_RUN` so that
 * a deeply-nested chain is rejected rather than silently approved.
 *
 * Cycles (A→B→A) are guarded with a `visiting: Set<string>` and
 * return 0 for the second visit — the first visit already counted
 * the cost; the runner's own recursion guard will refuse to actually
 * execute the cycle.
 */

import { getConfigInt } from "@/core/config-facade";
import type { CustomTool, CustomToolWriteInput } from "./types";

/**
 * Cost-per-step for each pack. Numbers picked to make:
 *  - a single browser/web_agent run cost ~10 (one-shot is fine, but
 *    six in a row hits the cap)
 *  - a moderate composition (5–10 vault/slack/google ops) stay well
 *    under the cap
 *  - api-connections / webhook dirt cheap so authors aren't
 *    penalised for HTTP plumbing
 *
 * Unknown packs default to 1 (see `costForPack`) — over-allow rather
 * than block authors when a new connector ships before this table
 * is updated.
 */
const COST_BY_PACK: Record<string, number> = {
  browser: 10, // headless browser, $$ per step
  composio: 5, // can include LLM-backed Composio tools
  paywall: 3, // remote scraping, network-bound
  apify: 5, // remote actor runs
  webhook: 2, // outbound HTTP
  slack: 2,
  google: 2,
  gmail: 2,
  notion: 2,
  github: 2,
  linear: 2,
  airtable: 2,
  "api-connections": 2,
  vault: 1,
  "custom-tools": 0, // recursive cost computed by composing
};

/**
 * Transforms are pure Mustache — no I/O, no LLM. They cost zero
 * regardless of count (the step-count cap in runner.ts already
 * bounds them at 32).
 */
const TRANSFORM_COST = 0;

/**
 * Default per-run cost cap. A typical "useful" Custom Tool sits at
 * 4–20 points; 50 is generous enough that legitimate 5-step tools
 * with a browser call still pass, but tight enough that the
 * 32×web_agent footgun is rejected outright.
 *
 * Override with `CUSTOM_TOOLS_MAX_COST_PER_RUN` env var.
 */
const DEFAULT_MAX_COST_PER_RUN = 50;

export function getMaxCostPerRun(): number {
  const fromEnv = getConfigInt("CUSTOM_TOOLS_MAX_COST_PER_RUN", DEFAULT_MAX_COST_PER_RUN);
  return fromEnv > 0 ? fromEnv : DEFAULT_MAX_COST_PER_RUN;
}

/**
 * Hard recursion cap on Custom-Tool-calls-Custom-Tool composition.
 * Beyond this depth we treat the inner call as MAX_COST_PER_RUN so
 * the outer write is forced to surface the issue rather than rely
 * on a deeply-nested chain hiding cost from the validator.
 */
const MAX_RECURSION_DEPTH = 3;

/**
 * Minimal shape we need from a registry tool fact. The store passes
 * its ToolFacts map (`name → { packId, destructive }`); we only
 * read `packId`. Decoupling the type lets cost.ts be unit-tested
 * without standing up the registry.
 */
export interface CostToolFact {
  packId: string;
}

export interface CostRegistry {
  /** name → { packId } for every callable tool. */
  knownTools: Map<string, CostToolFact>;
  /** id → CustomTool for every persisted Custom Tool (used for recursion). */
  customToolsById: Map<string, CustomTool | CustomToolWriteInput>;
}

function costForPack(packId: string): number {
  const v = COST_BY_PACK[packId];
  return typeof v === "number" ? v : 1;
}

/**
 * Estimate the cost of one Custom Tool, summed across its steps.
 *
 * For each step:
 *  - `transform` → +TRANSFORM_COST (0)
 *  - `tool` step that resolves to a Custom Tool → recurse, with a
 *    visiting set to break cycles and a depth counter to bound the
 *    walk
 *  - `tool` step that resolves to a regular pack → +costForPack
 *  - `tool` step whose toolName isn't in the registry → +1 (unknown,
 *    over-allow; the toolName validator in store.ts already rejects
 *    these on write)
 */
export function estimateToolCost(
  tool: CustomTool | CustomToolWriteInput,
  registry: CostRegistry
): number {
  return estimateInternal(tool, registry, new Set<string>(), 0);
}

function estimateInternal(
  tool: CustomTool | CustomToolWriteInput,
  registry: CostRegistry,
  visiting: Set<string>,
  depth: number
): number {
  // Cycle guard — the runner refuses to execute A→B→A anyway, so
  // we charge 0 for the re-entry; the first visit already accounted
  // for the cost.
  if (visiting.has(tool.id)) return 0;

  // Depth cap — beyond MAX_RECURSION_DEPTH we conservatively bill
  // the full cap so the outer write is rejected rather than
  // silently approved with a deeply-nested chain.
  if (depth > MAX_RECURSION_DEPTH) {
    return getMaxCostPerRun();
  }

  visiting.add(tool.id);
  let total = 0;
  for (const step of tool.steps) {
    if (step.kind === "transform") {
      total += TRANSFORM_COST;
      continue;
    }
    // step.kind === "tool"
    const fact = registry.knownTools.get(step.toolName);
    if (!fact) {
      // toolName not in registry — write-time validator in store.ts
      // catches this as a hard error; here we just over-allow with a
      // unit cost so cost.ts stays decoupled from that validation.
      total += 1;
      continue;
    }
    if (fact.packId === "custom-tools") {
      const inner = registry.customToolsById.get(step.toolName);
      if (!inner) {
        // Custom Tool referenced but not yet persisted (e.g. forward
        // reference in a fresh KV). Charge the cap to force the
        // author to either create it first or restructure.
        total += getMaxCostPerRun();
        continue;
      }
      total += estimateInternal(inner, registry, visiting, depth + 1);
      continue;
    }
    total += costForPack(fact.packId);
  }
  visiting.delete(tool.id);
  return total;
}

/**
 * Test-only: expose the cost table for assertion / docs.
 * Not part of the public API but useful for the unit tests.
 */
export const _COST_BY_PACK_FOR_TESTS = COST_BY_PACK;
export const _TRANSFORM_COST_FOR_TESTS = TRANSFORM_COST;
