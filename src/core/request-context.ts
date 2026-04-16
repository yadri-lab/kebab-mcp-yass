/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * Allows tool handlers to access per-request data (like tenantId)
 * without threading it through every function signature. The transport
 * route wraps each request in `requestContext.run(...)` so tool handlers
 * can call `getCurrentTenantId()` to get the tenant for KV isolation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getTenantKVStore, type KVStore } from "./kv-store";

export interface RequestContextData {
  tenantId: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContextData>();

/**
 * Get the tenant ID from the current request context.
 * Returns null if no context is active (default tenant).
 */
export function getCurrentTenantId(): string | null {
  return requestContext.getStore()?.tenantId ?? null;
}

/**
 * Get a KV store scoped to the current request's tenant.
 * Replaces direct `getKVStore()` calls in tool handlers — ensures
 * tenant isolation is respected when a tenantId is present.
 */
export function getContextKVStore(): KVStore {
  return getTenantKVStore(getCurrentTenantId());
}
