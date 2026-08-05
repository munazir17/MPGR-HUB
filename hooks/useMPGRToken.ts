// hooks/useMPGRToken.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { tokenService } from "@/lib/token/token-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import type { TokenMetadata } from "@/lib/token/token-types";

// Phase 3E Part 1 — useMPGRToken Hook.
//
// Manages token metadata (name, symbol, decimals, totalSupply). Loads once
// on mount and caches for the session. Listens for token_loaded events
// from the event bus in case metadata is refreshed externally.

interface UseMPGRTokenReturn {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint | null;
  isLoading: boolean;
  error: string | null;
}

export function useMPGRToken(): UseMPGRTokenReturn {
  const [metadata, setMetadata] = useState<TokenMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load metadata on mount.
  useEffect(() => {
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const data = await tokenService.getMetadata();
        setMetadata(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load token metadata");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Listen for token_loaded events from the event bus.
  useEffect(() => {
    const unsubscribe = agentEventBus.on("token_loaded", async (payload) => {
      const data = await tokenService.getMetadata();
      setMetadata(data);
    });
    return unsubscribe;
  }, []);

  return {
    name: metadata?.name ?? "MPGR",
    symbol: metadata?.symbol ?? "MPGR",
    decimals: metadata?.decimals ?? 18,
    totalSupply: metadata?.totalSupply ?? null,
    isLoading,
    error,
  };
}
