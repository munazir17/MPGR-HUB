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
import type { CdpSwapIssues, CdpSwapQuote, TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "./swap-executor-abi";
import { SWAP_FEE_BPS, SWAP_FEE_RECIPIENT, type SwapPathExecutorDeployment } from "./swap-executor-config";
import { swapPathFeeFloor } from "./swap-executor-intent";
import { swapPathCandidates, swapPathKey, type SwapPathCandidate } from "./swap-path-candidates";
import { swapPathRoutingEvidenceValid, type SwapPathOutcome, type SwapPathRoutingEvidence, type SwapPathRoutedProposal } from "./swap-path-evidence";
import { buildSwapPathTransaction, quoteSwapPath, SwapPathQuoteError, type SwapPathQuoteInput } from "./swap-path-quote";
import { swapQuotePolicyError } from "./swap-policy";
import { SwapRouteQualificationError, type SwapRouteReadClient } from "./swap-route-selection";

export interface SwapPathSearchResult { proposal: TradeProposal; blockNumber: bigint; blockHash: Hex }
const QUOTE_DEADLINE_SECONDS = 300;

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

/** Verifies the deployed executor's live posture (fee terms + pause state) at
 * the pinned block before any path quote is prepared. Fail-closed: an
 * unreadable executor is a retryable verification failure, never a quote. */
export async function verifySwapPathFeeTerms(reader: SwapRouteReadClient, deployment: SwapPathExecutorDeployment): Promise<void> {
  let bps: unknown, recipient: unknown, paused: unknown;
  try {
    [bps, recipient, paused] = await Promise.all([
      reader.readContract({ address: deployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "feeBps" }),
      reader.readContract({ address: deployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "feeRecipient" }),
      reader.readContract({ address: deployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "paused" }),
    ]);
  } catch {
    throw new SwapRouteQualificationError("ROUTE_VERIFICATION_UNAVAILABLE", "The Swap executor's live fee terms could not be verified. No swap was prepared.", 503);
  }
  if (paused !== false) {
    throw new SwapRouteQualificationError("EXECUTOR_PAUSED", "The Swap executor is paused on-chain. No swap was prepared.", 503);
  }
  if (Number(bps) !== SWAP_FEE_BPS || String(recipient).toLowerCase() !== SWAP_FEE_RECIPIENT.toLowerCase()) {
    throw new SwapRouteQualificationError("FEE_RECIPIENT_CHANGED", "The Swap executor's live fee terms differ from the required 0.25% trading fee and recipient. No swap was prepared.", 422);
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
  // Wallet-readiness issues, mirroring the legacy executor quote: approval
  // is a SEPARATE transaction for the GROSS amount, granted to THIS
  // executor (spender = deployment.executor). Read once — allowance and
  // balance are candidate-independent. Without the real allowance issue,
  // the execution engine would never offer the approval step and a
  // first-time user's swap could only revert.
  const grossIn = BigInt(input.fromAmount);
  const nativeIn = isNativeEthSentinel(input.from.address);
  let allowanceIssue: CdpSwapIssues["allowance"] = null;
  if (!nativeIn) {
    try {
      const allowance = await client.readContract({ address: input.from.address as Address, abi: erc20Abi, functionName: "allowance", args: [input.taker, deployment.executor] });
      if (typeof allowance !== "bigint") throw new Error("Invalid allowance read");
      if (allowance < grossIn) allowanceIssue = { currentAllowance: allowance.toString(), spender: deployment.executor };
    } catch {
      // Fail closed toward showing the approval step: an unnecessary
      // approve() is cheaper than an on-chain revert.
      allowanceIssue = { currentAllowance: "0", spender: deployment.executor };
    }
  }
  let balanceIssue: CdpSwapIssues["balance"] = null;
  try {
    const balance = nativeIn
      ? await client.getBalance({ address: input.taker })
      : await client.readContract({ address: input.from.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [input.taker] });
    if (typeof balance === "bigint" && balance < grossIn) {
      balanceIssue = { token: input.from.address, currentBalance: balance.toString(), requiredBalance: grossIn.toString() };
    }
  } catch {
    balanceIssue = null; // live re-read before signing still guards this.
  }
  const startedAt = Date.now();
  const attempts = await Promise.all(candidates.map(async (candidate, index) => {
    const key = swapPathKey(candidate);
    if (Date.now() - startedAt > 12_000) return { index, outcome: { key, state: "unavailable" as const, reason: "SEARCH_BUDGET_EXCEEDED", output: null } };
    try {
      const quote = await quoteSwapPath(client, input as SwapPathQuoteInput, candidate, block);
      const id = tradeProposalId({ from: input.from.address, to: input.to.address, fromAmount: input.fromAmount, taker: input.taker, slippageBps: input.slippageBps });
      const built = buildSwapPathTransaction(deployment, input as SwapPathQuoteInput, quote, Math.floor(Date.now() / 1000) + QUOTE_DEADLINE_SECONDS, intentIdFromQuoteId(`${id}:${key}`));
      const fee = buildExecutorAgentFee({ grossAmountIn: input.fromAmount, feeBps: SWAP_FEE_BPS, feeRecipient: SWAP_FEE_RECIPIENT, from: input.from, taker: input.taker });
      if (!fee.ok) throw new SwapPathQuoteError("FEE_POLICY_INVALID", fee.reason);
      const quotePayload: CdpSwapQuote = {
        liquidityAvailable: true, fromToken: input.from.address, toToken: input.to.address,
        fromAmount: input.fromAmount, toAmount: built.quotedOut.toString(), minToAmount: built.minOut.toString(),
        fees: {}, issues: { allowance: allowanceIssue, balance: balanceIssue, simulationIncomplete: true },
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
      (p as SwapPathRoutedProposal).swapPathRouting = evidence;
      return { index, outcome: { key, state: "quoted" as const, reason: "QUOTE_ONLY_NOT_EXECUTION_PROOF", output: built.quotedOut.toString() }, proposal: p, quotedOut: built.quotedOut };
    } catch (error) {
      const code = error instanceof SwapPathQuoteError ? error.code : error instanceof SwapRouteQualificationError ? error.reason : "ROUTE_VERIFICATION_UNAVAILABLE";
      if (["FEE_RECIPIENT_CHANGED", "FEE_POLICY_INVALID", "QUOTE_POLICY_INVALID"].includes(code)) return { index, fatal: error instanceof Error ? error : new SwapPathQuoteError("QUOTE_POLICY_INVALID", "Path quote failed.") };
      return { index, outcome: { key, state: code === "POOL_UNAVAILABLE" || code === "LIQUIDITY_UNAVAILABLE" ? "rejected" as const : "unavailable" as const, reason: code, output: null } };
    }
  }));
  const fatal = attempts.find((attempt) => "fatal" in attempt && attempt.fatal);
  if (fatal && "fatal" in fatal && fatal.fatal) throw fatal.fatal;
  const outcomes: SwapPathOutcome[] = [];
  let winner: { proposal: TradeProposal; quotedOut: bigint } | null = null;
  for (const attempt of attempts) {
    if (!("outcome" in attempt) || !attempt.outcome) continue;
    outcomes.push(attempt.outcome);
    if ("proposal" in attempt && attempt.proposal && attempt.quotedOut !== undefined && (!winner || attempt.quotedOut > winner.quotedOut)) {
      winner = { proposal: attempt.proposal, quotedOut: attempt.quotedOut };
    }
  }
  if (!winner) return null;
  for (const outcome of outcomes) if (outcome.state === "quoted") outcome.reason = "QUOTE_ONLY_NOT_EXECUTION_PROOF";
  (winner.proposal as SwapPathRoutedProposal).swapPathRouting = { ...((winner.proposal as SwapPathRoutedProposal).swapPathRouting)!, outcomes };
  return { proposal: winner.proposal, blockNumber: block.number, blockHash: block.hash };
}
export { swapPathFeeFloor };
