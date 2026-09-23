"use client";

// components/markets/LiveTape.tsx
//
// Sticky trading-terminal tape for the Base Stocks Agent.
//
// ONE continuously scrolling track that interleaves the two
// authoritative sources the app already trusts:
//
//   official Coinbase Tokenized Stock (B20) → Coinbase asset →
//   official Coinbase Tokenized Stock (B20) → Coinbase asset → …
//
//   - Tokenized stocks come only from lib/markets/base-pairs.ts's live
//     official catalog (the same list the swap path quotes). Nothing is
//     invented from the wider stock market.
//   - Coinbase assets are the wrapped assets + native USDC from that
//     same typed allowlist, priced by GET /api/market/tape.
//
// There is no static section label any more (the old "COINBASE · BASE" /
// "Stocks B20" markers are gone) — the mixed sequence itself is the
// tape. The marquee is seamless: the base sequence is repeated and the
// track translates by exactly one copy, so there is no visible reset or
// jump on mobile or desktop. Monospace tabular prices; red/green is
// reserved for the 24h % only. A stale leg renders an amber dot +
// "stale" — never a fabricated price.
//
// Clicking a chip still opens the PairSheet (right drawer desktop,
// bottom sheet mobile), which owns the asset detail + Prepare Swap flow.

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";

import { PairSheet } from "./PairSheet";
import { formatChange24h, formatTapeUsd, useTape } from "@/hooks/useTape";
import { interleaveTapeEntries, tapeMarqueeCopies } from "@/lib/markets/tape-order";
import type { TapeStockEntry, TapeWrappedEntry } from "@/lib/markets/tape-types";

export interface LiveTapeProps {
  /** Fired when the pair sheet's "Prepare swap USDC → X" button is used. */
  onPrepareSwap?: (symbol: string) => void;
  className?: string;
}

interface TapeChipModel {
  key: string;
  symbol: string;
  usd: number | null;
  change24h: number | null;
  stale: boolean;
}

type ChipModel = TapeChipModel | null;

// Display-only: USDC is deliberately hidden from the TOP ticker chips.
// It stays everywhere else — the tape API, the agent's get_tape tool,
// pair/quote logic and swaps all still report and use USDC (it is the
// quote asset for every B20 pool). This filter only changes what the
// live tape at the top of the screen shows.
const TICKER_HIDDEN_SYMBOLS = new Set(["USDC"]);

function wrappedToChip(entry: TapeWrappedEntry): TapeChipModel | null {
  if (TICKER_HIDDEN_SYMBOLS.has(entry.symbol)) return null;
  return {
    key: `w-${entry.symbol}`,
    symbol: entry.symbol,
    usd: entry.usd,
    change24h: entry.change24h,
    stale: entry.stale,
  };
}

function stockToChip(entry: TapeStockEntry): TapeChipModel {
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

function TapeChip({ chip, onSelect }: { chip: TapeChipModel; onSelect: (symbol: string) => void }) {
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
        <span className={clsx("tabular-nums text-[10px]", up ? "text-good" : "text-bad")}>
          {change}
        </span>
      ) : null}
    </button>
  );
}

function TapeSequence({
  chips,
  onSelect,
  sequenceRef,
}: {
  chips: TapeChipModel[];
  onSelect: (symbol: string) => void;
  sequenceRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={sequenceRef} className="flex shrink-0 items-center gap-1 pr-1">
      {chips.map((chip) => (
        <TapeChip key={chip.key} chip={chip} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function LiveTape({ onPrepareSwap, className }: LiveTapeProps) {
  const { snapshot, loading, error } = useTape();
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [copies, setCopies] = useState(2);
  const measureRef = useRef<HTMLDivElement>(null);

  const openPair = (symbol: string) => setSelectedSymbol(symbol);
  const closePair = () => setSelectedSymbol(null);
  const handlePrepareSwap = (symbol: string) => {
    setSelectedSymbol(null);
    onPrepareSwap?.(symbol);
  };

  const wrappedChips = useMemo(
    () =>
      (snapshot?.wrapped ?? [])
        .map(wrappedToChip)
        .filter((chip): chip is TapeChipModel => chip !== null),
    [snapshot?.wrapped],
  );
  const stockChips = useMemo(
    () => (snapshot?.stocks ?? []).map(stockToChip),
    [snapshot?.stocks],
  );

  // stock → Coinbase asset → stock → Coinbase asset → …
  const baseSequence = useMemo(
    () => interleaveTapeEntries(stockChips, wrappedChips),
    [stockChips, wrappedChips],
  );

  // Keep the marquee covered on wide screens: one copy of the sequence
  // is measured once (and on resize), never per price refresh.
  useEffect(() => {
    const measure = () => {
      const width = measureRef.current?.scrollWidth ?? 0;
      const viewport = typeof window === "undefined" ? 0 : window.innerWidth;
      setCopies(tapeMarqueeCopies(width, viewport));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [baseSequence.length]);

  const trackStyle = { ["--tape-copies" as string]: String(copies) };
  const renderedSequence = useMemo(
    () => Array.from({ length: copies }, (_, copyIndex) =>
      baseSequence.map((chip) => ({ chip, key: `${chip.key}-${copyIndex}` })),
    ).flat(),
    [baseSequence, copies],
  );

  return (
    <>
      <div
        className={clsx(
          "z-40 flex h-9 w-full items-stretch overflow-hidden border-b border-white/[0.06] bg-[#070C16] md:h-10",
          className,
        )}
        data-testid="live-tape"
      >
        {baseSequence.length === 0 ? (
          <div className="flex h-full items-center gap-2 px-3">
            <span className="font-mono text-[11px] text-muted">waiting for prices…</span>
          </div>
        ) : (
          <div className="group relative flex h-full min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_20px,black_calc(100%-20px),transparent)]">
            {/* Measurement copy — layout only, never visible or focusable. */}
            <div
              aria-hidden="true"
              className="pointer-events-none invisible absolute h-0 w-max overflow-hidden"
            >
              <TapeSequence chips={baseSequence} onSelect={openPair} sequenceRef={measureRef} />
            </div>
            <div
              className="flex h-full w-max items-center py-0.5 animate-tape-marquee group-hover:[animation-play-state:paused]"
              style={trackStyle}
              aria-hidden="true"
            >
              {renderedSequence.map(({ chip, key }) => (
                <TapeChip key={key} chip={chip} onSelect={openPair} />
              ))}
            </div>
          </div>
        )}
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
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-good">
              <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden="true" />
              live
            </span>
          )}
        </div>
      </div>

      {/* Screen-reader / no-JS-motion fallback: the same mixed sequence, static. */}
      <div className="sr-only">
        <p>Live Base tape</p>
        <ul>
          {baseSequence.map((chip) => (
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
        preview={
          selectedSymbol
            ? (baseSequence.find((chip) => chip.symbol === selectedSymbol) ?? null)
            : null
        }
      />
    </>
  );
}
