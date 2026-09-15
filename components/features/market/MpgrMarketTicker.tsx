"use client";

import { useMpgrMarket } from "@/hooks/useMpgrMarket";

function formatUsd(value: number) {
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return `$${value.toPrecision(4)}`;
}

function formatCap(value: number) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function MpgrMarketTicker({ compact = false }: { compact?: boolean }) {
  const { data, status } = useMpgrMarket();

  if (status === "loading") {
    return (
      <div className="rounded-2xl border border-white/[0.08] bg-surface px-3 py-2.5 text-xs text-muted">
        Loading $MPGR market data…
      </div>
    );
  }

  if (status === "error" || !data) {
    return (
      <div className="rounded-2xl border border-white/[0.08] bg-surface px-3 py-2.5 text-xs text-muted">
        Live $MPGR market data is unavailable right now.
      </div>
    );
  }

  const change = data.change24h;
  const up = change != null && change >= 0;
  const stale = Date.now() - data.updatedAt > 5 * 60_000;

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-semibold text-gold">$MPGR</span>
        <span className="font-medium text-white">{formatUsd(data.priceUsd)}</span>
        {change != null ? (
          <span className={up ? "text-emerald-300" : "text-red-300"}>
            {up ? "+" : ""}
            {change.toFixed(2)}% 24h
          </span>
        ) : null}
        {data.marketCap != null ? (
          <span className="text-muted">Mcap {formatCap(data.marketCap)}</span>
        ) : null}
      </div>
      {!compact ? (
        <p className="mt-1.5 text-[11px] text-muted">
          {stale ? "Data may be stale · " : "Last updated "}
          {new Date(data.updatedAt).toLocaleTimeString()} · {data.source}
        </p>
      ) : null}
    </div>
  );
}
