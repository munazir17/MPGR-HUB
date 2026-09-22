"use client";

// components/markets/LiveTape.tsx
//
// Sticky trading-terminal tape for the Base Stocks Agent.
//
//   Segment A — Coinbase wrapped assets + native USDC on Base
//   Segment B — Coinbase Tokenized Stocks (B20)
//
// Two continuously marquee-scrolling tracks (CSS keyframe, duplicated
// content for a seamless loop), pause on hover, monospace tabular
// prices. Red/green is reserved for the 24h % only. A stale feed/DEX
// leg renders an amber dot + "stale" — never a fabricated price.
//
// Clicking a chip opens the PairSheet (right drawer desktop, bottom
// sheet mobile) owned by this component.

import { useCallback, useState } from "react";
import { clsx } from "clsx";

import { PairSheet } from "./PairSheet";
import { formatChange24h, formatTapeUsd, useTape } from "@/hooks/useTape";
import type { TapeStockEntry, TapeWrappedEntry } from "@/lib/markets/tape-types";

export interface LiveTapeProps {
  /** Fired when the pair sheet's "Prepare swap USDC → X" button is used. */
  onPrepareSwap?: (symbol: string) => void;
  className?: string;
}

type ChipModel =
  | { key: string; symbol: string; usd: number | null; change24h: number | null; stale: boolean }
  | null;

// Display-only: USDC is deliberately hidden from the TOP ticker chips.
// It stays everywhere else — the tape API, the agent's get_tape tool,
// pair/quote logic and swaps all still report and use USDC (it is the
// quote asset for every B20 pool). This filter only changes what the
// live tape at the top of the screen shows.
const TICKER_HIDDEN_SYMBOLS = new Set(["USDC"]);

function wrappedToChip(entry: TapeWrappedEntry): ChipModel {
  if (TICKER_HIDDEN_SYMBOLS.has(entry.symbol)) return null;
  return {
    key: `w-${entry.symbol}`,
    symbol: entry.symbol,
    usd: entry.usd,
    change24h: entry.change24h,
    stale: entry.stale,
  };
}

function stockToChip(entry: TapeStockEntry): ChipModel {
  return {
    key: `s-${entry.symbol}`,
    symbol: entry.symbol,
    // The DEX leg is what a swap actually executes against; fall back
    // to the official feed when the DEX price is unavailable.
    usd: entry.usdDex ?? entry.usdFeed,
    change24h: entry.change24h,
    stale: entry.stale || entry.feedStale,
  };
}

function TapeChip({ chip, onSelect }: { chip: NonNullable<ChipModel>; onSelect: (symbol: string) => void }) {
  const change = formatChange24h(chip.change24h);
  const up = chip.change24h !== null && chip.change24h >= 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(chip.symbol)}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] leading-none transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none"
      aria-label={`${chip.symbol} ${formatTapeUsd(chip.usd)}${change ? `, ${change} 24h` : ""}${chip.stale ? ", stale" : ""}`}
    >
      <span className="font-semibold tracking-wide text-white/90">{chip.symbol}</span>
      <span className="tabular-nums text-white/60">{formatTapeUsd(chip.usd)}</span>
      {chip.stale ? (
        <span className="flex items-center gap-1 text-[10px] text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
          stale
        </span>
      ) : change ? (
        <span className={clsx("tabular-nums text-[10px]", up ? "text-emerald-400" : "text-red-400")}>
          {change}
        </span>
      ) : null}
    </button>
  );
}

function Track({
  label,
  chips,
  speed,
  onSelect,
}: {
  label: string;
  chips: NonNullable<ChipModel>[];
  speed: "normal" | "fast";
  onSelect: (symbol: string) => void;
}) {
  if (chips.length === 0) {
    return (
      <div className="flex h-full shrink-0 items-center gap-2 border-r border-white/[0.07] px-3">
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
        <span className="font-mono text-[11px] text-muted">waiting for prices…</span>
      </div>
    );
  }
  // Two identical sequences; the track translates -50% for a seamless loop.
  const sequence = [...chips, ...chips];
  return (
    <div className="group flex h-full min-w-0 shrink-0 items-center overflow-hidden border-r border-white/[0.07]">
      <span className="z-10 flex h-full shrink-0 items-center border-r border-white/[0.06] bg-[#070C16] px-2.5 text-[9px] font-semibold uppercase leading-none tracking-[0.16em] text-muted/90">
        {label}
      </span>
      <div className="relative flex h-full min-w-0 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_20px,black_calc(100%-20px),transparent)]">
        <div
          className={clsx(
            "flex h-full w-max items-center gap-1 py-0.5 pr-1 group-hover:[animation-play-state:paused]",
            speed === "fast" ? "animate-tape-marquee-fast" : "animate-tape-marquee",
          )}
          aria-hidden="true"
        >
          {sequence.map((chip, index) => (
            <TapeChip key={`${chip.key}-${index}`} chip={chip} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LiveTape({ onPrepareSwap, className }: LiveTapeProps) {
  const { snapshot, loading, error } = useTape();
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  const openPair = useCallback((symbol: string) => setSelectedSymbol(symbol), []);
  const closePair = useCallback(() => setSelectedSymbol(null), []);
  const handlePrepareSwap = useCallback(
    (symbol: string) => {
      setSelectedSymbol(null);
      onPrepareSwap?.(symbol);
    },
    [onPrepareSwap],
  );

  const wrappedChips = (snapshot?.wrapped ?? []).map(wrappedToChip).filter((c): c is NonNullable<ChipModel> => c !== null);
  const stockChips = (snapshot?.stocks ?? []).map(stockToChip).filter((c): c is NonNullable<ChipModel> => c !== null);

  return (
    <>
      <div
        className={clsx(
          "z-40 flex h-11 w-full items-stretch overflow-hidden border-b border-white/[0.06] bg-[#070C16] md:h-12",
          className,
        )}
        data-testid="live-tape"
      >
        <Track label="Coinbase · Base" chips={wrappedChips} speed="normal" onSelect={openPair} />
        <Track label="Stocks B20" chips={stockChips} speed="fast" onSelect={openPair} />
        <div className="relative z-10 ml-auto flex h-full shrink-0 items-center gap-2 border-l border-white/[0.06] bg-[#070C16] px-3">
          {error ? (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-amber-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden="true" />
              feed issue
            </span>
          ) : loading && !snapshot ? (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              connecting
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              live
            </span>
          )}
        </div>
      </div>

      {/* Screen-reader / no-JS-motion fallback: the same chips, static. */}
      <div className="sr-only">
        <p>Live Base tape</p>
        <ul>
          {[...wrappedChips, ...stockChips].map((chip) => (
            <li key={`sr-${chip.key}`}>
              {chip.symbol} {formatTapeUsd(chip.usd)}
              {chip.stale ? " (stale)" : ""}
            </li>
          ))}
        </ul>
      </div>

      <PairSheet
        symbol={selectedSymbol}
        onClose={closePair}
        onPrepareSwap={onPrepareSwap ? handlePrepareSwap : undefined}
      />
    </>
  );
}
