/**
 * Phase 70 / Plan 02 / Task 2 — Handlers barrel (side-effect registration).
 *
 * Importing this module wires the 3 real webhook handlers into the
 * dispatcher's mutable `_handlers` hook table. The route does the
 * side-effect import:
 *
 *   import "@/connectors/unipile/webhook/handlers";
 *
 * After this side-effect runs, `dispatchEventAsync` invokes the real
 * handlers instead of the Plan 70-01 noop stubs.
 *
 * Why a barrel and not direct cross-imports inside `dispatcher.ts`:
 *   - Avoids a cyclic import (handlers depend on
 *     `dispatcher.resolveTenantFromAccountId`; dispatcher would
 *     otherwise depend on the handler modules).
 *   - Lets Plan 70-01 ship + be unit-testable BEFORE Plan 70-02 writes
 *     the real handlers — dispatcher tests stub `_handlers.X` directly.
 *   - This module is the single place that pulls both sides together.
 *
 * Module-load side effect: the three assignments below run exactly once
 * (Node module cache deduplicates), so importing the barrel from
 * multiple places is safe.
 */
import { _handlers } from "../dispatcher";
import { handleAccountStatus } from "./account-status";
import { handleNewRelation } from "./new-relation";
import { handleMessageReceived } from "./new-message";

_handlers.accountStatus = handleAccountStatus;
_handlers.newRelation = handleNewRelation;
_handlers.messageReceived = handleMessageReceived;

export {};
