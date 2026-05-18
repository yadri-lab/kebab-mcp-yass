/**
 * Phase 70 / Plan 02 / Task 2 — handlers/index.ts barrel registration test.
 *
 * The barrel is a side-effect module: importing it MUST assign the 3 real
 * handlers into the dispatcher's `_handlers` table. This test verifies
 * the wiring by importing the dispatcher AFTER the barrel and asserting
 * that each hook is no longer the default noop (i.e. the handler the
 * barrel assigned matches the named export from the per-event module).
 */
import { describe, it, expect } from "vitest";

describe("handlers/index.ts barrel — dispatcher hook registration", () => {
  it("registers all 3 handlers on _handlers (assigned to the named exports)", async () => {
    const { _handlers } = await import("../../dispatcher");
    // Side-effect import — this is the real wire-up the route does.
    await import("../index");
    const accountStatusMod = await import("../account-status");
    const newRelationMod = await import("../new-relation");
    const newMessageMod = await import("../new-message");

    expect(_handlers.accountStatus).toBe(accountStatusMod.handleAccountStatus);
    expect(_handlers.newRelation).toBe(newRelationMod.handleNewRelation);
    expect(_handlers.messageReceived).toBe(newMessageMod.handleMessageReceived);
  });
});
