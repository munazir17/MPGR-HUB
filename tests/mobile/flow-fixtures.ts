// Deterministic simulated provider response using real unsigned intent builders.
// No RPC, signing, service credentials or broadcasts.
import { buildExecutorIntent, encodeExecutorSwap, approvalAuthorization } from "../../lib/executor/executor-intent";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT } from "../../lib/executor/executor-config";
import { buildTradeProposal } from "../../lib/trade/trade-proposal";
import { reviewQuoteFixture } from "../../components/features/agent/test-fixtures/chat-review-quote";
import type { AutonomyAuthorizeFormState } from "../../components/features/agent/autonomy-authorize-form";
export function simulatedExecutorQuote(form: AutonomyAuthorizeFormState) {
  const base = reviewQuoteFixture(form);
  const result = buildExecutorIntent({ deployment: BASE_MAINNET_EXECUTOR_DEPLOYMENT, taker: base.taker,
    sellToken: form.sell, buyToken: form.buy, sellAmount: BigInt(base.fromAmount), expectedBuyAmount: 290000n,
    slippageBps: form.slippageBps, authorization: "APPROVAL", nowSeconds: Math.floor(Date.now() / 1000),
    quoteId: "offline-browser", feeBps: 25, feeRecipient: "0x2222222222222222222222222222222222222222" });
  if (!result.ok) throw new Error(result.error.message);
  const intent = result.value;
  const built = buildTradeProposal({ from: base.from, to: base.to, taker: base.taker, slippageBps: form.slippageBps, provider: "mpgr-executor",
    agentFee: { status: "applied", bps: 25, amountAtomic: intent.feeAmount, recipient: intent.feeRecipient,
      displayAmount: "0.0025 USDC", reason: null, collection: "mpgr-executor" },
    quote: { liquidityAvailable: true, fromToken: form.sell, toToken: form.buy, fromAmount: intent.sellAmount,
      toAmount: intent.expectedBuyAmount, minToAmount: intent.minBuyAmount, permit2: null,
      transaction: encodeExecutorSwap(intent, approvalAuthorization()), issues: { allowance: { currentAllowance: "0", spender: intent.executor }, balance: null, simulationIncomplete: false } } });
  if (!built.ok) throw new Error(built.error.message);
  return built.proposal;
}
