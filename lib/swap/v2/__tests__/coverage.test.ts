// Coverage-matrix classification. The property that matters most is negative
// honesty: an RPC or index failure must be recorded as UNMEASURED, never as
// missing liquidity, so a coverage report can never claim a negative it did not
// establish.
import { describe, expect, it } from "vitest";
import { V2QuoteError } from "../discovery";
import {
  classifyPairOutcome, classifyTokenSupport, renderCoverageMarkdown, summarizeCoverage,
  type PairCoverageRow, type TokenSupportFacts,
} from "../coverage";

const A = "0xa111111111111111111111111111111111111111";
const B = "0xb222222222222222222222222222222222222222";

const okQuote = (kinds: number[][], legs = 1) => ({
  ok: true as const,
  quote: {
    amountOut: 1000n,
    legs: Array.from({ length: legs }, (_, i) => ({ pools: kinds[i].map((kind) => ({ kind })) })),
  },
});
const facts = (over: Partial<TokenSupportFacts> = {}): TokenSupportFacts =>
  ({ address: A, hasCode: true, decimals: 18, symbol: "TKA", readable: true, ...over });

describe("classifyTokenSupport", () => {
  it("treats an unreadable token as UNMEASURED, not unsupported", () => {
    const r = classifyTokenSupport(facts({ readable: false }));
    expect(r.category).toBe("UNMEASURED_PROVIDER_FAILURE");
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/unmeasured, not absent/i);
  });

  it("reports a non-contract as unsupported infrastructure", () => {
    const r = classifyTokenSupport(facts({ hasCode: false }));
    expect(r.category).toBe("UNSUPPORTED_TOKEN_INFRASTRUCTURE");
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/no runtime code/i);
  });

  it("treats the native ETH sentinel as supported even though it has no code", () => {
    // The sentinel is a pseudo-address normalized to WETH, so "no runtime code"
    // must not become an unsupported-infrastructure verdict.
    const r = classifyTokenSupport(facts({ address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", hasCode: false, decimals: null, symbol: null, readable: true }));
    expect(r.supported).toBe(true);
    // And it must not be reported as unmeasured either.
    expect(r.category).not.toBe("UNMEASURED_PROVIDER_FAILURE");
  });

  it("reports missing decimals as unsupported infrastructure", () => {
    expect(classifyTokenSupport(facts({ decimals: null })).supported).toBe(false);
    expect(classifyTokenSupport(facts({ decimals: 300 })).supported).toBe(false);
    expect(classifyTokenSupport(facts({ decimals: 6 })).supported).toBe(true);
  });
});

describe("classifyPairOutcome — measured results", () => {
  it("records an executable route with its hop, leg and venue shape", () => {
    const row = classifyPairOutcome(A, B, okQuote([[2]]));
    expect(row).toMatchObject({ category: "EXECUTABLE_ROUTE", measured: true, hops: 1, legs: 1, venueKinds: [2], amountOut: "1000" });
  });

  it("records a mixed-venue multi-hop and a split route", () => {
    const multi = classifyPairOutcome(A, B, okQuote([[1, 2, 7]]));
    expect(multi).toMatchObject({ hops: 3, legs: 1, venueKinds: [1, 2, 7] });
    const split = classifyPairOutcome(A, B, okQuote([[2], [4]], 2));
    expect(split).toMatchObject({ legs: 2, hops: 1, venueKinds: [2, 4] });
  });

  it("separates missing liquidity from unsupported token infrastructure", () => {
    const noPool = classifyPairOutcome(A, B, { ok: false, error: new V2QuoteError("LIQUIDITY_UNAVAILABLE", "No liquid route") },
      { from: facts(), to: facts({ address: B }) });
    expect(noPool).toMatchObject({ category: "MISSING_LIQUIDITY", measured: true });
    expect(noPool.reason).toMatch(/valid Base assets/i);

    const deadToken = classifyPairOutcome(A, B, { ok: false, error: new V2QuoteError("LIQUIDITY_UNAVAILABLE", "No liquid route") },
      { from: facts(), to: facts({ address: B, hasCode: false }) });
    expect(deadToken).toMatchObject({ category: "UNSUPPORTED_TOKEN_INFRASTRUCTURE", measured: true });
    expect(deadToken.reason).toMatch(/no runtime code/i);
  });

  it("flags a broken fee invariant as a defect, not as coverage", () => {
    const row = classifyPairOutcome(A, B, { ok: false, error: new V2QuoteError("FEE_POLICY_INVALID", "Invalid gross-input fee") });
    expect(row).toMatchObject({ category: "FEE_INVARIANT_DEFECT", measured: true });
  });
});

describe("classifyPairOutcome — negative honesty", () => {
  it("records a discovery outage as UNMEASURED, never as missing liquidity", () => {
    const row = classifyPairOutcome(A, B, { ok: false, error: new V2QuoteError("DISCOVERY_UNAVAILABLE", "Index unavailable") });
    expect(row.category).toBe("UNMEASURED_PROVIDER_FAILURE");
    expect(row.measured).toBe(false);
    expect(row.category).not.toBe("MISSING_LIQUIDITY");
  });

  it("records an unexpected error as UNMEASURED", () => {
    const row = classifyPairOutcome(A, B, { ok: false, error: new Error("socket hang up") });
    expect(row).toMatchObject({ category: "UNMEASURED_PROVIDER_FAILURE", measured: false });
  });

  it("does not count a bad probe input as a measurement", () => {
    for (const code of ["INVALID_PAIR", "INVALID_AMOUNT"] as const) {
      const row = classifyPairOutcome(A, B, { ok: false, error: new V2QuoteError(code, "bad input") });
      expect(row).toMatchObject({ category: "INVALID_REQUEST", measured: false });
    }
  });

  it("treats an unreadable token as UNMEASURED even when no pool quoted", () => {
    const row = classifyPairOutcome(A, B, { ok: false, error: new V2QuoteError("LIQUIDITY_UNAVAILABLE", "No liquid route") },
      { from: facts(), to: facts({ address: B, readable: false }) });
    // The token could not be read, so "unsupported" was never established; the
    // pair falls back to the honest liquidity verdict rather than a false one.
    expect(row.category).toBe("MISSING_LIQUIDITY");
  });
});

describe("summarizeCoverage", () => {
  const rows: PairCoverageRow[] = [
    { from: A, to: B, category: "EXECUTABLE_ROUTE", reason: "", measured: true },
    { from: B, to: A, category: "MISSING_LIQUIDITY", reason: "", measured: true },
    { from: A, to: A, category: "UNMEASURED_PROVIDER_FAILURE", reason: "", measured: false },
  ];

  it("counts measured and unmeasured pairs separately", () => {
    const s = summarizeCoverage(rows);
    expect(s).toMatchObject({ pairs: 3, measured: 2, unmeasured: 1, executable: 1, missingLiquidity: 1, complete: false });
  });

  it("is complete only when every pair was measured", () => {
    expect(summarizeCoverage(rows.slice(0, 2)).complete).toBe(true);
  });
});

describe("renderCoverageMarkdown", () => {
  it("warns loudly when coverage is incomplete", () => {
    const md = renderCoverageMarkdown(
      [{ from: A, to: B, category: "UNMEASURED_PROVIDER_FAILURE", reason: "rpc down", measured: false }],
      { chainId: 8453, rpcLabel: "https://mainnet.base.org" },
    );
    expect(md).toMatch(/Coverage is INCOMPLETE/);
    expect(md).toMatch(/No universal-support claim/);
  });

  it("omits the incomplete warning only when everything was measured", () => {
    const md = renderCoverageMarkdown(
      [{ from: A, to: B, category: "EXECUTABLE_ROUTE", reason: "1 leg", measured: true, hops: 1, legs: 1, venueKinds: [2] }],
      { chainId: 8453, blockNumber: "52900000", rpcLabel: "[RPC]" },
    );
    expect(md).not.toMatch(/Coverage is INCOMPLETE/);
    expect(md).toMatch(/block 52900000/);
  });

  it("still says a quoted route is not proof of executable settlement", () => {
    const md = renderCoverageMarkdown(
      [{ from: A, to: B, category: "EXECUTABLE_ROUTE", reason: "", measured: true }],
      { chainId: 8453, rpcLabel: "[RPC]" },
    );
    expect(md).toMatch(/not proof of executable settlement/i);
  });
});
