// Deterministic simulated provider response using real unsigned intent builders.
// No RPC, signing, service credentials or broadcasts.
import { buildExecutorIntent, encodeExecutorSwap, approvalAuthorization } from "../../lib/executor/executor-intent";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT } from "../../lib/executor/executor-config";
import { buildTradeProposal } from "../../lib/trade/trade-proposal";
import { isNativeEthSentinel } from "../../lib/trade/trade-config";
import { MANUAL_SWAP_TOKENS } from "../../lib/trade/manual-swap";
import { parseHumanTokenAmount, formatAtomicAmount } from "../../lib/trade/trade-format";
import type { AutonomyAuthorizeFormState } from "../../components/features/agent/autonomy-authorize-form";
export function simulatedExecutorQuote(form: AutonomyAuthorizeFormState, output?: bigint) {
  const from = MANUAL_SWAP_TOKENS.find(t => t.address.toLowerCase() === form.sell.toLowerCase());
  const to = MANUAL_SWAP_TOKENS.find(t => t.address.toLowerCase() === form.buy.toLowerCase());
  if (!from || !to) throw new Error("Unsupported simulated token");
  const base = { from, to, taker: "0x1111111111111111111111111111111111111111" as const, fromAmount: parseHumanTokenAmount(form.sellAmount, from.decimals)!.toString() };
  const result = buildExecutorIntent({ deployment: BASE_MAINNET_EXECUTOR_DEPLOYMENT, taker: base.taker,
    sellToken: isNativeEthSentinel(form.sell) ? BASE_MAINNET_EXECUTOR_DEPLOYMENT.weth : form.sell, buyToken: isNativeEthSentinel(form.buy) ? BASE_MAINNET_EXECUTOR_DEPLOYMENT.weth : form.buy,
    sellNative: isNativeEthSentinel(form.sell), buyNative: isNativeEthSentinel(form.buy), sellAmount: BigInt(base.fromAmount), expectedBuyAmount: output ?? 10n ** BigInt(to.decimals) / 100n,
    slippageBps: form.slippageBps, authorization: "APPROVAL", nowSeconds: Math.floor(Date.now() / 1000),
    quoteId: "offline-browser", feeBps: 25, feeRecipient: "0x2222222222222222222222222222222222222222" });
  if (!result.ok) throw new Error(result.error.message);
  const intent = result.value;
  const built = buildTradeProposal({ from: base.from, to: base.to, taker: base.taker, slippageBps: form.slippageBps, provider: "mpgr-executor",
    agentFee: { status: "applied", bps: 25, amountAtomic: intent.feeAmount, recipient: intent.feeRecipient,
      displayAmount: `${formatAtomicAmount(intent.feeAmount, from.decimals, from.decimals)} ${from.symbol}`, reason: null, collection: "mpgr-executor" },
    quote: { liquidityAvailable: true, fromToken: form.sell, toToken: form.buy, fromAmount: intent.sellAmount,
      toAmount: intent.expectedBuyAmount, minToAmount: intent.minBuyAmount, permit2: null,
      transaction: encodeExecutorSwap(intent, approvalAuthorization()), issues: { allowance: isNativeEthSentinel(form.sell) ? null : { currentAllowance: "0", spender: intent.executor }, balance: null, simulationIncomplete: false } } });
  if (!built.ok) throw new Error(built.error.message);
  return built.proposal;
}
