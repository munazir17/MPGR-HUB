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
export function renderCoverageMarkdown(rows: readonly PairCoverageRow[], meta: { chainId: number; blockNumber?: string; rpcLabel: string }): string {
  const summary = summarizeCoverage(rows);
  const lines: string[] = [];
  lines.push(`# MPGR Swap V2 coverage matrix (chain ${meta.chainId}${meta.blockNumber ? `, block ${meta.blockNumber}` : ""})`);
  lines.push("");
  lines.push(`RPC: ${meta.rpcLabel}`);
  lines.push("");
  lines.push(`Pairs probed: **${summary.pairs}** · measured: **${summary.measured}** · unmeasured: **${summary.unmeasured}**`);
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
  lines.push("| From | To | Category | Hops | Legs | Venues | Reason |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(`| \`${row.from}\` | \`${row.to}\` | ${row.category} | ${row.hops ?? ""} | ${row.legs ?? ""} | ${row.venueKinds?.join("/") ?? ""} | ${row.reason.replace(/\|/g, "/")} |`);
  }
  lines.push("");
  lines.push("A quoted route is discovery evidence, not proof of executable settlement. Execution is proven separately by simulation, the fork suite and receipt verification.");
  return lines.join("\n");
}
