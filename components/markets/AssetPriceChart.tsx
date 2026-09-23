"use client";

// components/markets/AssetPriceChart.tsx
//
// Asset-detail price chart. Renders ONLY the series it is handed — which
// is fetched per selected symbol from GET /api/market/history (allowlist
// -only) and always belongs to that one asset. There is no shared or
// cached chart from a different token, no synthetic curve, and no
// invented history: when fewer than two real observations exist the
// component says so instead of drawing a line.

import { useMemo } from "react";

import { chartGeometry, type ChartPoint } from "@/lib/markets/tape-chart";
import { formatTapeUsd } from "@/hooks/useTape";

export interface AssetPriceChartProps {
  points: ChartPoint[];
  /** Human label for where the series came from (shown under the chart). */
  source: string;
  /** e.g. "Chainlink equity feed rounds" / "Live DEX samples". */
  label: string;
  /** True when the underlying feed/data is flagged stale by the tape. */
  stale?: boolean;
  /**
   * True for the two-point 24h reference: real endpoints from the
   * source's own published change, but not an observed path. Labelled.
   */
  derived?: boolean;
}

function formatTime(seconds: number): string {
  try {
    return new Date(seconds * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function formatDay(seconds: number): string {
  try {
    return new Date(seconds * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export function AssetPriceChart({
  points,
  source,
  label,
  stale = false,
  derived = false,
}: AssetPriceChartProps) {
  const geometry = useMemo(() => chartGeometry(points), [points]);
  const first = points[0];
  const last = points[points.length - 1];

  if (!geometry || !first || !last) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-background/60 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Price history</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          Collecting live samples for {label.toLowerCase()} — a chart needs at least two real
          observations from {source}. Nothing is drawn until then.
        </p>
      </div>
    );
  }

  const up = last.price >= first.price;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-background/60 p-3" data-testid="asset-price-chart">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Price history</p>
        <p className="font-mono text-[11px] tabular-nums text-white">{formatTapeUsd(last.price)}</p>
      </div>

      <svg
        viewBox="0 0 320 96"
        preserveAspectRatio="none"
        className="mt-2 h-20 w-full sm:h-24"
        role="img"
        aria-label={`${label} for this asset: ${points.length} observations from ${source}, low ${formatTapeUsd(
          geometry.min,
        )}, high ${formatTapeUsd(geometry.max)}`}
      >
        <defs>
          <linearGradient id="asset-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? "#34d399" : "#f87171"} stopOpacity="0.22" />
            <stop offset="100%" stopColor={up ? "#34d399" : "#f87171"} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geometry.area} fill="url(#asset-chart-fill)" />
        {geometry.flat ? (
          <line
            x1="6"
            y1="48"
            x2="314"
            y2="48"
            stroke={up ? "#34d399" : "#f87171"}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ) : (
          <polyline
            points={geometry.line}
            fill="none"
            stroke={up ? "#34d399" : "#f87171"}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="mt-1 flex items-center justify-between font-mono text-[10px] tabular-nums text-muted">
        <span>
          {formatDay(first.t)} {formatTime(first.t)}
        </span>
        <span>
          {geometry.flat
            ? "flat"
            : `low ${formatTapeUsd(geometry.min)} · high ${formatTapeUsd(geometry.max)}`}
        </span>
        <span>
          {formatDay(last.t)} {formatTime(last.t)}
        </span>
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
        {label} ·{" "}
        {derived
          ? "2 reference points (not a continuous series)"
          : `${points.length} real observation${points.length === 1 ? "" : "s"}`}{" "}
        · {source}
        {stale ? " · feed flagged stale" : ""}
      </p>
    </div>
  );
}
