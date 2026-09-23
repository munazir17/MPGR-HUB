"use client";

// components/markets/PairSheet.tsx
//
// Asset detail sheet for the Base Stocks tape.
// Desktop: right drawer. Mobile: bottom sheet. Opens on tape-chip click
// and fetches GET /api/market/pair?symbol=… (allowlist-only — an unknown
// symbol is a 404, never a guessed contract).
//
// Sections:
//   - header (name, symbol, official / not-live badge) + live price
//   - "View Asset Details" (replaces the old registry link button): the
//     verified metadata already available from the project's trusted
//     sources — name, symbol, contract, asset type, company, feed,
//     price, 24h change, freshness, last update, sources — plus a price
//     chart for THIS asset (GET /api/market/history, per symbol).
//   - the one action that matters: "Prepare swap USDC → <token>"
//     (instant feedback; the agent prepares and quotes, the user signs)

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Copy, Loader2, X } from "lucide-react";
import { clsx } from "clsx";

import {
  formatChange24h,
  formatPremiumBps,
  formatTapeUsd,
  formatUnixSeconds,
} from "@/hooks/useTape";
import { AssetPriceChart } from "./AssetPriceChart";
import {
  BASE_STOCKS_DISCLAIMER,
  OFFICIAL_LIST_SOURCES,
  type BasePairKind,
} from "@/lib/markets/base-pairs";
import { mergeChartPoints, type ChartPoint } from "@/lib/markets/tape-chart";
import type { TapePairDetail } from "@/lib/markets/tape-types";

export interface PairSheetPreview {
  symbol: string;
  usd: number | null;
  change24h: number | null;
  stale: boolean;
}

export interface PairSheetProps {
  /** Symbol to show, or null when closed. */
  symbol: string | null;
  onClose: () => void;
  /** Omitted for tokens where a USDC→token prepare makes no sense. */
  onPrepareSwap?: (symbol: string) => void;
  /** Already-loaded tape chip values, shown instantly while details load. */
  preview?: PairSheetPreview | null;
}

interface HistorySeries {
  id: "chainlink-feed" | "dex-samples" | "change24h-reference";
  label: string;
  source: string;
  points: ChartPoint[];
  derived?: boolean;
}

interface HistoryPayload {
  symbol: string;
  series: HistorySeries[];
  updatedAt: string | null;
}

const HISTORY_CACHE_TTL_MS = 20_000;
const historyCache = new Map<string, { at: number; data: HistoryPayload }>();

function assetTypeLabel(kind: TapePairDetail["pair"]["kind"], live: boolean): string {
  const base =
    kind === "b20-stock"
      ? "Coinbase Tokenized Stock (B20)"
      : kind === "wrapped"
        ? "Coinbase wrapped asset"
        : "Native stablecoin (USDC on Base)";
  return live ? base : `${base} · published, not live yet`;
}

/**
 * The authoritative sources this asset's data is verified against — shown
 * as plain text metadata inside "View Asset Details" (the old separate
 * separate registry button/section is gone). Read from the same typed
 * constant the swap/verification paths use, so the labels can never drift
 * from the allowlist's sources.
 */
function verifiedSourceLabels(kind: BasePairKind): string[] {
  const matches = (url: string): boolean => {
    if (kind === "b20-stock") {
      return url.includes("base.org/stocks") || url.includes("tokenized-stocks") || url.includes("coinbase.com/tokenize");
    }
    if (kind === "wrapped") return url.includes("wrapped-assets");
    return url.includes("circle.com");
  };
  return OFFICIAL_LIST_SOURCES.filter(matches).map((url) => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname === "/" ? "" : parsed.pathname;
      return `${parsed.host}${path}`;
    } catch {
      return url;
    }
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.05] py-2 last:border-b-0">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="min-w-0 text-right text-xs text-white">{children}</span>
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [address]);

  return (
    <span className="flex items-center justify-end gap-1.5">
      <code className="truncate font-mono text-[11px] text-primary-glow" title={address}>
        {address}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy contract address"}
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-surface text-muted transition-colors hover:text-white"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
      </button>
    </span>
  );
}

export function PairSheet({ symbol, onClose, onPrepareSwap, preview }: PairSheetProps) {
  const [detail, setDetail] = useState<TapePairDetail | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setDetail(null);
      setStatus("idle");
      setHistory(null);
      setDetailsOpen(false);
      setPreparing(false);
      return;
    }
    let alive = true;
    setStatus("loading");
    void (async () => {
      try {
        const response = await fetch(`/api/market/pair?symbol=${encodeURIComponent(symbol)}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`pair ${response.status}`);
        const data = (await response.json()) as TapePairDetail;
        if (!alive) return;
        setDetail(data);
        setStatus("ready");
      } catch {
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol]);

  // Chart history for THIS symbol only. Served from a short-lived client
  // cache so reopening the same asset (or double-tapping a chip) does not
  // re-request it.
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const cached = historyCache.get(symbol);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL_MS) {
      setHistory(cached.data);
      return;
    }
    setHistory(null);
    void (async () => {
      try {
        const response = await fetch(`/api/market/history?symbol=${encodeURIComponent(symbol)}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`history ${response.status}`);
        const data = (await response.json()) as HistoryPayload;
        if (!alive) return;
        historyCache.set(symbol, { at: Date.now(), data });
        setHistory(data);
      } catch {
        if (alive) setHistory(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol]);

  // Escape closes the sheet.
  useEffect(() => {
    if (!symbol) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [symbol, onClose]);

  const pair = detail?.pair ?? null;
  const stock = detail?.stockEntry ?? null;
  const wrapped = detail?.wrappedEntry ?? null;

  const priceUsd = stock
    ? stock.usdDex ?? stock.usdFeed
    : wrapped?.usd ?? preview?.usd ?? null;
  const priceSource = stock?.source ?? wrapped?.source ?? (preview ? "live tape" : null);
  const premium = stock ? formatPremiumBps(stock.premiumBps) : null;
  const change = formatChange24h(stock?.change24h ?? wrapped?.change24h ?? preview?.change24h ?? null);
  const stale = stock ? stock.stale || stock.feedStale : wrapped?.stale ?? preview?.stale ?? true;
  const lastUpdate = stock
    ? formatUnixSeconds(stock.feedUpdatedAt) ?? formatUnixSeconds(stock.dexUpdatedAt)
    : formatUnixSeconds(wrapped?.updatedAt ?? null);

  // Chart: the fetched series for THIS symbol only. Observed series win;
  // the derived 24h reference is used only while fewer than two real
  // observations exist, and the newest point is appended from the SAME
  // source as the series (never a different venue's price — see
  // lib/markets/tape-chart).
  const chart = useMemo(() => {
    const all = history?.series ?? [];
    if (all.length === 0) return null;
    const series = all.find((entry) => entry.points.length >= 2) ?? all[0];

    let livePoint: ChartPoint | null = null;
    if (!series.derived) {
      if (series.id === "chainlink-feed") {
        const feedPrice = stock?.usdFeed ?? null;
        const feedAt = stock?.feedUpdatedAt ?? null;
        if (feedPrice !== null && Number.isFinite(feedPrice) && feedAt !== null) {
          livePoint = { t: feedAt, price: feedPrice };
        }
      } else {
        const dexAt = stock?.dexUpdatedAt ?? wrapped?.updatedAt ?? null;
        if (priceUsd !== null && Number.isFinite(priceUsd) && dexAt !== null) {
          livePoint = { t: dexAt, price: priceUsd };
        }
      }
    }

    return { series, points: mergeChartPoints(series.points, livePoint) };
  }, [history, priceUsd, stock, wrapped]);

  if (!symbol) return null;

  const title = pair?.name ?? preview?.symbol ?? symbol;

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={`${symbol} asset details`}>
      <button
        type="button"
        aria-label="Close asset details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
      />
      <div
        className={clsx(
          "absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-white/[0.08] bg-surface shadow-glow-lg",
          "md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[400px] md:rounded-none md:rounded-l-2xl md:border-y-0 md:border-r-0",
        )}
      >
        <div className="sticky top-0 z-10 border-b border-white/[0.07] bg-surface px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-white">{title}</h2>
                {pair?.official ? (
                  <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                    official
                  </span>
                ) : null}
                {pair && pair.live === false ? (
                  <span className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                    not live yet
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-muted">{symbol}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/10 text-muted transition-colors hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-lg font-semibold tabular-nums text-white">
              {formatTapeUsd(priceUsd)}
            </span>
            {change ? (
              <span
                className={clsx(
                  "font-mono text-xs tabular-nums",
                  (stock?.change24h ?? wrapped?.change24h ?? preview?.change24h ?? 0) >= 0
                    ? "text-good"
                    : "text-bad",
                )}
              >
                {change} 24h
              </span>
            ) : null}
            <span
              className={clsx(
                "flex items-center gap-1 text-[10px]",
                stale ? "text-amber-400" : "text-emerald-300",
              )}
            >
              <span
                className={clsx("h-1.5 w-1.5 rounded-full", stale ? "bg-amber-400" : "bg-emerald-400")}
                aria-hidden="true"
              />
              {stale ? "stale" : "fresh"}
            </span>
          </div>
        </div>

        <div className="px-4 py-3">
          {status === "loading" && !detail ? (
            <div className="space-y-2 py-2" aria-live="polite">
              <p className="text-xs text-muted">Loading verified asset data…</p>
              <div className="h-24 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
            </div>
          ) : status === "error" || !pair ? (
            <div className="py-6 text-center">
              <p className="text-xs text-red-300">
                Asset data is unavailable right now. Nothing is tradeable until the official contract
                loads — do not sign against an unverified address.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-3 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-muted transition-colors hover:text-white"
              >
                Close
              </button>
            </div>
          ) : (
            <>
              <Row label="Contract">
                <CopyAddress address={pair.address} />
              </Row>
              {stock ? (
                <Row label="Premium vs feed">
                  {premium ? (
                    <span
                      className={clsx(
                        "font-mono",
                        (stock.premiumBps ?? 0) > 0
                          ? "text-emerald-300"
                          : (stock.premiumBps ?? 0) < 0
                            ? "text-red-300"
                            : "text-white",
                      )}
                    >
                      {premium}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Row>
              ) : null}
              {stock?.paused ? (
                <Row label="Token status">
                  <span className="font-semibold text-red-300">paused on-chain — transfers blocked</span>
                </Row>
              ) : null}
              <Row label="Last update">{lastUpdate ?? "—"}</Row>

              {/* View Asset Details — replaces the old registry link area. */}
              <button
                type="button"
                onClick={() => setDetailsOpen((open) => !open)}
                aria-expanded={detailsOpen}
                aria-controls="asset-details-section"
                className="mt-3 flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-white/10 bg-surface-2 px-3 text-left text-xs font-semibold text-white transition-colors hover:border-primary/30"
              >
                View Asset Details
                <ChevronDown
                  className={clsx(
                    "h-4 w-4 shrink-0 text-muted transition-transform duration-200",
                    detailsOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>

              {detailsOpen ? (
                <div id="asset-details-section" className="mt-2 space-y-3" data-testid="asset-details">
                  <div>
                    <Row label="Asset name">{pair.name}</Row>
                    <Row label="Symbol">
                      <span className="font-mono">{pair.symbol}</span>
                    </Row>
                    <Row label="Contract">
                      <CopyAddress address={pair.address} />
                    </Row>
                    <Row label="Asset type">{assetTypeLabel(pair.kind, pair.live)}</Row>
                    {pair.company ? <Row label="Company">{pair.company}</Row> : null}
                    <Row label="Current price">
                      <span className="font-mono tabular-nums">{formatTapeUsd(priceUsd)}</span>
                    </Row>
                    {stock ? (
                      <Row label="Official feed price">
                        <span className="font-mono tabular-nums">{formatTapeUsd(stock.usdFeed)}</span>
                      </Row>
                    ) : null}
                    <Row label="24H change">{change ?? <span className="text-muted">no source</span>}</Row>
                    <Row label="Freshness">
                      <span className={stale ? "text-amber-400" : "text-emerald-300"}>
                        {stale ? "stale" : "fresh"}
                      </span>
                    </Row>
                    <Row label="Last update">{lastUpdate ?? "—"}</Row>
                    {pair.chainlinkFeed ? (
                      <Row label="Equity feed">
                        <code className="truncate font-mono text-[11px] text-muted">{pair.chainlinkFeed}</code>
                      </Row>
                    ) : null}
                    <Row label="Price sources">
                      <span className="text-[11px] text-muted">
                        {stock?.source ?? wrapped?.source ?? priceSource ?? "—"}
                      </span>
                    </Row>
                    <Row label="Verified against">
                      <span className="flex flex-col items-end gap-0.5 text-[11px] text-muted">
                        {verifiedSourceLabels(pair.kind).map((source) => (
                          <span key={source}>{source}</span>
                        ))}
                      </span>
                    </Row>
                  </div>

                  {chart ? (
                    <AssetPriceChart
                      points={chart.points}
                      label={chart.series.label}
                      source={chart.series.source}
                      derived={chart.series.derived}
                      stale={stale}
                    />
                  ) : (
                    <div className="rounded-xl border border-white/[0.06] bg-background/60 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Price history</p>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                        Loading real observations for {pair.symbol}…
                      </p>
                    </div>
                  )}
                </div>
              ) : null}

              {pair.live === false ? (
                <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-2 text-[11px] leading-relaxed text-amber-200">
                  Coinbase has published this B20 contract address, but Base&apos;s official
                  tokenized-stocks list does not carry it as live yet — there is no issued supply
                  and no Chainlink feed, so it cannot be priced or swapped. Preparing an order is
                  disabled until it launches.
                </p>
              ) : null}

              <div className="mt-3 flex flex-col gap-2">
                {onPrepareSwap && pair.kind !== "stable" && pair.live !== false ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPreparing(true);
                      onPrepareSwap(pair.symbol);
                    }}
                    disabled={preparing}
                    className="min-h-[44px] w-full cursor-pointer rounded-xl bg-gradient-blue px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 active:scale-[0.99] disabled:cursor-default disabled:opacity-70"
                  >
                    {preparing ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Preparing swap…
                      </span>
                    ) : (
                      <>Prepare swap USDC → {pair.symbol}</>
                    )}
                  </button>
                ) : null}
                <a
                  href={pair.basescanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-surface-2 px-3 text-xs font-medium text-white transition-colors hover:border-primary/30"
                >
                  View on Basescan
                  <ArrowUpRight className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                </a>
              </div>

              <p className="mt-3 text-[10px] leading-relaxed text-muted">
                {pair.notes} The contract address above is the one this app routes swaps through —
                match it in your wallet before you sign.
              </p>
              {pair.kind === "b20-stock" ? (
                <p className="mt-2 rounded-lg border border-white/[0.06] bg-background/60 p-2 text-[10px] leading-relaxed text-muted">
                  {BASE_STOCKS_DISCLAIMER}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
