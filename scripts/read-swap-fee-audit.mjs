// Read-only public Base evidence. NO accounts, signatures, sends or env writes.
// Called by the existing automatic Preview check, never workflow_dispatch.
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, parseEventLogs, decodeFunctionData, isAddress, zeroAddress } from "viem";
import { base } from "viem/chains";
const record = JSON.parse(readFileSync(new URL("../deployments/base-mainnet/mpgr-executor.json", import.meta.url), "utf8"));
const abi = JSON.parse(readFileSync(new URL("../deployments/base-mainnet/MPGRExecutor.abi.json", import.meta.url), "utf8"));
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
// Previously captured in lib/mcp/__tests__/base-mainnet-live-fixtures.ts.
const historical = ["0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3", "0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6"];
/** @typedef {{hash: string, verified: boolean, status?: string, blockNumber?: string, feeAsset?: string, feeAmountAtomic?: string, feeRecipient?: string, grossAmountAtomic?: string, receivedAtomic?: string, erc20FeeTransferAmountAtomic?: string, matchingFeeTransfers?: number, error?: string}} HistoricalFeeEvidence */
const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export async function readSwapFeeAudit(injectedClient) {
  if (record.chainId !== 8453 || !isAddress(record.executor)) throw new Error("Invalid recorded Base deployment");
  const result = { observedAt: new Date().toISOString(), chainId: 8453, executor: record.executor, recordedRecipient: record.feeRecipient,
    source: "Read-only Base RPC; Executor.feeRecipient(), not NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT (MCP 0x only)",
    current: { verified: false }, historical: /** @type {HistoricalFeeEvidence[]} */ ([]), liveTradesInitiated: false };
  // Public endpoint already used by the application; no deployment settings or credentials.
  const client = injectedClient ?? createPublicClient({ chain: base, transport: http("https://mainnet.base.org", { timeout: 10_000, retryCount: 0 }) });
  try {
    if (await client.getChainId() !== 8453) throw new Error("Wrong RPC chain");
    const blockNumber = await client.getBlockNumber();
    const [recipient, bps, paused, code] = await Promise.all([
      client.readContract({ address: record.executor, abi, functionName: "feeRecipient", blockNumber }),
      client.readContract({ address: record.executor, abi, functionName: "feeBps", blockNumber }),
      client.readContract({ address: record.executor, abi, functionName: "paused", blockNumber }),
      client.getCode({ address: record.executor, blockNumber }),
    ]);
    if (!code || code === "0x" || !isAddress(recipient) || eq(recipient, zeroAddress)) throw new Error("Unverified executor configuration");
    result.current = { verified: true, blockNumber: blockNumber.toString(), feeRecipient: recipient, feeBps: Number(bps), paused: Boolean(paused), swapPolicyCompliant: Number(bps) === 25 && !paused };
    for (const hash of historical) {
      try {
        const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
        const decoded = decodeFunctionData({ abi, data: tx.input });
        if (decoded.functionName !== "swapUniswapV3ExactInputSingle") throw new Error("Historical method mismatch");
        const [p] = decoded.args;
        const events = parseEventLogs({ abi, eventName: "SwapExecuted", logs: receipt.logs.filter(l => eq(l.address, record.executor)) });
        const event = events.length === 1 ? events[0].args : null;
        if (!event) throw new Error("Missing authoritative swap event");
        const transfers = parseEventLogs({ abi: transferAbi, eventName: "Transfer", logs: receipt.logs.filter(l => eq(l.address, event.tokenIn)) });
        const matches = transfers.filter(l => eq(l.args.from, record.executor) && eq(l.args.to, event.feeRecipient));
        const transferAmount = matches.reduce((sum, l) => sum + l.args.value, 0n);
        const verified = receipt.status === "success" && eq(receipt.transactionHash, hash) && eq(tx.to, record.executor) && eq(receipt.to, record.executor) &&
          eq(tx.from, event.taker) && eq(receipt.from, event.taker) && eq(event.taker, p.recipient) && eq(event.router, p.router) &&
          eq(event.tokenIn, p.tokenIn) && eq(event.tokenOut, p.tokenOut) && eq(event.intentId, p.intentId) &&
          event.grossAmountIn === p.grossAmountIn && event.feeAmount === p.expectedFeeAmount && event.feeAmount === event.grossAmountIn * 25n / 10000n &&
          Number(event.feeBps) === 25 && Number(event.flags) === 0 && event.amountOut >= p.amountOutMinimum && event.swapAmountIn + event.feeAmount === event.grossAmountIn && transferAmount === event.feeAmount;
        result.historical.push({ hash, verified, status: receipt.status, blockNumber: receipt.blockNumber.toString(), feeAsset: event.tokenIn, feeAmountAtomic: event.feeAmount.toString(), feeRecipient: event.feeRecipient,
          grossAmountAtomic: event.grossAmountIn.toString(), receivedAtomic: event.amountOut.toString(), erc20FeeTransferAmountAtomic: transferAmount.toString(), matchingFeeTransfers: matches.length });
      } catch { result.historical.push({ hash, verified: false, error: "Historical receipt/transaction/transfer evidence unavailable or invalid; no collection claim." }); }
    }
  } catch { result.current = { verified: false, error: "Live Base fee configuration unavailable. Recorded deployment metadata is not a current on-chain read." }; }
  return result;
}
