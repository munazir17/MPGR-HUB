// lib/swap/swap-path-search.ts
// Server-only bounded search over typed fixed-fee executor paths. Mirrors the
// deployed-executor search discipline: pinned block, fresh quotes, policy
// validation, wallet-ready simulation only, no signing and no grants.
import "server-only";
import { decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { erc20Abi } from "@/lib/erc20-abi";
import { buildExecutorAgentFee } from "@/lib/trade/trade-agent-fee";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { buildTradeProposal, tradeProposalId } from "@/lib/trade/trade-proposal";
import { intentIdFromQuoteId } from "@/lib/executor/executor-intent";
import type { CdpSwapQuote, TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "./swap-executor-abi";
import { SWAP_FEE_BPS, SWAP_FEE_RECIPIENT, type SwapPathExecutorDeployment } from "./swap-executor-config";
import { swapPathFeeFloor } from "./swap-executor-intent";
import { swapPathCandidates, swapPathKey, type SwapPathCandidate } from "./swap-path-candidates";
import { swapPathRoutingEvidenceValid, type SwapPathOutcome, type SwapPathRoutingEvidence, type SwapPathRoutedProposal } from "./swap-path-evidence";
import { buildSwapPathTransaction, quoteSwapPath, SwapPathQuoteError, type SwapPathQuoteInput } from "./swap-path-quote";
import { swapQuotePolicyError } from "./swap-policy";
import { SwapRouteQualificationError, type SwapRouteReadClient } from "./swap-route-selection";

export interface SwapPathSearchResult { proposal: TradeProposal; blockNumber: bigint; blockHash: Hex }
const QUOTE_DEADLINE_SECONDS = 180;

async function simulateReadyPath(reader: SwapRouteReadClient, deployment: SwapPathExecutorDeployment, p: TradeProposal, blockNumber: bigint): Promise<SwapPathRoutingEvidence["executionSimulation"]> {
  const notRun = "not-run-wallet-preflight-required" as const;
  const native = isNativeEthSentinel(p.from.address);
  try {
    const gross = BigInt(p.fromAmount);
    const balance = native ? await reader.getBalance({ address: p.taker }) : await reader.readContract({ address: p.from.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [p.taker] });
    if (typeof balance !== "bigint" || balance < gross) return notRun;
    if (!native) {
      const allowance = await reader.readContract({ address: p.from.address as Address, abi: erc20Abi, functionName: "allowance", args: [p.taker, deployment.executor] });
      if (typeof allowance !== "bigint" || allowance < gross) return notRun;
    }
    const result = await reader.simulateContract({
      address: deployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "swapExactInput",
      args: decodePathArgs(p.transaction!.data), account: p.taker as Address, value: BigInt(p.transaction!.value), blockNumber,
    });
    if (typeof result.result !== "bigint" || result.result < BigInt(p.minToAmount)) throw new SwapRouteQualificationError("EXECUTOR_QUOTE_MISMATCH", "Swap executor simulation did not satisfy the committed minimum.", 422);
    return "eth-call-succeeded-no-settlement-proof";
  } catch (error) {
    if (error instanceof SwapRouteQualificationError) throw error;
    return notRun;
  }
}
function decodePathArgs(data: string) {
  const decoded = decodeFunctionData({ abi: MPGR_SWAP_EXECUTOR_ABI, data: data as Hex });
  if (decoded.functionName !== "swapExactInput") throw new SwapRouteQualificationError("EXECUTOR_SIMULATION_INVALID", "Unsupported Swap executor selector.", 422);
  return decoded.args;
}

/** Verifies the release candidate's immutable fee terms at the pinned block. */
export async function verifySwapPathFeeTerms(reader: SwapRouteReadClient, deployment: SwapPathExecutorDeployment): Promise<void> {
  const [bps, recipient] = await Promise.all([
    reader.readContract({ address: deployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "feeBps" }),
    reader.readContract({ address: deployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "feeRecipient" }),
  ]);
  if (Number(bps) !== SWAP_FEE_BPS || String(recipient).toLowerCase() !== SWAP_FEE_RECIPIENT.toLowerCase()) {
    throw new SwapRouteQualificationError("FEE_RECIPIENT_CHANGED", "The Swap executor's live fee terms differ from the required 25 bps recipient. No swap was prepared.", 422);
  }
}

export async function searchSwapPaths(
  client: SwapRouteReadClient,
  input: { from: TradeTokenRef; to: TradeTokenRef; fromAmount: string; slippageBps: number; taker: Address },
  deployment: SwapPathExecutorDeployment,
  block: { number: bigint; hash: Hex },
): Promise<SwapPathSearchResult | null> {
  const candidates: SwapPathCandidate[] = swapPathCandidates(input.from.address, input.to.address);
  if (!candidates.length) return null;
  await verifySwapPathFeeTerms(client, deployment);
  const outcomes: SwapPathOutcome[] = [];
  let winner: { proposal: TradeProposal; quotedOut: bigint } | null = null;
  const startedAt = Date.now();
  for (const candidate of candidates) {
    const key = swapPathKey(candidate);
    if (Date.now() - startedAt > 12_000) { outcomes.push({ key, state: "unavailable", reason: "SEARCH_BUDGET_EXCEEDED", output: null }); continue; }
    try {
      const quote = await quoteSwapPath(client, input as SwapPathQuoteInput, candidate, block);
      const id = tradeProposalId({ from: input.from.address, to: input.to.address, fromAmount: input.fromAmount, taker: input.taker, slippageBps: input.slippageBps });
      const built = buildSwapPathTransaction(deployment, input as SwapPathQuoteInput, quote, Math.floor(Date.now() / 1000) + QUOTE_DEADLINE_SECONDS, intentIdFromQuoteId(`${id}:${key}`));
      const fee = buildExecutorAgentFee({ grossAmountIn: input.fromAmount, feeBps: SWAP_FEE_BPS, feeRecipient: SWAP_FEE_RECIPIENT, from: input.from, taker: input.taker });
      if (!fee.ok) throw new SwapPathQuoteError("FEE_POLICY_INVALID", fee.reason);
      const quotePayload: CdpSwapQuote = {
        liquidityAvailable: true, fromToken: input.from.address, toToken: input.to.address,
        fromAmount: input.fromAmount, toAmount: built.quotedOut.toString(), minToAmount: built.minOut.toString(),
        fees: {}, issues: { allowance: null, balance: null, simulationIncomplete: true },
        transaction: { to: deployment.executor, data: built.data, value: built.value.toString() }, permit2: null,
      };
      const proposal = buildTradeProposal({ from: input.from, to: input.to, quote: quotePayload, slippageBps: input.slippageBps, taker: input.taker, provider: "mpgr-executor", quotedAt: new Date(), agentFee: fee.fee });
      if (!proposal.ok) throw new SwapPathQuoteError("EXECUTION_UNAVAILABLE", proposal.error.message);
      const p = proposal.proposal;
      const invalid = swapQuotePolicyError(p);
      if (invalid) throw new SwapPathQuoteError("QUOTE_POLICY_INVALID", invalid);
      const evidence: SwapPathRoutingEvidence = {
        version: 2, key, hops: candidate.hops.length, pools: quote.pools, blockNumber: block.number.toString(), blockHash: block.hash,
        calldataHash: keccak256(built.data),
        outcomes: [{ key, state: "quoted", reason: "QUOTE_ONLY_NOT_EXECUTION_PROOF", output: built.quotedOut.toString() }],
        executionSimulation: "not-run-wallet-preflight-required",
      };
      if (!swapPathRoutingEvidenceValid(p, evidence)) throw new SwapPathQuoteError("QUOTE_POLICY_INVALID", "Path evidence does not match the prepared transaction.");
      evidence.executionSimulation = await simulateReadyPath(client, deployment, p, block.number);
      evidence.outcomes = outcomes.slice();
      (p as SwapPathRoutedProposal).swapPathRouting = evidence;
      outcomes.push({ key, state: "quoted", reason: "QUOTE_ONLY_NOT_EXECUTION_PROOF", output: built.quotedOut.toString() });
      if (!winner || built.quotedOut > winner.quotedOut) winner = { proposal: p, quotedOut: built.quotedOut };
    } catch (error) {
      const code = error instanceof SwapPathQuoteError ? error.code : error instanceof SwapRouteQualificationError ? error.reason : "ROUTE_VERIFICATION_UNAVAILABLE";
      if (["FEE_RECIPIENT_CHANGED", "FEE_POLICY_INVALID", "QUOTE_POLICY_INVALID"].includes(code)) throw error;
      outcomes.push({ key, state: code === "POOL_UNAVAILABLE" || code === "LIQUIDITY_UNAVAILABLE" ? "rejected" : "unavailable", reason: code, output: null });
    }
  }
  if (!winner) return null;
  for (const outcome of outcomes) if (outcome.state === "quoted") outcome.reason = "QUOTE_ONLY_NOT_EXECUTION_PROOF";
  (winner.proposal as SwapPathRoutedProposal).swapPathRouting = { ...((winner.proposal as SwapPathRoutedProposal).swapPathRouting)!, outcomes };
  return { proposal: winner.proposal, blockNumber: block.number, blockHash: block.hash };
}
export { swapPathFeeFloor };
