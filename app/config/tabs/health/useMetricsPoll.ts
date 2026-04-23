"use client";

/**
 * Phase 53 — generic metrics poll hook.
 *
 * SWR-style fetch+refetch pattern without adding a 3rd-party dep (SWR
 * itself is ~15 KB gzipped — overkill for a 40-line hook). Uses
 * useEffect + setInterval + AbortController so every poll either
 * succeeds or aborts cleanly on unmount / URL change / manual refresh.
 *
 * Contract:
 *   - 60s default refresh; clamp 10..600 via ?refresh=<seconds> URL
 *     param (reads window.location.search on mount + on URL change).
 *   - `enabled: false` pauses polling entirely (returns last data /
 *     error / loading state frozen).
 *   - credentials:"include" so the admin cookie travels with the fetch.
 *   - `refresh()` manual refetch cancels the pending timer and re-fires
 *     immediately. The interval is re-armed from the refetch's finish.
 *
 * Type parameter:
 *   - `T` is the expected JSON shape of the response.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const DEFAULT_REFRESH_SEC = 60;
export const MIN_REFRESH_SEC = 10;
export const MAX_REFRESH_SEC = 600;

/**
 * Read the `refresh` URL param and clamp to MIN..MAX. Falls back to
 * `DEFAULT_REFRESH_SEC` when unset, empty, or non-numeric.
 */
export function resolveRefreshSec(search: string, fallback = DEFAULT_REFRESH_SEC): number {
  if (typeof search !== "string" || search.length === 0) return fallback;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("refresh");
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_REFRESH_SEC, Math.min(MAX_REFRESH_SEC, n));
}

export interface MetricsPollState<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  lastFetchedAt: Date | null;
  refresh: () => void;
}

export interface UseMetricsPollOptions {
  /** Interval seconds. Defaults to URL ?refresh or 60. */
  refreshSec?: number;
  /** When false, polling is paused (no fetch on mount, no timer). */
  enabled?: boolean;
}

export function useMetricsPoll<T>(
  url: string,
  opts: UseMetricsPollOptions = {}
): MetricsPollState<T> {
  const { enabled = true } = opts;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;

  const fetchOnce = useCallback(async () => {
    // Cancel any in-flight request for a previous URL/interval.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    try {
      const res = await fetch(urlRef.current, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as T;
      if (!controller.signal.aborted) {
        setData(json);
        setError(null);
        setLastFetchedAt(new Date());
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      // Inline err-message extraction — client-side module, no @/core
      // alias; avoids pulling error-utils into the client bundle.
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setError(msg);
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    // Manual refresh: cancel the current timer, fire now, re-arm.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // fire-and-forget OK: refresh() is a UI-driven trigger; failures surface through setError state.
    void fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    if (!enabled) return;

    // Resolve effective refresh interval:
    //   explicit prop > URL ?refresh= > DEFAULT
    const fromUrl =
      typeof window !== "undefined"
        ? resolveRefreshSec(window.location.search)
        : DEFAULT_REFRESH_SEC;
    const intervalMs =
      Math.max(MIN_REFRESH_SEC, Math.min(MAX_REFRESH_SEC, opts.refreshSec ?? fromUrl)) * 1000;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await fetchOnce();
      if (cancelled) return;
      // fire-and-forget OK: setTimeout callback is the re-arm loop; no caller awaits it.
      timerRef.current = setTimeout(() => void tick(), intervalMs);
    };

    // fire-and-forget OK: useEffect can't return a Promise; polling loop owns its own lifecycle via `cancelled`.
    void tick();

    return () => {
      cancelled = true;
      controllerRef.current?.abort();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [url, enabled, opts.refreshSec, fetchOnce]);

  return { data, error, isLoading, lastFetchedAt, refresh };
}
