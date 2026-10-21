// lib/swap/v2/coverage-probe.ts
//
// Coverage-harness probe sizing. This module is NOT part of the production quote or
// execution path: production always quotes the amount the user actually asked for.
// It exists because the coverage matrix has to invent an amount, and the amount it
// invented was wrong.
//
// The matrix probed every pair with a fixed `1_000_000` raw units regardless of
// decimals. That is `1.00 USDC` at 6 decimals but `10^-12` of any 18-decimal token,
// so a venue could answer zero purely because integer arithmetic has no smaller unit
// than 1 wei. Attribution proved it for MPGR: the SELL leg asked about 997_500 wei,
// and at the fork-measured rate of 5.9976e-9 wei WETH per wei MPGR that is 0.00598
// wei of WETH — which floors to zero. The same direction executes at 1e18 on a real
// fork. So the matrix reported a routing fact that was actually a rounding artefact.
//
// The rules below are deliberately conservative, because a probe that is too large is
// as dishonest as one that is too small: it can exhaust a thin pool, move the price
// enough to make the quoted rate meaningless, or overflow the venue's arithmetic.
import { V2QuoteError, type RouteFailureAttribution } from "./discovery";

/**
 * Fractions of one whole unit, ascending, as integer exponents — never floats, so the
 * resulting raw amounts are exact.
 *
 * The span is three orders of magnitude and the top rung is one hundredth of a unit,
 * which keeps the notional small enough that a quote is not distorted by price impact
 * while still clearing integer resolution for tokens worth very little per unit.
 */
export const PROBE_EXPONENTS = [-6, -4, -2] as const;

/** `gross * 25 / 10_000` must be at least 1 wei, or `discoverV2Quote` rejects the
 * probe as `INVALID_AMOUNT` before any venue is asked. 400 is that floor exactly. */
export const MIN_PROBE_GROSS = 400n;

/** Ceiling. Above this a venue's internal arithmetic can overflow and, more
 * importantly, no quoted rate means anything: it is a probe, not a trade. */
export const MAX_PROBE_GROSS = 10n ** 24n;

/** Used only when `decimals()` could not be read. 18 is the common Base case and, of
 * the plausible choices, produces the LARGEST raw amounts — the safe direction, since
 * the failure this module exists to prevent is a probe too small to resolve. Rows
 * sized this way are marked as assumed and are never presented as decimals-derived. */
export const ASSUMED_DECIMALS = 18;

/** Decimals outside this range are not a token fact we can size against. */
export const MIN_DECIMALS = 0;
export const MAX_DECIMALS = 36;

export interface ProbeRung {
  /** Exact raw amount to pass as `gross`. */
  gross: bigint;
  /** What that amount means in human terms, for the report. */
  label: string;
  /** True when the on-chain decimals could not be read and were assumed. */
  assumed: boolean;
  /** The decimals this ladder was sized from (actual or assumed). */
  decimals: number;
}

export function usableDecimals(decimals: number | null | undefined): number | null {
  if (typeof decimals !== "number" || !Number.isInteger(decimals)) return null;
  if (decimals < MIN_DECIMALS || decimals > MAX_DECIMALS) return null;
  return decimals;
}

/**
 * The ascending probe ladder for a token: at most one rung per fraction, clamped into
 * `[MIN_PROBE_GROSS, MAX_PROBE_GROSS]` and de-duplicated, so a low-decimals token does
 * not get asked the same question three times.
 *
 * Sizing comes from the token being SOLD, so each direction of a pair is sized
 * independently: `MPGR -> WETH` is sized from MPGR's decimals and `WETH -> MPGR` from
 * WETH's. That asymmetry is the whole point — the two directions of one pool have
 * different integer resolutions.
 */
export function probeLadder(decimals: number | null | undefined): ProbeRung[] {
  const actual = usableDecimals(decimals);
  const used = actual ?? ASSUMED_DECIMALS;
  const assumed = actual === null;
  const rungs: ProbeRung[] = [];
  for (const exponent of PROBE_EXPONENTS) {
    const power = used + exponent;
    let gross = power < 0 ? 0n : 10n ** BigInt(power);
    if (gross < MIN_PROBE_GROSS) gross = MIN_PROBE_GROSS;
    if (gross > MAX_PROBE_GROSS) gross = MAX_PROBE_GROSS;
    if (rungs.some((rung) => rung.gross === gross)) continue;
    rungs.push({ gross, label: describeRung(exponent, used), assumed, decimals: used });
  }
  return rungs;
}

function describeRung(exponent: number, decimals: number): string {
  return exponent === 0 ? `1 unit of a ${decimals}-decimal token` : `1e${exponent} units of a ${decimals}-decimal token`;
}

/** Compact, exact rendering for a report column: powers of ten read as `1e12`. */
export function formatProbeAmount(gross: bigint): string {
  if (gross <= 0n) return gross.toString();
  let value = gross;
  let exponent = 0;
  while (value % 10n === 0n) { value /= 10n; exponent++; }
  if (value === 1n && exponent > 0) return `1e${exponent}`;
  return gross.toString();
}

/**
 * Whether a failed probe is worth retrying at a larger size.
 *
 * Only a *resolution* failure qualifies: the venue answered zero, or it reverted in a
 * way that a too-small amount can cause (many venues revert rather than return zero
 * when the computed output rounds below their minimum). A provider failure, an
 * exhausted budget, a pool the executor could not address, or "no pool was discovered"
 * are not sizing problems — escalating those would burn the shard's remaining budget
 * and could dress an honest UNMEASURED up as something it is not.
 */
export const PROBE_ESCALATION_ATTRIBUTIONS: readonly RouteFailureAttribution[] = [
  "QUOTE_ZERO_OUTPUT", "VENUE_REJECTED_SWAP", "HOOK_OR_TOKEN_INCOMPATIBLE",
];

export function shouldEscalateProbe(error: unknown): boolean {
  // A timeout or transport failure is not a V2QuoteError and says nothing about size.
  if (!(error instanceof V2QuoteError)) return false;
  if (!error.attribution) return false;
  return PROBE_ESCALATION_ATTRIBUTIONS.includes(error.attribution);
}

export interface ProbeAttempt {
  gross: bigint;
  label: string;
  /** What this rung produced: a quote, an attributed routing failure, or an
   * unattributed error (a timeout or transport failure). */
  verdict: "quoted" | RouteFailureAttribution | "error";
  amountOut?: bigint;
}

export interface ProbeResult<T> {
  outcome: { ok: true; quote: T } | { ok: false; error: unknown };
  /** Every rung that was tried, in order, so an escalated verdict is auditable. */
  attempts: ProbeAttempt[];
  /** The rung the reported verdict came from. */
  rung: ProbeRung;
  /** True when more than one rung was tried. */
  escalated: boolean;
  /** Human-readable ladder history for the row. */
  note: string;
}

/**
 * Runs the ladder for one pair: try the smallest rung, and escalate ONLY when the
 * failure is a resolution failure. Stops at the first rung that produces a verdict
 * worth reporting, so a healthy pair costs exactly one quote.
 *
 * `run` is supplied by the caller — the matrix passes `discoverV2Quote` wrapped in its
 * per-pair timeout — which keeps this module free of any RPC or discovery dependency
 * and, more importantly, means the ladder the tests exercise is the ladder the harness
 * runs.
 */
export async function probePair<T extends { amountOut: bigint }>(
  run: (gross: bigint) => Promise<T>,
  decimals: number | null | undefined,
): Promise<ProbeResult<T>> {
  const ladder = probeLadder(decimals);
  const attempts: ProbeAttempt[] = [];
  let last: { ok: true; quote: T } | { ok: false; error: unknown } = { ok: false, error: new Error("the probe ladder was empty") };
  let rung = ladder[0];
  for (const candidate of ladder) {
    rung = candidate;
    try {
      const quote = await run(candidate.gross);
      attempts.push({ gross: candidate.gross, label: candidate.label, verdict: "quoted", amountOut: quote.amountOut });
      last = { ok: true, quote };
      break;
    } catch (error) {
      const attribution = error instanceof V2QuoteError ? error.attribution : undefined;
      attempts.push({ gross: candidate.gross, label: candidate.label, verdict: attribution ?? "error" });
      last = { ok: false, error };
      // Escalating anything else would spend the shard's remaining budget on a failure
      // that a different amount cannot fix.
      if (!shouldEscalateProbe(error)) break;
    }
  }
  const sized = rung.assumed
    ? `probe sized from ASSUMED ${rung.decimals} decimals because on-chain decimals() was unreadable`
    : `probe sized from ${rung.decimals} on-chain decimals`;
  const history = attempts.map((a) => `${formatProbeAmount(a.gross)} raw -> ${a.verdict}`).join(", ");
  return {
    outcome: last, attempts, rung, escalated: attempts.length > 1,
    note: `${sized}; verdict taken at ${formatProbeAmount(rung.gross)} raw units (${rung.label})`
      + (attempts.length > 1 ? `; ladder: ${history}` : ""),
  };
}

/** One line for the report header, so a reader knows what every verdict was measured
 * at before reading a single row. */
export function describeProbePolicy(): string {
  return "Probe sizing: derived from each token's on-chain `decimals()` (assumed "
    + `${ASSUMED_DECIMALS} when unreadable, and marked as assumed); ladder `
    + PROBE_EXPONENTS.map((e) => `1e${e}`).join(" → ")
    + " of one unit of the token being sold, clamped to "
    + `[${MIN_PROBE_GROSS}, ${formatProbeAmount(MAX_PROBE_GROSS)}] raw units; each direction sized independently; `
    + "escalated only when the venue answered zero or reverted, never on a provider, budget or validation failure. "
    + "The amount behind every verdict is in the Probe column.";
}
