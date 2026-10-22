// lib/swap/v2/__tests__/coverage-probe.test.ts
//
// EVIDENCE TIER — SIMULATED arithmetic over REAL measured numbers. No RPC was
// contacted. The exchange rates used below are not invented: they are the outputs the
// fork proof measured on real Base state, quoted here so the harness's integer
// arithmetic can be checked against a rate the chain actually produced.
//
//   `testForkMPGRV4FeeAndMinimum`, fork block 52892463, MPGR -> WETH, one hop:
//     GROSS 1000000000000000000, FEE_AMOUNT 2500000000000000 (exactly 25 bps),
//     NET_OUTPUT 5997618925 wei WETH
//   `testForkRealV4PoolIdAndFee`-family run, USDC -> WETH:
//     GROSS 100000000 (100 USDC at 6 decimals), NET_OUTPUT 41002440555149133 wei WETH
//
// Those two rates are the reason this module exists: at the harness's old fixed probe
// of 1_000_000 raw units, the MPGR leg asks a venue about 997_500 wei of an
// 18-decimal token, whose output is 0.00598 wei of WETH and therefore zero — while the
// USDC leg at the same 1_000_000 raw units is a perfectly sized 1.00 USDC. One constant
// cannot be right for both, and the matrix reported the rounding artefact as a routing
// fact.
import { describe, expect, it } from "vitest";
import {
  ASSUMED_DECIMALS, MAX_DECIMALS, MAX_PROBE_GROSS, MIN_DECIMALS, MIN_PROBE_GROSS, PROBE_EXPONENTS,
  PROBE_ESCALATION_ATTRIBUTIONS, describeProbePolicy, formatProbeAmount, probeLadder, probePair,
  shouldEscalateProbe, usableDecimals, type ProbeRung,
} from "../coverage-probe";
import { V2QuoteError, type RouteFailureAttribution } from "../discovery";

const FEE_BPS = 25n;
const feeOf = (gross: bigint): bigint => (gross * FEE_BPS) / 10_000n;
const netOf = (gross: bigint): bigint => gross - feeOf(gross);

/** What the harness used to probe every pair with, whatever the token. */
const LEGACY_PROBE = 1_000_000n;

/** Fork-measured MPGR -> WETH: 5997618925 wei WETH out per 1e18 wei MPGR in (net). */
const MPGR_TO_WETH_NUM = 5_997_618_925n;
const MPGR_TO_WETH_DEN = 1_000_000_000_000_000_000n;
/** Fork-measured USDC -> WETH: 41002440555149133 wei WETH out per 99_750_000 raw USDC in. */
const USDC_TO_WETH_NUM = 41_002_440_555_149_133n;
const USDC_TO_WETH_DEN = 99_750_000n;

/** A venue as integer arithmetic: floors, exactly like Solidity, and answers zero when
 * the true output is below one wei of the output token. */
const venue = (num: bigint, den: bigint) => (net: bigint): bigint => (net * num) / den;

/** The five attributions that are NOT worth a bigger probe. */
const NON_ESCALATING: RouteFailureAttribution[] = [
  "BUDGET_EXHAUSTED", "QUOTE_RPC_FAILED", "EXECUTOR_VALIDATION_REJECTED", "POOL_NOT_DISCOVERED", "MULTIHOP_ENUMERATION_UNAVAILABLE",
];
const attributed = (attribution: RouteFailureAttribution, message = "stub"): V2QuoteError => {
  const error = new V2QuoteError("DISCOVERY_UNAVAILABLE", message);
  error.attribution = attribution;
  return error;
};

describe("the legacy fixed probe was wrong for 18-decimal tokens and right for 6-decimal ones", () => {
  const mpgrToWeth = venue(MPGR_TO_WETH_NUM, MPGR_TO_WETH_DEN);
  const usdcToWeth = venue(USDC_TO_WETH_NUM, USDC_TO_WETH_DEN);

  it("floored MPGR -> WETH to zero, which is the artefact attribution exposed", () => {
    // 997_500 wei of MPGR is worth 0.00598 wei of WETH. Integer arithmetic has no
    // smaller unit, so the venue answered zero and the matrix read that as a routing
    // fact.
    expect(netOf(LEGACY_PROBE)).toBe(997_500n);
    expect(mpgrToWeth(netOf(LEGACY_PROBE))).toBe(0n);
  });

  it("sized USDC -> WETH sensibly, so the fix must not regress 6-decimal tokens", () => {
    // 1_000_000 raw USDC is exactly 1.00 USDC: the legacy constant was never wrong for
    // 6-decimal tokens, only for the rest.
    expect(usdcToWeth(netOf(LEGACY_PROBE))).toBeGreaterThan(0n);
    const firstRung = probeLadder(6)[0];
    expect(firstRung.gross).toBe(MIN_PROBE_GROSS);
    expect(usdcToWeth(netOf(firstRung.gross))).toBeGreaterThan(0n);
    // Every rung of the 6-decimal ladder still resolves, so nothing that used to be
    // measurable becomes unmeasurable.
    for (const rung of probeLadder(6)) expect(usdcToWeth(netOf(rung.gross))).toBeGreaterThan(0n);
  });

  it("resolves MPGR -> WETH SELL on the first rung of an 18-decimal ladder", () => {
    const ladder = probeLadder(18);
    expect(ladder[0].gross).toBe(10n ** 12n); // 1e-6 of one MPGR
    expect(feeOf(ladder[0].gross)).toBeGreaterThan(0n);
    // 997_500_000_000 wei of MPGR at the fork-measured rate is 5982 wei of WETH: small,
    // exact, and above integer resolution.
    expect(mpgrToWeth(netOf(ladder[0].gross))).toBe(5_982n);
  });

  it("resolves WETH -> MPGR BUY on the first rung too, sized from WETH's own decimals", () => {
    // The inverse rate: what 1 wei of WETH buys in wei of MPGR.
    const wethToMpgr = venue(MPGR_TO_WETH_DEN, MPGR_TO_WETH_NUM);
    const rung = probeLadder(18)[0];
    expect(wethToMpgr(netOf(rung.gross))).toBeGreaterThan(0n);
    // And the legacy probe also resolved this direction — which is exactly why BUY
    // measured executable while SELL did not, on the same pool.
    expect(wethToMpgr(netOf(LEGACY_PROBE))).toBeGreaterThan(0n);
  });

  it("never asks a venue about an amount whose fee would round to zero", () => {
    // `discoverV2Quote` rejects gross amounts below 400 raw units as INVALID_AMOUNT
    // before any venue is consulted, so every rung must clear that floor.
    for (let decimals = MIN_DECIMALS; decimals <= MAX_DECIMALS; decimals++) {
      for (const rung of probeLadder(decimals)) {
        expect(feeOf(rung.gross)).toBeGreaterThanOrEqual(1n);
        expect(netOf(rung.gross)).toBeGreaterThan(0n);
      }
    }
  });
});

describe("probeLadder: bounded, exact, and sized per token", () => {
  it("derives exact powers of ten from the token's decimals, ascending and de-duplicated", () => {
    expect(probeLadder(18).map((r) => r.gross)).toEqual([10n ** 12n, 10n ** 14n, 10n ** 16n]);
    expect(probeLadder(8).map((r) => r.gross)).toEqual([MIN_PROBE_GROSS, 10_000n, 1_000_000n]);
    // A 6-decimal token's 1e-6 and 1e-4 rungs both clamp to the fee floor, so they
    // collapse into one question instead of being asked twice.
    expect(probeLadder(6).map((r) => r.gross)).toEqual([MIN_PROBE_GROSS, 10_000n]);
    expect(probeLadder(0).map((r) => r.gross)).toEqual([MIN_PROBE_GROSS]);
    for (let decimals = MIN_DECIMALS; decimals <= MAX_DECIMALS; decimals++) {
      const ladder = probeLadder(decimals);
      expect(ladder.length).toBeGreaterThan(0);
      expect(ladder.length).toBeLessThanOrEqual(PROBE_EXPONENTS.length);
      const amounts = ladder.map((r) => r.gross);
      expect(new Set(amounts).size).toBe(amounts.length);
      for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThan(amounts[i - 1]);
      for (const gross of amounts) {
        expect(gross).toBeGreaterThanOrEqual(MIN_PROBE_GROSS);
        expect(gross).toBeLessThanOrEqual(MAX_PROBE_GROSS);
      }
    }
  });

  it("clamps absurd decimals instead of overflowing or probing an unusable amount", () => {
    expect(probeLadder(MAX_DECIMALS).map((r) => r.gross)).toEqual([MAX_PROBE_GROSS]);
    expect(probeLadder(200).every((r) => r.gross <= MAX_PROBE_GROSS)).toBe(true);
  });

  it("labels every rung with the decimals it was sized from", () => {
    expect(probeLadder(18)[0].label).toMatch(/1e-6 units of a 18-decimal token/);
    expect(probeLadder(6)[1].label).toMatch(/1e-2 units of a 6-decimal token/);
  });

  it("assumes 18 decimals when decimals() is unreadable, and says so", () => {
    for (const unknown of [null, undefined, Number.NaN, 1.5, -1, MAX_DECIMALS + 1]) {
      const ladder = probeLadder(unknown as number | null | undefined);
      expect(ladder.map((r) => r.gross)).toEqual(probeLadder(ASSUMED_DECIMALS).map((r) => r.gross));
      expect(ladder.every((r) => r.assumed)).toBe(true);
      expect(ladder.every((r) => r.decimals === ASSUMED_DECIMALS)).toBe(true);
    }
    expect(probeLadder(18).every((r) => r.assumed)).toBe(false);
    expect(usableDecimals(18)).toBe(18);
    expect(usableDecimals(0)).toBe(0);
    expect(usableDecimals(null)).toBeNull();
    expect(usableDecimals(1.5)).toBeNull();
  });

  it("sizes each direction independently, from the token being sold", () => {
    // MPGR -> WETH is sized from MPGR; WETH -> MPGR from WETH. Same pool, opposite
    // direction, different integer resolution — the asymmetry the matrix mis-reported.
    expect(probeLadder(18)[0].gross).not.toBe(probeLadder(6)[0].gross);
    expect(probeLadder(6)[0].gross).toBe(MIN_PROBE_GROSS);
  });
});

describe("shouldEscalateProbe: only a resolution failure earns a bigger probe", () => {
  it("escalates a zero answer and a revert, which a too-small amount can cause", () => {
    for (const attribution of PROBE_ESCALATION_ATTRIBUTIONS) {
      expect(shouldEscalateProbe(attributed(attribution))).toBe(true);
    }
    expect(PROBE_ESCALATION_ATTRIBUTIONS).toEqual(["QUOTE_ZERO_OUTPUT", "VENUE_REJECTED_SWAP", "HOOK_OR_TOKEN_INCOMPATIBLE"]);
  });

  it("refuses to escalate failures a bigger amount cannot fix", () => {
    for (const attribution of NON_ESCALATING) {
      expect(shouldEscalateProbe(attributed(attribution))).toBe(false);
    }
    // No attribution at all (a defect-shaped or unknown routing error): do not guess.
    expect(shouldEscalateProbe(new V2QuoteError("LIQUIDITY_UNAVAILABLE", "no route"))).toBe(false);
    // A timeout or transport failure is not even a V2QuoteError.
    expect(shouldEscalateProbe(new Error("discovery exceeded 120000ms"))).toBe(false);
    expect(shouldEscalateProbe("HTTP request failed.\n\nStatus: 429")).toBe(false);
  });
});

describe("probePair: the ladder the harness actually runs", () => {
  const quote = (amountOut: bigint) => ({ amountOut });

  it("stops at the first rung that quotes, so a healthy pair costs one call", async () => {
    const seen: bigint[] = [];
    const result = await probePair(async (gross) => { seen.push(gross); return quote(5_982n); }, 18);
    expect(seen).toEqual([10n ** 12n]);
    expect(result.outcome.ok).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.rung.gross).toBe(10n ** 12n);
    expect(result.note).toMatch(/18 on-chain decimals/);
    expect(result.note).toMatch(/verdict taken at 1e12 raw units/);
  });

  it("escalates a zero answer and reports the verdict at the rung that produced it", async () => {
    const seen: bigint[] = [];
    const result = await probePair(async (gross) => {
      seen.push(gross);
      // Resolves only at 1e-4 of a unit: the classic dust-rounding case.
      if (gross < 10n ** 14n) throw attributed("QUOTE_ZERO_OUTPUT", "answered zero output");
      return quote(598_262n);
    }, 18);
    expect(seen).toEqual([10n ** 12n, 10n ** 14n]);
    expect(result.outcome.ok).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.rung.gross).toBe(10n ** 14n);
    expect(result.attempts.map((a) => a.verdict)).toEqual(["QUOTE_ZERO_OUTPUT", "quoted"]);
    // The ladder history is on the row, so an escalated verdict cannot be mistaken for
    // a first-try one.
    expect(result.note).toMatch(/ladder: 1e12 raw -> QUOTE_ZERO_OUTPUT, 1e14 raw -> quoted/);
  });

  it("does not escalate a provider failure, a budget or a validation rejection", async () => {
    for (const attribution of NON_ESCALATING) {
      const seen: bigint[] = [];
      const result = await probePair(async (gross) => { seen.push(gross); throw attributed(attribution); }, 18);
      expect(seen, `${attribution} must not be retried at a bigger size`).toEqual([10n ** 12n]);
      expect(result.outcome.ok).toBe(false);
      expect(result.escalated).toBe(false);
      expect(result.attempts[0].verdict).toBe(attribution);
    }
  });

  it("records a timeout as an unattributed error and does not retry it", async () => {
    const seen: bigint[] = [];
    const result = await probePair(async (gross) => {
      seen.push(gross);
      throw new Error("discovery exceeded 120000ms");
    }, 18);
    expect(seen).toHaveLength(1);
    expect(result.attempts[0].verdict).toBe("error");
    expect(result.escalated).toBe(false);
    expect(result.outcome.ok).toBe(false);
  });

  it("exhausts the ladder honestly when no size resolves, keeping the last failure", async () => {
    const seen: bigint[] = [];
    const result = await probePair(async (gross) => { seen.push(gross); throw attributed("QUOTE_ZERO_OUTPUT"); }, 18);
    expect(seen).toEqual([10n ** 12n, 10n ** 14n, 10n ** 16n]);
    expect(result.outcome.ok).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.rung.gross).toBe(10n ** 16n);
    expect((result.outcome as { error: V2QuoteError }).error.attribution).toBe("QUOTE_ZERO_OUTPUT");
    // Exhausting the ladder is still UNMEASURED: three zero answers at three sizes do
    // not prove the pair lacks liquidity, and nothing here claims otherwise.
    expect(result.attempts.every((a) => a.verdict === "QUOTE_ZERO_OUTPUT")).toBe(true);
  });

  it("marks an assumed-decimals probe so it is never read as a measured size", async () => {
    const result = await probePair(async () => quote(1n), null);
    expect(result.rung.assumed).toBe(true);
    expect(result.note).toMatch(/ASSUMED 18 decimals/);
    expect(result.note).toMatch(/decimals\(\) was unreadable/);
  });

  it("preserves the fee invariant at every rung it actually sends", async () => {
    const sent: bigint[] = [];
    await probePair(async (gross) => { sent.push(gross); throw attributed("QUOTE_ZERO_OUTPUT"); }, 18);
    expect(sent).toHaveLength(3);
    for (const gross of sent) {
      // 25 bps on gross, computed once, must be at least one wei and strictly less than
      // gross — the same invariant production enforces via validateV2Quote.
      expect(feeOf(gross)).toBe((gross * 25n) / 10_000n);
      expect(feeOf(gross)).toBeGreaterThanOrEqual(1n);
      expect(feeOf(gross)).toBeLessThan(gross);
    }
  });
});

describe("reporting helpers", () => {
  it("renders powers of ten compactly and everything else exactly", () => {
    expect(formatProbeAmount(10n ** 12n)).toBe("1e12");
    expect(formatProbeAmount(10n ** 16n)).toBe("1e16");
    expect(formatProbeAmount(MAX_PROBE_GROSS)).toBe("1e24");
    expect(formatProbeAmount(400n)).toBe("400");
    expect(formatProbeAmount(997_500n)).toBe("997500");
    expect(formatProbeAmount(0n)).toBe("0");
  });

  it("states the policy a reader needs before trusting any row", () => {
    const policy = describeProbePolicy();
    expect(policy).toMatch(/on-chain `decimals\(\)`/);
    expect(policy).toMatch(/assumed 18/);
    expect(policy).toMatch(/1e-6 → 1e-4 → 1e-2/);
    expect(policy).toMatch(/each direction sized independently/);
    expect(policy).toMatch(/escalated only when the venue answered zero or reverted/);
    expect(policy).toMatch(/\[400, 1e24\]/);
  });

  it("keeps the ladder within bounds the venue arithmetic can hold", () => {
    // uint128 is what a v4 `exactAmount` is: a probe above it would be rejected by the
    // ABI rather than measured.
    expect(MAX_PROBE_GROSS).toBeLessThan(2n ** 128n);
    for (const rung of probeLadder(18) as ProbeRung[]) expect(rung.gross).toBeLessThan(2n ** 128n);
  });
});
