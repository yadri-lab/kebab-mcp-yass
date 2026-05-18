/**
 * Phase 70 / Plan 01 / Task 2 — Handlers barrel (placeholder).
 *
 * Plan 02 will REPLACE this file with real handler registrations:
 *
 *   import { _handlers } from "../dispatcher";
 *   import { handleMessageReceived } from "./new-message";
 *   import { handleNewRelation }     from "./new-relation";
 *   import { handleAccountStatus }   from "./account-status";
 *
 *   _handlers.messageReceived = handleMessageReceived;
 *   _handlers.newRelation     = handleNewRelation;
 *   _handlers.accountStatus   = handleAccountStatus;
 *
 * Until then, this file is a no-op `export {};` so that the side-effect
 * import in `app/api/unipile/webhook/route.ts` resolves without error.
 * The dispatcher's default `noopHandler` (which log.warn-s) handles every
 * event in the interim.
 */
export {};
