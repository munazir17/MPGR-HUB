"use client";

import { useEffect, useState } from "react";

export interface MpgrMarketData {
  priceUsd: number;
  change24h: number | null;
  marketCap: number | null;
  updatedAt: number;
  source: string;
}

export function useMpgrMarket() {
  const [data, setData] = useState<MpgrMarketData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/market/mpgr", { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        const json = (await res.json()) as MpgrMarketData;
        if (cancelled) return;
        if (typeof json.priceUsd !== "number") throw new Error("invalid");
        setData(json);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return { data, status };
}
