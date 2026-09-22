"use client";

// hooks/useTape.ts
//
// Browser polling hook for GET /api/market/tape — the Base Stocks live
// tape. Server-aggregated and cached there; the browser just refreshes
// on an interval and keeps the last good snapshot when a refresh fails
// (the tape must never blank out or show invented numbers).

import { useCallback, useEffect, useRef, useState } from "react";

import type { TapeSnapshot } from "@/lib/markets/tape-types";

const TAPE_POLL_INTERVAL_MS = 15_000;

export interface UseTapeResult {
  snapshot: TapeSnapshot | null;
  /** True until the first fetch settles (success or failure). */
  loading: boolean;
  /** True when the most recent refresh failed (snapshot may still be shown). */
  error: boolean;
  refresh: () => void;
}

export function useTape(intervalMs: number = TAPE_POLL_INTERVAL_MS): UseTapeResult {
  const [snapshot, setSnapshot] = useState<TapeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const aliveRef = useRef(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    aliveRef.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/market/tape", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`tape ${response.status}`);
        const data = (await response.json()) as TapeSnapshot;
        if (!mountedRef.current || !aliveRef.current) return;
        if (!Array.isArray(data.wrapped) || !Array.isArray(data.stocks)) {
          throw new Error("tape shape");
        }
        setSnapshot(data);
        setError(false);
      } catch {
        if (!mountedRef.current) return;
        // Keep the previous snapshot; only flag the failure.
        setError(true);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      // Don't hammer the API from background tabs.
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, intervalMs);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { snapshot, loading, error, refresh };
}

// --- display formatting (edge-only; on-chain math stays integer) ---------

export function formatTapeUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  if (value >= 1) {
    return `$${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
}

export function formatChange24h(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/** "+50 bps" style premium display; null-safe. */
export function formatPremiumBps(bps: number | null | undefined): string | null {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return null;
  const sign = bps > 0 ? "+" : "";
  return `${sign}${bps} bps`;
}

export function formatUnixSeconds(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  try {
    return new Date(seconds * 1000).toLocaleString();
  } catch {
    return null;
  }
}
