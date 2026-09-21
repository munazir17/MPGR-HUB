"use client";

// components/markets/PairSheet.tsx
//
// Pair detail drawer for the Base Stocks Agent tape.
// Desktop: right drawer. Mobile: bottom sheet. Opens on tape-chip click
// and fetches GET /api/market/pair?symbol=… (allowlist-only — an unknown
// symbol is a 404, never a guessed contract).
//
// Shows: official contract (mono + copy + "official" badge), feed vs
// DEX price + premium bps, freshness (last update / block), source
// names, Basescan + official-list links, and the one action that
// matters: "Prepare swap USDC → <token>" (agent prepares, user signs).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy, X } from "lucide-react";
import { clsx } from "clsx";

import {
  formatChange24h,
  formatPremiumBps,
  formatTapeUsd,
  formatUnixSeconds,
} from "@/hooks/useTape";
import { BASE_STOCKS_DISCLAIMER } from "@/lib/markets/base-pairs";
import type { TapePairDetail } from "@/lib/markets/tape-types";

export interface PairSheetProps {
  /** Symbol to show, or null when closed. */
  symbol: string | null;
  onClose: () => void;
  /** Omitted for tokens where a USDC→token prepare makes no sense. */
  onPrepareSwap?: (symbol: string) => void;
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

export function PairSheet({ symbol, onClose, onPrepareSwap }: PairSheetProps) {
  const [detail, setDetail] = useState<TapePairDetail | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!symbol) {
      setDetail(null);
      setStatus("idle");
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

  // Escape closes the sheet.
  useEffect(() => {
    if (!symbol) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [symbol, onClose]);

  if (!symbol) return null;

  const pair = detail?.pair ?? null;
  const stock = detail?.stockEntry ?? null;
  const wrapped = detail?.wrappedEntry ?? null;
  const priceUsd = stock ? (stock.usdDex ?? stock.usdFeed) : wrapped?.usd ?? null;
  const premium = stock ? formatPremiumBps(stock.premiumBps) : null;
  const change = formatChange24h(stock?.change24h ?? wrapped?.change24h ?? null);
  const stale = stock ? stock.stale || stock.feedStale : (wrapped?.stale ?? true);
  const lastUpdate = stock
    ? formatUnixSeconds(stock.feedUpdatedAt) ?? formatUnixSeconds(stock.dexUpdatedAt)
    : formatUnixSeconds(wrapped?.updatedAt ?? null);

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={`${symbol} pair details`}>
      <button
        type="button"
        aria-label="Close pair details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
      />
      <div
        className={clsx(
          "absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-white/[0.08] bg-surface shadow-glow-lg",
          "md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[400px] md:rounded-none md:rounded-l-2xl md:border-y-0 md:border-r-0",
        )}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-white/[0.07] bg-surface px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-white">
                {pair ? pair.name : symbol}
              </h2>
              {pair?.official ? (
                <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                  official
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

        <div className="px-4 py-3">
          {status === "loading" && !detail ? (
            <p className="py-6 text-center text-xs text-muted">Loading verified pair data…</p>
          ) : status === "error" || !pair ? (
            <div className="py-6 text-center">
              <p className="text-xs text-red-300">
                Pair data is unavailable right now. Nothing is tradeable until the official contract
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
              <Row label="Price (DEX)">{formatTapeUsd(priceUsd)}</Row>
              {stock ? (
                <>
                  <Row label="Feed (Chainlink)">{formatTapeUsd(stock.usdFeed)}</Row>
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
                  {stock.paused ? (
                    <Row label="Token status">
                      <span className="font-semibold text-red-300">paused on-chain — transfers blocked</span>
                    </Row>
                  ) : null}
                  {pair.chainlinkFeed ? (
                    <Row label="Equity feed">
                      <code className="truncate font-mono text-[11px] text-muted">{pair.chainlinkFeed}</code>
                    </Row>
                  ) : null}
                </>
              ) : null}
              <Row label="24h">{change ?? <span className="text-muted">no source</span>}</Row>
              <Row label="Freshness">
                {stale ? (
                  <span className="flex items-center justify-end gap-1.5 text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
                    stale
                  </span>
                ) : (
                  <span className="text-emerald-300">fresh</span>
                )}
              </Row>
              <Row label="Last update">{lastUpdate ?? "—"}</Row>
              <Row label="Block">{detail?.blockNumber ?? "—"}</Row>
              <Row label="Sources">
                <span className="text-[11px] text-muted">{stock?.source ?? wrapped?.source ?? "—"}</span>
              </Row>

              <div className="mt-3 flex flex-col gap-2">
                {onPrepareSwap && pair.kind !== "stable" ? (
                  <button
                    type="button"
                    onClick={() => onPrepareSwap(pair.symbol)}
                    className="min-h-[44px] w-full cursor-pointer rounded-xl bg-gradient-blue px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 active:scale-[0.99]"
                  >
                    Prepare swap USDC → {pair.symbol}
                  </button>
                ) : null}
                <div className="flex gap-2">
                  <a
                    href={pair.basescanUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-surface-2 px-3 text-xs font-medium text-white transition-colors hover:border-primary/30"
                  >
                    View on Basescan
                    <ArrowUpRight className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  </a>
                  <a
                    href={pair.officialListUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-surface-2 px-3 text-xs font-medium text-white transition-colors hover:border-primary/30"
                  >
                    Official list
                    <ArrowUpRight className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  </a>
                </div>
              </div>

              <p className="mt-3 text-[10px] leading-relaxed text-muted">
                Verify this contract against the official list before you sign. {pair.notes ?? ""}
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
