// Coverage-matrix classification. The property that matters most is negative
// honesty: an RPC or index failure must be recorded as UNMEASURED, never as
// missing liquidity, so a coverage report can never claim a negative it did not
// establish.
import { describe, expect, it } from "vitest";
import { V2QuoteError } from "../discovery";
import {
  classifyPairOutcome, classifyTokenSupport, renderCoverageMarkdown, summarizeByDirection, summarizeByVenue,
  summarizeCoverage, summarizeUnmeasuredReasons, unmeasuredReasonBucket, venueKindName,
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

  it("treats missing decimals as a metadata gap, not as unroutable", () => {
    // Discovery and execution never read decimals(), so a failed decimals read
    // cannot prove the token has no route. It is flagged for UI sizing instead.
    expect(classifyTokenSupport(facts({ decimals: null }))).toMatchObject({ supported: true, metadataComplete: false });
    expect(classifyTokenSupport(facts({ decimals: 300 }))).toMatchObject({ supported: true, metadataComplete: false });
    expect(classifyTokenSupport(facts({ decimals: 6, symbol: "TKA" }))).toMatchObject({ supported: true, metadataComplete: true });
    expect(classifyTokenSupport(facts({ decimals: null })).reason).toMatch(/routed but not safely sized/i);
  });

  it("reports a non-contract as definitively unsupported", () => {
    expect(classifyTokenSupport(facts({ hasCode: false }))).toMatchObject({ supported: false, category: "UNSUPPORTED_TOKEN_INFRASTRUCTURE", metadataComplete: false });
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

const C = "0xc333333333333333333333333333333333333333";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const routeRow = (over: Partial<PairCoverageRow> = {}): PairCoverageRow =>
  ({ from: A, to: B, category: "EXECUTABLE_ROUTE", reason: "quoted", measured: true, hops: 1, legs: 1, venueKinds: [7], ...over });

describe("coverage rollups: venue, direction and unmeasured cause", () => {
  it("names the venues the executor has registered and refuses to invent a name", () => {
    expect(venueKindName(1)).toBe("Aerodrome Slipstream");
    expect(venueKindName(2)).toBe("Uniswap v3");
    expect(venueKindName(3)).toBe("Uniswap v2");
    expect(venueKindName(4)).toBe("Aerodrome Classic");
    expect(venueKindName(7)).toBe("Uniswap v4");
    // Pancake (5) and 0x (6) are DISABLED on the deployed executor, so they get no
    // friendly name here: a numbered kind in a report is a prompt to go look.
    expect(venueKindName(5)).toBe("kind 5");
    expect(venueKindName(6)).toBe("kind 6");
  });

  it("groups executable routes by the venue that actually served them", () => {
    const rows: PairCoverageRow[] = [
      routeRow({ venueKinds: [1] }),
      routeRow({ from: A, to: C, venueKinds: [7] }),
      routeRow({ from: B, to: C, venueKinds: [1, 7] }),
      { from: C, to: A, category: "UNMEASURED_PROVIDER_FAILURE", reason: "rpc down", measured: false },
    ];
    const byVenue = summarizeByVenue(rows);
    expect(byVenue.map((v) => v.kind)).toEqual([1, 7]);
    expect(byVenue[0]).toMatchObject({ venue: "Aerodrome Slipstream", executable: 2, mixedVenue: 1 });
    expect(byVenue[1]).toMatchObject({ venue: "Uniswap v4", executable: 2, mixedVenue: 1 });
  });

  it("does not count an unmeasured pair as venue support", () => {
    expect(summarizeByVenue([{ from: A, to: B, category: "UNMEASURED_PROVIDER_FAILURE", reason: "rpc", measured: false }])).toEqual([]);
    expect(summarizeByVenue([{ from: A, to: B, category: "MISSING_LIQUIDITY", reason: "none", measured: true }])).toEqual([]);
  });

  it("reports BUY and SELL separately, because one-way routing is not tradeable", () => {
    const rows = [
      routeRow({ subjectSymbol: "TKA", direction: "SELL" }),
      { ...routeRow({ from: USDC, to: A, subjectSymbol: "TKA", direction: "BUY" }), category: "UNMEASURED_PROVIDER_FAILURE" as const, measured: false, reason: "rpc down" },
      routeRow({ from: A, to: C, subjectSymbol: "TKA", direction: "TOKEN_PAIR" }),
    ];
    const byDirection = summarizeByDirection(rows);
    expect(byDirection).toEqual([
      { subject: "TKA", direction: "SELL", total: 1, executable: 1, missingLiquidity: 0, unsupported: 0, unmeasured: 0 },
      { subject: "TKA", direction: "BUY", total: 1, executable: 0, missingLiquidity: 0, unsupported: 0, unmeasured: 1 },
      { subject: "TKA", direction: "TOKEN_PAIR", total: 1, executable: 1, missingLiquidity: 0, unsupported: 0, unmeasured: 0 },
    ]);
  });

  it("buckets unmeasured causes so a report shows the dominant one", () => {
    expect(unmeasuredReasonBucket("Probe budget exhausted before this pair was measured (shard 2/4)."))
      .toBe("Probe budget exhausted before this pair was measured");
    expect(unmeasuredReasonBucket("Discovery raised an unexpected error: discovery exceeded 60000ms"))
      .toBe("Per-pair wall-clock timeout");
    expect(unmeasuredReasonBucket("Discovery was unavailable: v4 Initialize search for 0xabc exceeded its 64-call budget"))
      .toBe("Discovery call budget exhausted mid-search");
    expect(unmeasuredReasonBucket("Discovery was unavailable: Provider refused every v4 log range down to 10 blocks"))
      .toBe("Provider refused the log ranges discovery needs");
    expect(unmeasuredReasonBucket("No shard reported this pair (expected 4 shards, 3 reported)."))
      .toBe("A shard did not report this pair");
    const rows: PairCoverageRow[] = [
      { from: A, to: B, category: "UNMEASURED_PROVIDER_FAILURE", reason: "Probe budget exhausted before this pair was measured.", measured: false },
      { from: A, to: C, category: "UNMEASURED_PROVIDER_FAILURE", reason: "Probe budget exhausted before this pair was measured.", measured: false },
      { from: B, to: C, category: "UNMEASURED_PROVIDER_FAILURE", reason: "discovery exceeded 60000ms", measured: false },
      routeRow(),
    ];
    expect(summarizeUnmeasuredReasons(rows)).toEqual([
      { reason: "Probe budget exhausted before this pair was measured", count: 2 },
      { reason: "Per-pair wall-clock timeout", count: 1 },
    ]);
  });

  it("renders the venue, direction and cause sections in the report", () => {
    const md = renderCoverageMarkdown(
      [
        routeRow({ fromSymbol: "TKA", toSymbol: "TKB", subjectSymbol: "TKA", direction: "SELL", venueKinds: [7] }),
        { from: USDC, to: A, fromSymbol: "USDC", toSymbol: "TKA", subjectSymbol: "TKA", direction: "BUY", category: "UNMEASURED_PROVIDER_FAILURE", reason: "Probe budget exhausted before this pair was measured.", measured: false },
      ],
      { chainId: 8453, blockNumber: "52856963", rpcLabel: "[RPC]", shards: { reported: 4, expected: 4 }, planSize: 2 },
    );
    expect(md).toMatch(/## Executable routes by venue/);
    expect(md).toMatch(/Uniswap v4/);
    expect(md).toMatch(/## Measured results by token and direction/);
    expect(md).toMatch(/\| TKA \| SELL \| 1 \| 1 \| 0 \| 0 \| 0 \|/);
    expect(md).toMatch(/\| TKA \| BUY \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
    expect(md).toMatch(/## Why pairs are unmeasured/);
    expect(md).toMatch(/Probe budget exhausted before this pair was measured/);
    expect(md).toMatch(/Shards reported: \*\*4 of 4\*\*/);
    // Symbols make the per-pair table readable; addresses stay for auditability.
    expect(md).toMatch(/TKA `0xa111/);
  });

  it("states plainly when a shard did not report, instead of shrinking the totals", () => {
    const md = renderCoverageMarkdown(
      [routeRow()],
      { chainId: 8453, rpcLabel: "[RPC]", shards: { reported: 2, expected: 4 }, planSize: 40 },
    );
    expect(md).toMatch(/Shards reported: \*\*2 of 4\*\*/);
    expect(md).toMatch(/INCOMPLETE RUN/);
    expect(md).toMatch(/never as missing liquidity/);
    expect(md).toMatch(/The probe plan has 40 pairs but this matrix reports 1/);
  });

  it("says when nothing at all was measured", () => {
    const md = renderCoverageMarkdown(
      [{ from: A, to: B, category: "UNMEASURED_PROVIDER_FAILURE", reason: "no shard", measured: false }],
      { chainId: 8453, rpcLabel: "[RPC]" },
    );
    expect(md).toMatch(/\*\*Nothing was measured in this run\.\*\*/);
    expect(md).toMatch(/No pair produced an executable route in this run/);
    expect(md).toMatch(/No venue is claimed as working/);
  });
});
