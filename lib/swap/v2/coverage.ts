// lib/swap/v2/coverage.ts
// Classification for the V2 token/pair coverage matrix.
//
// The point of this module is to keep three things strictly separate, because
// conflating them is how a coverage report becomes a lie:
//   - an EXECUTABLE ROUTE  — discovery actually quoted this pair
//   - MISSING LIQUIDITY    — the token is fine, but no compatible pool quotes
//   - UNMEASURED           — we could not check (RPC/index failure), which is
//                            NOT evidence of missing liquidity and must never be
//                            counted as such
// Plus unsupported token/venue infrastructure, which is a code/contract fact
// rather than a liquidity fact.
//
// Pure and offline: it classifies outcomes it is given. Running real discovery
// over Base lives in scripts/swap-v2-coverage-matrix.test.ts, which needs an RPC.
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { V2QuoteError } from "./discovery";

export const COVERAGE_CATEGORIES = [
  "EXECUTABLE_ROUTE",
  "MISSING_LIQUIDITY",
  "UNSUPPORTED_TOKEN_INFRASTRUCTURE",
  "UNSUPPORTED_VENUE",
  "INVALID_REQUEST",
  "FEE_INVARIANT_DEFECT",
  "UNMEASURED_PROVIDER_FAILURE",
] as const;
export type CoverageCategory = (typeof COVERAGE_CATEGORIES)[number];

/** Categories that represent a genuine measurement of the pair. */
export const MEASURED_CATEGORIES: readonly CoverageCategory[] = [
  "EXECUTABLE_ROUTE", "MISSING_LIQUIDITY", "UNSUPPORTED_TOKEN_INFRASTRUCTURE", "UNSUPPORTED_VENUE",
];

export interface TokenSupportFacts {
  address: string;
  /** eth_getCode returned non-empty runtime code. */
  hasCode: boolean;
  /** decimals() succeeded and is a sane ERC-20 value. */
  decimals: number | null;
  /** symbol() succeeded. */
  symbol: string | null;
  /** The reads themselves succeeded; false means UNMEASURED, not unsupported. */
  readable: boolean;
}

/** Venue kinds the deployed V2 executor has registered, for readable reports. A
 * kind missing from this map is reported by number rather than given an invented
 * name. */
export const VENUE_KIND_NAMES: Readonly<Record<number, string>> = {
  1: "Aerodrome Slipstream",
  2: "Uniswap v3",
  3: "Uniswap v2",
  4: "Aerodrome Classic",
  7: "Uniswap v4",
};
export const venueKindName = (kind: number): string => VENUE_KIND_NAMES[kind] ?? `kind ${kind}`;

export interface PairCoverageRow {
  from: string;
  to: string;
  category: CoverageCategory;
  reason: string;
  /** Only set for a measured executable route. */
  hops?: number;
  legs?: number;
  venueKinds?: readonly number[];
  amountOut?: string;
  measured: boolean;
  /** Stable position in the probe plan, so shards can be merged back in order. */
  index?: number;
  /** Which shard measured this pair; absent when the plan was not sharded. */
  shard?: number;
  /** The token this probe is about, and which way it was probed. Set by the
   * matrix from the plan; the rollups degrade gracefully when it is missing. */
  subjectSymbol?: string;
  direction?: "SELL" | "BUY" | "TOKEN_PAIR";
  /** Human-readable sides, so a report does not have to be read as hex. */
  fromSymbol?: string;
  toSymbol?: string;
  /** What discovery could actually establish for this pair (sweep/index/v4 scope).
   * Kept separate from `reason` so a report can show WHY a verdict is weak. */
  evidenceScope?: string;
}

/** Buckets an unmeasured reason, so a report shows the DOMINANT cause instead of
 * 158 unique strings. Bucketing never changes a category: an unmeasured pair stays
 * unmeasured, it just becomes legible. */
export function unmeasuredReasonBucket(reason: string): string {
  const text = reason.toLowerCase();
  if (/did not report|no shard|shard \d+ (failed|produced|is missing)/.test(text)) return "A shard did not report this pair";
  if (/probe budget exhausted|pair probe cap/.test(text)) return "Probe budget exhausted before this pair was measured";
  if (/exceeded \d+ms|per-pair timeout/.test(text)) return "Per-pair wall-clock timeout";
  if (/v4 initialize search .*exceeded|canonical pool log sweep exceeded|call budget/.test(text)) return "Discovery call budget exhausted mid-search";
  if (/refused every v4 log range|log query unavailable/.test(text)) return "Provider refused the log ranges discovery needs";
  if (/floor could not be derived|archive/.test(text)) return "No historical state access (deployment floor underivable)";
  if (/venue quote rpc unavailable|quote adapter has no base code/.test(text)) return "Venue quote RPC unavailable";
  if (/no compatible pool could be established/.test(text)) return "Discovery incomplete: sweep and/or v4 scan did not finish";
  if (/unreachable|not base/.test(text)) return "Base RPC unreachable";
  return reason.length > 90 ? `${reason.slice(0, 90)}...` : reason;
}

export interface VenueRollupRow {
  kind: number;
  venue: string;
  executable: number;
  /** Routes that used this venue together with at least one other venue. */
  mixedVenue: number;
  pairs: readonly string[];
}

/** Executable routes grouped by the venue kind(s) that actually served them. This
 * is the answer to "which venues are proven to route", as distinct from "which
 * venues are merely registered on the executor". */
export function summarizeByVenue(rows: readonly PairCoverageRow[]): VenueRollupRow[] {
  const executable = rows.filter((r) => r.category === "EXECUTABLE_ROUTE");
  const byKind = new Map<number, { mixed: number; pairs: string[] }>();
  for (const row of executable) {
    const kinds = [...new Set(row.venueKinds ?? [])].sort((a, b) => a - b);
    for (const kind of kinds) {
      const entry = byKind.get(kind) ?? { mixed: 0, pairs: [] };
      if (kinds.length > 1) entry.mixed++;
      entry.pairs.push(`${row.from.slice(0, 8)}->${row.to.slice(0, 8)}`);
      byKind.set(kind, entry);
    }
  }
  return [...byKind.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([kind, entry]) => ({ kind, venue: venueKindName(kind), executable: entry.pairs.length, mixedVenue: entry.mixed, pairs: entry.pairs }));
}

export interface DirectionRollupRow {
  subject: string;
  direction: "SELL" | "BUY" | "TOKEN_PAIR";
  total: number;
  executable: number;
  missingLiquidity: number;
  unsupported: number;
  unmeasured: number;
}

/** Per token and per direction, because BUY and SELL are separate measurements:
 * an asset that only routes one way is not a tradeable asset. */
export function summarizeByDirection(rows: readonly PairCoverageRow[]): DirectionRollupRow[] {
  const byKey = new Map<string, DirectionRollupRow>();
  for (const row of rows) {
    const subject = row.subjectSymbol ?? row.from.slice(0, 10);
    const direction = row.direction ?? "TOKEN_PAIR";
    const key = `${subject}|${direction}`;
    const entry = byKey.get(key) ?? { subject, direction, total: 0, executable: 0, missingLiquidity: 0, unsupported: 0, unmeasured: 0 };
    entry.total++;
    if (row.category === "EXECUTABLE_ROUTE") entry.executable++;
    else if (row.category === "MISSING_LIQUIDITY") entry.missingLiquidity++;
    else if (row.category === "UNSUPPORTED_TOKEN_INFRASTRUCTURE") entry.unsupported++;
    else if (!row.measured) entry.unmeasured++;
    byKey.set(key, entry);
  }
  const order = { SELL: 0, BUY: 1, TOKEN_PAIR: 2 } as const;
  return [...byKey.values()].sort((a, b) => a.subject.localeCompare(b.subject) || order[a.direction] - order[b.direction]);
}

/** Unmeasured pairs grouped by dominant cause. */
export function summarizeUnmeasuredReasons(rows: readonly PairCoverageRow[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows.filter((r) => !r.measured)) {
    const bucket = unmeasuredReasonBucket(row.reason);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Classifies a token's on-chain infrastructure. An unreadable token is
 * UNMEASURED, never "unsupported": a rate-limited RPC is not a verdict. */
export interface TokenSupportVerdict {
  supported: boolean;
  category: CoverageCategory | "UNMEASURED_PROVIDER_FAILURE";
  reason: string;
  /** False when the token is routable but its ERC-20 metadata could not be read,
   * which matters for UI amount sizing — not for whether a route exists. */
  metadataComplete: boolean;
}

export function classifyTokenSupport(token: TokenSupportFacts): TokenSupportVerdict {
  // The native ETH sentinel is a pseudo-address, not a contract, so it has no
  // runtime code BY DESIGN. Discovery normalizes it to canonical WETH, which means
  // it is routable. Classifying it as "unsupported infrastructure" was a false
  // verdict that then contradicted a real ETH route — caught by the matrix's own
  // cross-check between token facts and pair verdicts.
  if (isNativeEthSentinel(token.address)) {
    return { supported: true, category: "UNSUPPORTED_TOKEN_INFRASTRUCTURE", metadataComplete: true, reason: "" };
  }
  if (!token.readable) {
    return { supported: false, category: "UNMEASURED_PROVIDER_FAILURE", metadataComplete: false, reason: `Token metadata for ${token.address} could not be read; coverage is unmeasured, not absent.` };
  }
  // The only DEFINITIVE routability fact is whether the address is a contract.
  // Discovery and execution never read decimals(), so a failed decimals/symbol
  // read is a metadata gap (it affects UI amount sizing), not proof that no venue
  // can route the token. Treating it as unsupported produced a verdict that
  // contradicted a real route — the matrix's own cross-check caught it.
  if (!token.hasCode) {
    return { supported: false, category: "UNSUPPORTED_TOKEN_INFRASTRUCTURE", metadataComplete: false, reason: `${token.address} has no runtime code on Base; it is not a contract, so no venue can route it.` };
  }
  const decimalsUsable = token.decimals !== null && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255;
  return {
    supported: true, category: "UNSUPPORTED_TOKEN_INFRASTRUCTURE", metadataComplete: decimalsUsable && typeof token.symbol === "string",
    reason: decimalsUsable ? "" : `${token.address} is a contract but exposes no usable ERC-20 decimals(); it can be routed but not safely sized in the UI.`,
  };
}

/** Maps a discovery outcome to a coverage category. */
export function classifyPairOutcome(
  from: string,
  to: string,
  outcome: { ok: true; quote: { amountOut: bigint; legs: readonly { pools: readonly { kind: number }[] }[] } } | { ok: false; error: unknown },
  tokenFacts?: { from?: TokenSupportFacts; to?: TokenSupportFacts },
): PairCoverageRow {
  const base = { from, to };
  if (outcome.ok) {
    const legs = outcome.quote.legs;
    return {
      ...base, category: "EXECUTABLE_ROUTE", measured: true,
      reason: `${legs.length} leg(s) quoted through venue kind(s) ${[...new Set(legs.flatMap((l) => l.pools.map((p) => p.kind)))].sort().join(", ")}.`,
      hops: Math.max(...legs.map((l) => l.pools.length)),
      legs: legs.length,
      venueKinds: [...new Set(legs.flatMap((l) => l.pools.map((p) => p.kind)))].sort(),
      amountOut: outcome.quote.amountOut.toString(),
    };
  }
  const error = outcome.error;

  // A provider or index failure is UNMEASURED. Reporting it as missing liquidity
  // would claim a negative we never established.
  if (error instanceof V2QuoteError && error.code === "DISCOVERY_UNAVAILABLE") {
    return { ...base, category: "UNMEASURED_PROVIDER_FAILURE", measured: false, reason: `Discovery was unavailable: ${error.message}` };
  }
  if (!(error instanceof V2QuoteError)) {
    return { ...base, category: "UNMEASURED_PROVIDER_FAILURE", measured: false, reason: `Discovery raised an unexpected error: ${error instanceof Error ? error.message : String(error)}` };
  }
  switch (error.code) {
    case "LIQUIDITY_UNAVAILABLE": {
      // Distinguish "no compatible pool exists" from "this token cannot be routed
      // at all" when the caller supplied token facts.
      for (const side of ["from", "to"] as const) {
        const facts = tokenFacts?.[side];
        if (!facts) continue;
        const classified = classifyTokenSupport(facts);
        if (!classified.supported && classified.category === "UNSUPPORTED_TOKEN_INFRASTRUCTURE") {
          return { ...base, category: "UNSUPPORTED_TOKEN_INFRASTRUCTURE", measured: true, reason: classified.reason };
        }
      }
      return { ...base, category: "MISSING_LIQUIDITY", measured: true, reason: `${error.message} The tokens are valid Base assets; no compatible pool quoted this pair.` };
    }
    case "INVALID_PAIR":
      return { ...base, category: "INVALID_REQUEST", measured: false, reason: error.message };
    case "INVALID_AMOUNT":
      return { ...base, category: "INVALID_REQUEST", measured: false, reason: error.message };
    case "FEE_POLICY_INVALID":
      // A quote that broke the 25 bps invariant is a defect, not a coverage fact.
      return { ...base, category: "FEE_INVARIANT_DEFECT", measured: true, reason: error.message };
    default:
      return { ...base, category: "UNMEASURED_PROVIDER_FAILURE", measured: false, reason: `Unclassified discovery failure: ${String((error as V2QuoteError).code)}` };
  }
}

export interface CoverageSummary {
  pairs: number;
  measured: number;
  unmeasured: number;
  executable: number;
  missingLiquidity: number;
  unsupportedToken: number;
  unsupportedVenue: number;
  invalidRequest: number;
  feeDefects: number;
  byCategory: Record<CoverageCategory, number>;
  /** True only when every pair was actually measured. */
  complete: boolean;
}

export function summarizeCoverage(rows: readonly PairCoverageRow[]): CoverageSummary {
  const byCategory = Object.fromEntries(COVERAGE_CATEGORIES.map((c) => [c, 0])) as Record<CoverageCategory, number>;
  for (const row of rows) byCategory[row.category]++;
  const measured = rows.filter((r) => r.measured).length;
  return {
    pairs: rows.length,
    measured,
    unmeasured: rows.length - measured,
    executable: byCategory.EXECUTABLE_ROUTE,
    missingLiquidity: byCategory.MISSING_LIQUIDITY,
    unsupportedToken: byCategory.UNSUPPORTED_TOKEN_INFRASTRUCTURE,
    unsupportedVenue: byCategory.UNSUPPORTED_VENUE,
    invalidRequest: byCategory.INVALID_REQUEST,
    feeDefects: byCategory.FEE_INVARIANT_DEFECT,
    byCategory,
    complete: measured === rows.length,
  };
}

/** Renders the matrix as markdown. States plainly when coverage is incomplete,
 * so the report can never be read as a universal-support claim. */
export function renderCoverageMarkdown(
  rows: readonly PairCoverageRow[],
  meta: {
    chainId: number; blockNumber?: string; rpcLabel: string;
    /** Present when the plan was sharded across CI jobs. A missing shard is a
     * reporting gap and is stated as one, never smoothed into the totals. */
    shards?: { reported: number; expected: number };
    planSize?: number;
  },
): string {
  const summary = summarizeCoverage(rows);
  const lines: string[] = [];
  lines.push(`# MPGR Swap V2 coverage matrix (chain ${meta.chainId}${meta.blockNumber ? `, block ${meta.blockNumber}` : ""})`);
  lines.push("");
  lines.push(`RPC: ${meta.rpcLabel}`);
  if (meta.shards) {
    const { reported, expected } = meta.shards;
    lines.push("");
    lines.push(`Shards reported: **${reported} of ${expected}**${reported < expected ? " \u2014 **INCOMPLETE RUN**. Pairs owned by a shard that did not report are listed as UNMEASURED, never as missing liquidity." : ""}`);
  }
  if (meta.planSize !== undefined && meta.planSize !== summary.pairs) {
    lines.push("");
    lines.push(`> The probe plan has ${meta.planSize} pairs but this matrix reports ${summary.pairs}. The difference is a reporting gap, not a coverage fact.`);
  }
  lines.push("");
  lines.push(`Pairs probed: **${summary.pairs}** · measured: **${summary.measured}** · unmeasured: **${summary.unmeasured}**`);
  lines.push("");
  lines.push(summary.measured === 0
    ? "**Nothing was measured in this run.** No coverage, no venue support and no universal-trading claim is made or implied."
    : `Of the ${summary.measured} measured pair(s), **${summary.executable}** produced an executable route.`);
  lines.push("");
  lines.push("| Category | Count | Meaning |");
  lines.push("| --- | --- | --- |");
  lines.push(`| EXECUTABLE_ROUTE | ${summary.executable} | Discovery quoted a real route with the 25 bps fee intact |`);
  lines.push(`| MISSING_LIQUIDITY | ${summary.missingLiquidity} | Valid Base assets, but no compatible pool quoted this pair |`);
  lines.push(`| UNSUPPORTED_TOKEN_INFRASTRUCTURE | ${summary.unsupportedToken} | Not a contract, or no usable ERC-20 metadata |`);
  lines.push(`| UNSUPPORTED_VENUE | ${summary.unsupportedVenue} | Only a disabled/unproven venue could serve it |`);
  lines.push(`| INVALID_REQUEST | ${summary.invalidRequest} | Probe input problem, not a token fact |`);
  lines.push(`| FEE_INVARIANT_DEFECT | ${summary.feeDefects} | A quote broke the fee invariant — a bug, not coverage |`);
  lines.push(`| UNMEASURED_PROVIDER_FAILURE | ${summary.unmeasured} | Could not check; **not** evidence of missing liquidity |`);
  lines.push("");
  if (!summary.complete) {
    lines.push(`> **Coverage is INCOMPLETE.** ${summary.unmeasured} pair(s) could not be measured. No universal-support claim is made or implied.`);
    lines.push("");
  }
  const byVenue = summarizeByVenue(rows);
  lines.push("## Executable routes by venue");
  lines.push("");
  if (byVenue.length > 0) {
    lines.push("Venues that actually quoted a route here, as distinct from venues merely registered on the executor.");
    lines.push("");
    lines.push("| Venue kind | Venue | Executable routes | Of which mixed-venue |");
    lines.push("| --- | --- | --- | --- |");
    for (const v of byVenue) lines.push(`| ${v.kind} | ${v.venue} | ${v.executable} | ${v.mixedVenue} |`);
  } else {
    lines.push("**No pair produced an executable route in this run.** No venue is claimed as working.");
  }
  lines.push("");

  const byDirection = summarizeByDirection(rows);
  if (byDirection.length > 0) {
    lines.push("## Measured results by token and direction");
    lines.push("");
    lines.push("BUY and SELL are separate measurements: an asset that only routes one way is not tradeable.");
    lines.push("");
    lines.push("| Token | Direction | Pairs | Executable | Missing liquidity | Unsupported | Unmeasured |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const d of byDirection) {
      lines.push(`| ${d.subject} | ${d.direction} | ${d.total} | ${d.executable} | ${d.missingLiquidity} | ${d.unsupported} | ${d.unmeasured} |`);
    }
    lines.push("");
  }

  const unmeasuredReasons = summarizeUnmeasuredReasons(rows);
  if (unmeasuredReasons.length > 0) {
    lines.push("## Why pairs are unmeasured");
    lines.push("");
    lines.push("An unmeasured pair is **not** evidence of missing liquidity. Dominant causes:");
    lines.push("");
    lines.push("| Cause | Pairs |");
    lines.push("| --- | --- |");
    for (const u of unmeasuredReasons) lines.push(`| ${u.reason.replace(/\|/g, "/")} | ${u.count} |`);
    lines.push("");
  }

  lines.push("## Every probed pair");
  lines.push("");
  lines.push("| From | To | Dir | Category | Hops | Legs | Venues | Reason |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const side = (symbol: string | undefined, address: string): string =>
    (symbol ? `${symbol} \`${address}\`` : `\`${address}\``);
  for (const row of rows) {
    lines.push(`| ${side(row.fromSymbol, row.from)} | ${side(row.toSymbol, row.to)} | ${row.direction ?? ""} | ${row.category} | ${row.hops ?? ""} | ${row.legs ?? ""} | ${row.venueKinds?.join("/") ?? ""} | ${row.reason.replace(/\|/g, "/")} |`);
  }
  lines.push("");
  lines.push("A quoted route is discovery evidence, not proof of executable settlement. Execution is proven separately by simulation, the fork suite and receipt verification.");
  return lines.join("\n");
}
