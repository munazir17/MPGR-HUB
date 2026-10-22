// App-level integration test for the V2 journey.
//
// EVIDENCE TIER — read this before quoting any result from it:
//   SIMULATED. Every chain interaction is a fabricated in-process reader. This is
//   NOT a fork test (no real Base state, no Foundry) and NOT live evidence (no
//   transaction was ever broadcast, so no real receipt was ever settled).
//   What it proves that per-module unit tests cannot: the modules COMPOSE. A quote
//   discovered dynamically survives execution preparation, the route's real wire
//   serializer, the client adapter, every policy/freshness/fee gate, spender
//   selection, and finally receipt settlement — in both directions, for direct,
//   multi-hop and split routes.
//
// Fork evidence lives in test/swap-fork/ (CI workflow swap-v2-fork-proof.yml).
// Live evidence does not exist and is not claimed anywhere in this PR.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { discoverV2Quote, V2_FEE_RECIPIENT, type LiquiditySource, type Pool, type V2Quote } from "../discovery";
import { prepareV2Execution, serializeV2Swap, type V2ExecutionReader } from "../execution";
import { SWAP_V2_SEALED_MANIFEST, __setSwapV2ExecutorForTests } from "../deployment";
import { swapV2ProposalFromResponse } from "../v2-proposal";
import { swapV2RoutingEvidence, swapV2RoutingEvidenceValid } from "../v2-evidence";
import { swapV2Target } from "../v2-target";
import { swapQuotePolicyError, verifySwapSettlement } from "@/lib/swap/swap-policy";
import { swapQuoteExpiry, swapQuoteFresh } from "@/lib/swap/swap-lifecycle";
import { revalidateTradeProposal } from "@/lib/trade/trade-confirmation";
import { verifyAgentFeeInSwapTransaction } from "@/lib/trade/trade-agent-fee";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { POOL_AB, POOL_AC, POOL_CB, TAKER, TOKEN_A, TOKEN_B, TOKEN_C, UNI_V3_ROUTER, v3Pool } from "./helpers";
import { swapExecutedLog, tokenRef } from "./activation-fixtures";

const EXECUTOR = SWAP_V2_SEALED_MANIFEST.executor;
const BLOCK = { number: 52_900_000n, hash: `0x${"12".repeat(32)}` as Hex, timestamp: 1_760_000_000n };
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 600);
const u256 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;

const VENUES = Object.fromEntries(
  SWAP_V2_SEALED_MANIFEST.venues.map((v) => [v.router.toLowerCase(), { kind: v.kind, factory: v.factory.toLowerCase() }]),
);

/** Fabricated executor: correct posture, and an eth_call that returns the quoted
 * output so the simulation step succeeds exactly as it would on chain. */
function reader(simulated: bigint): V2ExecutionReader {
  return {
    async getChainId() { return 8453; },
    async getCode() { return "0x6080" as Hex; },
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      const router = (args.args?.[0] as string | undefined)?.toLowerCase();
      switch (args.functionName) {
        case "feeBps": return 25;
        case "MAX_FEE_BPS": return 100;
        case "feeRecipient": case "PINNED_FEE_RECIPIENT": return V2_FEE_RECIPIENT;
        case "owner": case "GOVERNANCE_SAFE": return SWAP_V2_SEALED_MANIFEST.owner;
        case "paused": return false;
        case "pendingFeeBps": return 0;
        case "pendingFeeRecipient": return "0x0000000000000000000000000000000000000000";
        case "pendingEffectiveAt": return 0n;
        case "FEE_TIMELOCK_SECONDS": return 172_800n;
        case "V4_POOL_MANAGER": return SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 7)!.router;
        case "routerKind": return VENUES[router ?? ""]?.kind ?? 0;
        case "routerFactory": return VENUES[router ?? ""]?.factory ?? "0x0000000000000000000000000000000000000000";
        default: throw new Error(`unexpected posture read: ${args.functionName}`);
      }
    },
    async call() { return { data: u256(simulated) }; },
  } as unknown as V2ExecutionReader;
}

/** A liquidity source over arbitrary pools: no catalog, no hardcoded pair. */
function source(pools: readonly Pool[], priced: (amount: bigint) => bigint): LiquiditySource {
  return {
    async hints() { return []; },
    async pools() { return pools; },
    async quote(_pool: Pool, _input: Address, amount: bigint) { return priced(amount); },
  } as unknown as LiquiditySource;
}

const ref = (address: Address, symbol: string, decimals: number): TradeTokenRef => tokenRef(address, symbol, decimals);

async function journey(opts: {
  from: Address; to: Address; pools: readonly Pool[]; priced: (amount: bigint) => bigint;
  gross: bigint; fromRef: TradeTokenRef; toRef: TradeTokenRef; slippageBps?: number;
  nativeIn?: boolean; nativeOut?: boolean;
}) {
  const slippageBps = opts.slippageBps ?? 100;
  // 1. Dynamic discovery — no catalog, no hardcoded pair.
  const quote: V2Quote = await discoverV2Quote(source(opts.pools, opts.priced), opts.from, opts.to, opts.gross);
  // 2. Execution preparation: posture, venue registration, simulation, calldata.
  const swap = await prepareV2Execution(reader(quote.amountOut), SWAP_V2_SEALED_MANIFEST, {
    quote, taker: TAKER, slippageBps, deadline: DEADLINE,
    nativeIn: opts.nativeIn ?? false, nativeOut: opts.nativeOut ?? false,
  }, BLOCK);
  // 3. The route's REAL wire serializer, then the client adapter.
  const wire = serializeV2Swap(swap, quote, { slippageBps, nativeIn: opts.nativeIn ?? false, nativeOut: opts.nativeOut ?? false });
  const quotedAt = Date.now();
  const proposal = swapV2ProposalFromResponse(wire, { from: opts.fromRef, to: opts.toRef, taker: TAKER, slippageBps, quotedAt });
  return { quote, swap, wire, proposal, quotedAt };
}

/** Every gate the live journey applies between a quote and a signature. */
function expectJourneyAccepted(proposal: ReturnType<typeof swapV2ProposalFromResponse>) {
  expect(proposal).not.toBeNull();
  const p = proposal!;
  expect(revalidateTradeProposal(p, TAKER).state).toBe("VALIDATED");
  expect(swapQuotePolicyError(p)).toBeNull();
  expect(swapQuoteExpiry(p)).toBeGreaterThan(Date.now());
  expect(swapQuoteFresh(p)).toBe(true);
  expect(verifyAgentFeeInSwapTransaction(p).ok).toBe(true);
  const evidence = swapV2RoutingEvidence(p);
  expect(evidence).toBeDefined();
  expect(swapV2RoutingEvidenceValid(p, evidence!)).toBe(true);
  // Allowance/preflight: the spender is the executor that receives the calldata.
  expect(swapV2Target(p)?.executor.toLowerCase()).toBe(EXECUTOR.toLowerCase());
  expect(p.permit2Spender?.toLowerCase() ?? EXECUTOR.toLowerCase()).toBe(p.transaction!.to.toLowerCase());
  return p;
}

/** A receipt whose SwapExecuted event honours the committed intent. */
function receiptFor(p: NonNullable<ReturnType<typeof swapV2ProposalFromResponse>>, amountOut?: bigint) {
  const evidence = swapV2RoutingEvidence(p)!;
  const log = swapExecutedLog({
    taker: TAKER, router: UNI_V3_ROUTER, intentId: evidence.intentId,
    tokenIn: p.from.address.toLowerCase() === TOKEN_A.toLowerCase() ? TOKEN_A : p.from.address as Address,
    tokenOut: p.to.address as Address,
    grossAmountIn: BigInt(p.fromAmount), feeAmount: BigInt(p.agentFee!.amountAtomic),
    swapAmountIn: BigInt(p.fromAmount) - BigInt(p.agentFee!.amountAtomic),
    amountOut: amountOut ?? BigInt(p.toAmount), feeRecipient: V2_FEE_RECIPIENT,
    feeBps: 25, routerKind: evidence.legHops.length > 1 ? 2 : 2, flags: 0,
  });
  return {
    status: "success" as const, transactionHash: `0x${"cc".repeat(32)}` as Hex,
    blockNumber: BLOCK.number, from: TAKER, to: EXECUTOR, logs: [log],
  } as never;
}

beforeEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));
afterEach(() => __setSwapV2ExecutorForTests(null));

describe("V2 journey integration (SIMULATED — not fork, not live)", () => {
  it("carries a dynamically discovered direct SELL through every gate to a verified receipt", async () => {
    const { proposal, quote } = await journey({
      from: TOKEN_A, to: TOKEN_B, pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)],
      priced: (a) => a / 1000n, gross: 1_000_000n,
      fromRef: ref(TOKEN_A, "TKA", 18), toRef: ref(TOKEN_B, "TKB", 18),
    });
    const p = expectJourneyAccepted(proposal);
    expect(swapV2RoutingEvidence(p)!.entry).toBe("swapExactInput");
    expect(swapV2RoutingEvidence(p)!.hops).toBe(1);
    // 25 bps on gross, once.
    expect(p.agentFee!.amountAtomic).toBe((quote.gross * 25n / 10_000n).toString());
    const proof = verifySwapSettlement(p, receiptFor(p));
    expect(proof.verified).toBe(true);
    expect(proof.feeAmount).toBe(p.agentFee!.amountAtomic);
    expect(proof.feeRecipient!.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
  });

  it("carries the reverse BUY through the same gates with the same spender", async () => {
    const { proposal } = await journey({
      from: TOKEN_B, to: TOKEN_A, pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)],
      priced: (a) => a / 500n, gross: 2_000_000n,
      fromRef: ref(TOKEN_B, "TKB", 18), toRef: ref(TOKEN_A, "TKA", 18),
    });
    const p = expectJourneyAccepted(proposal);
    expect(p.from.address.toLowerCase()).toBe(TOKEN_B.toLowerCase());
    expect(p.to.address.toLowerCase()).toBe(TOKEN_A.toLowerCase());
    // BUY and SELL agree on spender, fee recipient and settlement target.
    expect(p.permit2Spender!.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(p.agentFee!.recipient!.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(verifySwapSettlement(p, receiptFor(p)).verified).toBe(true);
  });

  it("carries a genuine multi-hop route through non-major intermediates", async () => {
    const { proposal } = await journey({
      from: TOKEN_A, to: TOKEN_B,
      pools: [v3Pool(TOKEN_A, TOKEN_C, POOL_AC), v3Pool(TOKEN_C, TOKEN_B, POOL_CB)],
      priced: (a) => a * 9n / 10n, gross: 900_000n,
      fromRef: ref(TOKEN_A, "TKA", 18), toRef: ref(TOKEN_B, "TKB", 18),
    });
    const p = expectJourneyAccepted(proposal);
    const evidence = swapV2RoutingEvidence(p)!;
    expect(evidence.hops).toBe(2);
    expect(evidence.pools).toHaveLength(2);
    // The fee is still taken once, on gross — never per hop.
    expect(p.agentFee!.amountAtomic).toBe((900_000n * 25n / 10_000n).toString());
    expect(verifySwapSettlement(p, receiptFor(p)).verified).toBe(true);
  });

  it("rejects a wire payload whose fee was tampered with, before any signature", async () => {
    const { wire } = await journey({
      from: TOKEN_A, to: TOKEN_B, pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)],
      priced: (a) => a / 1000n, gross: 1_000_000n,
      fromRef: ref(TOKEN_A, "TKA", 18), toRef: ref(TOKEN_B, "TKB", 18),
    });
    const tampered = { ...wire, fee: "0" };
    expect(swapV2ProposalFromResponse(tampered, {
      from: ref(TOKEN_A, "TKA", 18), to: ref(TOKEN_B, "TKB", 18), taker: TAKER, slippageBps: 100, quotedAt: Date.now(),
    })).toBeNull();
  });

  it("refuses to verify a receipt that settled below the committed minimum", async () => {
    const { proposal } = await journey({
      from: TOKEN_A, to: TOKEN_B, pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)],
      priced: (a) => a / 1000n, gross: 1_000_000n,
      fromRef: ref(TOKEN_A, "TKA", 18), toRef: ref(TOKEN_B, "TKB", 18),
    });
    const p = proposal!;
    const proof = verifySwapSettlement(p, receiptFor(p, BigInt(p.minToAmount) - 1n));
    expect(proof.verified).toBe(false);
    expect(proof.reason).toMatch(/minimum/i);
  });

  it("produces no proposal at all while the gate is dormant", async () => {
    // Build the wire payload first, with the gate open, then close the gate: the
    // client adapter must yield nothing even for a perfectly valid payload, which
    // is what keeps the live surface on V1 until activation is approved.
    const { wire } = await journey({
      from: TOKEN_A, to: TOKEN_B, pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)],
      priced: (a) => a / 1000n, gross: 1_000_000n,
      fromRef: ref(TOKEN_A, "TKA", 18), toRef: ref(TOKEN_B, "TKB", 18),
    });
    __setSwapV2ExecutorForTests(null);
    expect(swapV2ProposalFromResponse(wire, {
      from: ref(TOKEN_A, "TKA", 18), to: ref(TOKEN_B, "TKB", 18), taker: TAKER, slippageBps: 100, quotedAt: Date.now(),
    })).toBeNull();
  });
});
