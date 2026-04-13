import { SOURCES, type PaywallSource } from "../sources";

/**
 * Find the first registered paywall source that matches the given URL.
 * Returns null if no source claims the domain.
 */
export function findSourceForUrl(url: string): PaywallSource | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return SOURCES.find((s) => s.domainMatch(parsed)) ?? null;
}
