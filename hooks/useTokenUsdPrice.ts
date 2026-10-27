"use client";

import { useEffect, useState } from "react";
import { BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";

const STABLES = new Set(["usdc", "usdt", "dai", "usdbc", "usds"]);

/** Live USD price for a Base token. Stables are $1. Native ETH uses WETH. */
export function useTokenUsdPrice(address: string, symbol: string): number | null {
  const stable = STABLES.has(symbol.toLowerCase());
  const [price, setPrice] = useState<number | null>(stable ? 1 : null);
  useEffect(() => {
    if (stable) {
      setPrice(1);
      return;
    }
    const token = isNativeEthSentinel(address) ? BASE_WETH : address;
    const controller = new AbortController();
    let cancelled = false;
    setPrice(null);
    fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((body: { pairs?: { chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }[] }) => {
        if (cancelled) return;
        let best: { usd: number; liquidity: number } | null = null;
        for (const pair of body.pairs ?? []) {
          if (pair.chainId !== "base") continue;
          const usd = Number(pair.priceUsd);
          const liquidity = Number(pair.liquidity?.usd ?? 0);
          if (!Number.isFinite(usd) || usd <= 0) continue;
          if (!best || liquidity > best.liquidity) best = { usd, liquidity };
        }
        setPrice(best?.usd ?? null);
      })
      .catch(() => {
        if (!cancelled) setPrice(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address, stable, symbol]);
  return price;
}

export function formatSwapUsd(amountHuman: string, price: number | null): string | null {
  if (price === null || !amountHuman) return null;
  const amount = Number(amountHuman.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd >= 0.01) return `≈ $${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `≈ $${usd.toLocaleString("en-US", { maximumSignificantDigits: 2 })}`;
}
