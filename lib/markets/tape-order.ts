// lib/markets/tape-order.ts
//
// Pure ordering helper for the Base Stocks live tape.
//
// The ticker interleaves the two authoritative sources it already has:
// official Coinbase Tokenized Stocks (B20, live catalog only —
// lib/markets/base-pairs.ts) and Coinbase wrapped assets + native USDC
// from the same allowlist. Nothing else is ever inserted: no arbitrary
// stock tickers, no assets that the official source does not carry.
//
// Order is deterministic (stock → Coinbase asset → stock → …) so the
// marquee loop is stable across 15s tape refreshes: a re-render with the
// same symbols produces the identical sequence, which is what keeps the
// loop seamless instead of jumping when the price data updates.

/**
 * Alternates `primary[0], secondary[0], primary[1], secondary[1], …`
 * and appends whatever is left once one side runs out.
 */
export function interleaveTapeEntries<T>(
  primary: readonly T[],
  secondary: readonly T[],
): T[] {
  const out: T[] = [];
  const max = Math.max(primary.length, secondary.length);
  for (let i = 0; i < max; i++) {
    const first = primary[i];
    if (first !== undefined) out.push(first);
    const second = secondary[i];
    if (second !== undefined) out.push(second);
  }
  return out;
}

/**
 * How many copies of the base sequence the marquee track needs so that
 * the -100/copies% translation is always covered by content (no blank
 * gap at the right edge) on this viewport. Bounded: 2–5 copies.
 */
export function tapeMarqueeCopies(baseWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(baseWidth) || baseWidth <= 0) return 2;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 2;
  return Math.min(5, Math.max(2, Math.ceil(viewportWidth / baseWidth) + 1));
}
