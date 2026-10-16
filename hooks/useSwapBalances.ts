"use client";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { readSwapBalance } from "@/lib/swap/swap-wallet";
export type SwapBalance = { state: "loading" | "disconnected" | "wrong-network" | "error" } | { state: "ready"; value: bigint; decimals: number };
export function useSwapBalances(pay: TradeTokenRef, receive: TradeTokenRef, externalRevision = 0) {
  const { address, chainId, isConnected } = useAccount();
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ key: string; values: Record<string, SwapBalance> }>({ key: "", values: {} });
  const key = `${address?.toLowerCase()}:${chainId}:${isConnected}:${pay.address.toLowerCase()}:${receive.address.toLowerCase()}:${revision}:${externalRevision}`;
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if (!address || !isConnected || chainId !== 8453) return;
    let active = true;
    const load = async () => {
      const entries = await Promise.all([pay, receive].map(async token => {
        try { return [token.address.toLowerCase(), { state: "ready", ...await readSwapBalance(address, token) }] as const; }
        catch { return [token.address.toLowerCase(), { state: "error" }] as const; }
      }));
      if (active) setRead({ key, values: Object.fromEntries(entries) });
    };
    void load();
    const interval = setInterval(() => { void load(); }, 15_000);
    return () => { active = false; clearInterval(interval); };
  }, [address, chainId, isConnected, pay, receive, key]);
  const balance = (token: TradeTokenRef): SwapBalance => !isConnected || !address ? { state: "disconnected" }
    : chainId !== 8453 ? { state: "wrong-network" } : read.key !== key ? { state: "loading" }
      : read.values[token.address.toLowerCase()] ?? { state: "loading" };
  return { pay: balance(pay), receive: balance(receive), refresh };
}
