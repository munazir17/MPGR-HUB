// lib/swap/v2/execution.ts
// End-to-end V2 execution preparation: posture -> build -> simulate -> inspect.
//
// Dormant by construction. `swapV2Executor()` returns null while
// `V2_DEPLOYMENT` is null, so nothing in the app can reach this module's
// output. Activation is a separate, explicitly approved commit.
//
// Ordering is deliberate and fail-closed:
//   1. Live posture (chain, code, pause, fee, cap, recipient, owner, timelock,
//      PoolManager pin) and every enabled venue's on-chain registration.
//   2. Build typed calldata for the exact quoted route.
//   3. `eth_call` the deployed executor at the PINNED block as the real taker.
//   4. Re-inspect the built calldata independently and require the simulated
//      output to satisfy the committed minimum.
// A transaction is returned only when all four succeed. Simulation success is
// labelled honestly: it is not a settlement proof.
import "server-only";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { SWAP_V2_CHAIN_ID } from "./deployment";
import type { SwapV2ExecutorDeployment } from "./deployment";
import { buildV2Transaction } from "./transaction";
import { inspectV2SwapTransaction, type V2SwapIntent } from "./intent";
import { verifyV2Posture, verifyV2Venues, type V2Posture, type V2PreflightReader } from "./preflight";
import { validateV2Quote, type V2Quote } from "./discovery";

export interface V2ExecutionReader extends V2PreflightReader {
  call(args: { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint }): Promise<{ data: Hex | null }>;
}

export interface V2ExecutionRequest {
  quote: V2Quote;
  taker: Address;
  slippageBps: number;
  deadline: bigint;
  nativeIn: boolean;
  nativeOut: boolean;
}

export interface V2ExecutableSwap {
  chainId: typeof SWAP_V2_CHAIN_ID;
  executor: Address;
  /** Approval spender — identical to the executor that receives the calldata. */
  spender: Address;
  transaction: { to: Address; data: Hex; value: bigint };
  minimum: bigint;
  quotedOut: bigint;
  fee: bigint;
  feeBps: number;
  feeRecipient: Address;
  intentId: Hex;
  intent: V2SwapIntent;
  posture: V2Posture;
  blockNumber: bigint;
  blockHash: Hex;
  executionSimulation: "eth-call-succeeded-no-settlement-proof";
  entry: V2SwapIntent["entry"];
}

/** Deterministic, quote-bound intent id. Binds the exact pair, gross amount,
 * taker, slippage, pinned block and every leg's pool so two different quotes
 * can never share an id, and settlement can be matched unambiguously. */
export function v2IntentId(
  deployment: SwapV2ExecutorDeployment,
  quote: V2Quote,
  taker: Address,
  slippageBps: number,
  block: { number: bigint; hash: Hex },
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint8" }, { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address[]" },
    ],
    [
      2, BigInt(SWAP_V2_CHAIN_ID), deployment.executor, taker,
      quote.tokenIn, quote.tokenOut, quote.gross, quote.amountOut,
      BigInt(slippageBps), block.number, block.hash,
      // Pool ADDRESSES, not Pool records: legs carry resolved pool objects.
      quote.legs.flatMap((leg) => leg.pools.map((pool) => pool.pool)),
    ],
  ));
}

/** Prepares an executable V2 swap, or throws. Never fabricates a transaction:
 * every failure path throws before anything signable is returned. */
export async function prepareV2Execution(
  reader: V2ExecutionReader,
  deployment: SwapV2ExecutorDeployment,
  request: V2ExecutionRequest,
  block: { number: bigint; hash: Hex; timestamp?: bigint },
): Promise<V2ExecutableSwap> {
  const { quote, taker, slippageBps, deadline, nativeIn, nativeOut } = request;
  // Re-validate the quote's own invariants (single gross fee, leg allocation,
  // typed pool shape, hop bounds) before anything is encoded.
  validateV2Quote(quote);

  // The timestamp lets an already-elapsed governance fee change fail closed.
  const posture = await verifyV2Posture(reader, deployment, block.number, block.timestamp);
  await verifyV2Venues(reader, deployment, block.number);

  const intentId = v2IntentId(deployment, quote, taker, slippageBps, block);
  const built = buildV2Transaction(quote, deployment.executor, taker, deadline, slippageBps, nativeIn, nativeOut, intentId);

  const simulated = await reader.call({
    account: taker, to: deployment.executor, data: built.data, value: built.value, blockNumber: block.number,
  });
  if (!simulated.data) throw new Error("V2 executor simulation returned no data; no swap was prepared.");
  const simulatedOut = BigInt(simulated.data);
  if (simulatedOut < built.minimum) throw new Error("V2 executor simulation did not satisfy the committed minimum; no swap was prepared.");
  if (simulatedOut < quote.amountOut) throw new Error("V2 executor simulation returned less than the quoted output; no swap was prepared.");

  const inspected = inspectV2SwapTransaction(
    { to: built.to, data: built.data, value: built.value },
    {
      deployment, taker, feeBps: posture.feeBps, feeRecipient: posture.feeRecipient,
      fromAddress: nativeIn ? deployment.weth : quote.tokenIn,
      toAddress: nativeOut ? deployment.weth : quote.tokenOut,
      nativeIn, nativeOut,
    },
  );
  if (!inspected.ok) throw new Error(`V2 calldata failed independent inspection: ${inspected.reason}`);
  if (inspected.value.intentId !== intentId) throw new Error("V2 intent id does not bind this quote.");
  if (inspected.value.amountOutMinimum !== built.minimum) throw new Error("V2 minimum output does not match the built transaction.");

  return {
    chainId: SWAP_V2_CHAIN_ID, executor: deployment.executor, spender: deployment.executor,
    transaction: { to: built.to, data: built.data, value: built.value },
    minimum: built.minimum, quotedOut: quote.amountOut, fee: quote.fee,
    feeBps: posture.feeBps, feeRecipient: posture.feeRecipient, intentId,
    intent: inspected.value, posture, blockNumber: block.number, blockHash: block.hash,
    executionSimulation: "eth-call-succeeded-no-settlement-proof",
    entry: inspected.value.entry,
  };
}
