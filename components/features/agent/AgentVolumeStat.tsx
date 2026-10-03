"use client";

import { useEffect, useState } from "react";

interface AgentStats {
  available: boolean;
  totalValueTradedUsd: number | null;
  tradeCount: number | null;
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: value >= 1_000_000 ? "compact" : "standard",
  }).format(value);
}

export function AgentVolumeStat() {
  const [stats, setStats] = useState<AgentStats | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/agent/stats", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: AgentStats | null) => {
        if (!cancelled && data) setStats(data);
      })
      .catch(() => {
        // Keep the metric as an honest placeholder when the analytics read is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = stats?.available ? stats.totalValueTradedUsd : null;
  const count = stats?.available ? stats.tradeCount : null;

  return (
    <div
      className="mx-auto flex w-fit max-w-full items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.025] px-5 py-3"
      data-testid="agent-volume-stat"
      aria-label="MPGR Agent total value traded"
    >
      <div className="text-right leading-none">
        <div className="text-xl font-semibold tracking-[-0.025em] text-white md:text-2xl">
          {formatUsd(value)}
        </div>
        <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.16em] text-muted">
          Total value traded
          {typeof count === "number" ? ` · ${count.toLocaleString()} trades` : ""}
        </div>
      </div>
    </div>
  );
}
