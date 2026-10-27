"use client";

import { useEffect, useState } from "react";
import { HUB_VOLUME_CHECKPOINT } from "@/lib/agent/hub-volume-checkpoint";

interface AgentStats {
  available: boolean;
  totalValueTradedUsd: number | null;
  tradeCount: number | null;
}

const STORAGE_KEY = "mpgr:hub-volume";

/** Sealed total. Shown immediately so the page never waits on the live scan. */
const SEEDED: AgentStats = {
  available: true,
  totalValueTradedUsd: Number(HUB_VOLUME_CHECKPOINT.totalUsdcAtomic) / 1_000_000,
  tradeCount: HUB_VOLUME_CHECKPOINT.tradeCount,
};

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const small = value > 0 && value < 1000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
    minimumFractionDigits: small ? 2 : 0,
    notation: value >= 1_000_000 ? "compact" : "standard",
  }).format(value);
}

function readStored(): AgentStats | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as AgentStats;
    if (!data?.available || typeof data.totalValueTradedUsd !== "number" || !Number.isFinite(data.totalValueTradedUsd)) return null;
    if (typeof data.tradeCount !== "number") return null;
    if ((SEEDED.totalValueTradedUsd ?? 0) > data.totalValueTradedUsd) return null;
    return data;
  } catch {
    return null;
  }
}

export function AgentVolumeStat() {
  const [stats, setStats] = useState<AgentStats>(SEEDED);

  useEffect(() => {
    const stored = readStored();
    if (stored) setStats(stored);

    let cancelled = false;
    let timer = 0;
    const load = () => {
      fetch("/api/agent/stats")
        .then((response) => (response.ok ? response.json() : null))
        .then((data: AgentStats | null) => {
          if (cancelled || !data?.available || typeof data.totalValueTradedUsd !== "number") return;
          setStats(data);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
          } catch {
            // Private mode can reject storage. The live figure still shows.
          }
        })
        .catch(() => {
          // Keep the figure already on screen.
        });
    };
    const start = () => {
      load();
      timer = window.setInterval(load, 60_000);
    };
    const idle = window.requestIdleCallback?.(start, { timeout: 2_000 });
    const fallback = idle === undefined ? window.setTimeout(start, 600) : 0;
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      window.clearTimeout(fallback);
      window.clearInterval(timer);
    };
  }, []);

  const value = stats.totalValueTradedUsd;
  const count = stats.tradeCount;

  return (
    <div
      className="mx-auto flex h-[4.5rem] w-full max-w-[280px] items-center justify-center overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025] px-5"
      data-testid="agent-volume-stat"
      aria-label="Total value traded on MPGR Hub"
    >
      <div className="min-w-0 text-center leading-none">
        <div className="truncate text-xl font-semibold tabular-nums tracking-[-0.025em] text-white md:text-2xl">
          {formatUsd(value)}
        </div>
        <div className="mt-1 truncate text-[9px] font-medium uppercase tracking-[0.16em] text-muted">
          Total value traded
          {typeof count === "number" ? ` · ${count.toLocaleString()} trades` : ""}
        </div>
      </div>
    </div>
  );
}
