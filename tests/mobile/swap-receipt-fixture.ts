// Simulated receipts ONLY; not transcribed/live chain evidence.
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Hex, type Log } from "viem";
import { inspectExecutorSwapTransaction } from "../../lib/executor/executor-intent";
import { MPGR_EXECUTOR_ABI } from "../../lib/executor/mpgr-executor-abi";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment } from "../../lib/executor/executor-config";
import { isNativeEthSentinel } from "../../lib/trade/trade-config";
import type { TradeProposal } from "../../lib/trade/trade-types";
import type { ReceiptLike } from "../../lib/executor/executor-verify";
export function simulatedSwapReceipt(p: TradeProposal, hash: Hex, overrides: { feeRecipient?: `0x${string}`; feeAmount?: bigint; amountOut?: bigint } = {}): ReceiptLike {
  const inspected = inspectExecutorSwapTransaction(p.transaction!);
  if (!inspected.ok) throw new Error(inspected.reason);
  const x = inspected.value;
  const data = encodeAbiParameters(parseAbiParameters("address,address,uint256,uint256,uint256,uint256,address,uint16,uint8,uint8"),
    [x.tokenIn, x.tokenOut, x.grossAmountIn, overrides.feeAmount ?? x.expectedFeeAmount, x.swapAmountIn, overrides.amountOut ?? BigInt(p.toAmount), overrides.feeRecipient ?? p.agentFee!.recipient!, 25,
      x.routerKind === "UNISWAP_V3_ROUTER02" ? 2 : 1, (isNativeEthSentinel(p.from.address) ? 1 : 0) | (x.unwrapNativeOut ? 2 : 0)]);
  const topics = encodeEventTopics({ abi: MPGR_EXECUTOR_ABI, eventName: "SwapExecuted", args: { taker: p.taker, router: x.router, intentId: x.intentId } });
  return { status: "success", transactionHash: hash, blockNumber: 999n, from: p.taker, to: deployment.executor,
    logs: [{ address: deployment.executor, data, topics, removed: false, logIndex: 0, transactionIndex: 0, transactionHash: hash, blockNumber: 999n, blockHash: null } as Log] };
}
