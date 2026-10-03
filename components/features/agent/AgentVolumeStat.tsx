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
      className="ml-auto hidden shrink-0 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-1.5 sm:flex"
      data-testid="agent-volume-stat"
      aria-label="MPGR Agent total value traded"
    >
      <div className="text-right leading-none">
        <div className="text-base font-semibold tracking-[-0.02em] text-white md:text-lg">
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
