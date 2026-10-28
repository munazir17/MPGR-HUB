import "server-only";

// Production wiring for the Agent's PaigerSwap V2 port.
// Discovery, calldata, simulation and posture all come from lib/swap/v2.
// This file does not construct a second route and it never signs or sends.

import type { Address, Hex, StateOverride } from "viem";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { discoverV2Quote, V2QuoteError, type V2Quote } from "@/lib/swap/v2/discovery";
import { swapV2Executor, SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/deployment";
import { prepareV2Execution, type V2ExecutionReader, type V2ExecutionRequest } from "@/lib/swap/v2/execution";
import { V2PreflightError, verifyV2Posture } from "@/lib/swap/v2/preflight";
import { swapV2QuoteSource } from "@/lib/swap/v2/rpc-source";
import { erc20AllowanceOverride, readErc20Allowance, type AllowanceClient } from "@/lib/swap/v2/simulation-allowance";
import {
  type PaigerSwapV2Binding,
  type PaigerSwapV2Port,
  type PaigerSwapV2QuoteRequest,
  type PaigerSwapV2QuoteResult,
} from "./paigerswap-v2";

function mapV2Error(error: unknown): PaigerSwapV2QuoteResult {
  if (error instanceof V2QuoteError) {
    // A completed search with no pool may use the existing explicit 0x fallback.
    // An RPC, fee, or simulation failure must not.
    return {
      ok: false,
      code: error.code,
      message: error.message,
      fallThrough: error.code === "LIQUIDITY_UNAVAILABLE",
    };
  }
  if (error instanceof V2PreflightError) {
    return { ok: false, code: error.code, message: error.message, fallThrough: false };
  }
  return {
    ok: false,
    code: "EXECUTION_UNAVAILABLE",
    message: "The V2 executor could not verify this route. No swap was prepared.",
    fallThrough: false,
  };
}

function asReader(client: ReturnType<typeof getTradePublicClient>): V2ExecutionReader {
  return {
    getChainId: () => client.getChainId(),
    getCode: (args) => client.getCode(args),
    readContract: (args) => client.readContract(args as never),
    call: async (args) => {
      const result = await client.call(args as never);
      return { data: result.data ?? null };
    },
  };
}

function readerWithAllowance(reader: V2ExecutionReader, stateOverride: StateOverride): V2ExecutionReader {
  return new Proxy(reader, {
    get(target, prop, receiver) {
      if (prop === "call") {
        return (args: object) => (target.call as (args: object) => Promise<{ data: Hex | null }>)({ ...args, stateOverride });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function bindingFrom(swap: Awaited<ReturnType<typeof prepareV2Execution>>, quote: V2Quote): PaigerSwapV2Binding {
  return {
    executor: swap.executor,
    transaction: {
      to: swap.transaction.to,
      data: swap.transaction.data,
      value: swap.transaction.value.toString(),
    },
    minBuyAmount: swap.minimum.toString(),
    intentId: swap.intentId,
    deadline: swap.intent.deadline.toString(),
    blockNumber: swap.blockNumber.toString(),
    blockHash: swap.blockHash,
    executionSimulation: swap.executionSimulation,
    entry: swap.entry,
    hops: swap.intent.hops,
    pools: quote.legs.flatMap((leg) => leg.pools.map((pool) => pool.pool)),
  };
}

/** Quote through the canonical V2 discovery and execution modules. */
export async function quoteOnPaigerSwapV2(input: PaigerSwapV2QuoteRequest): Promise<PaigerSwapV2QuoteResult> {
  const deployment = swapV2Executor();
  if (!deployment) {
    return { ok: false, code: "V2_NOT_ACTIVATED", message: "PaigerSwap V2 routing is not activated.", fallThrough: true };
  }
  try {
    const client = getTradePublicClient();
    if (await client.getChainId() !== 8453) {
      return { ok: false, code: "UNSUPPORTED_NETWORK", message: "PaigerSwap V2 quotes require Base mainnet (8453).", fallThrough: false };
    }
    const block = await client.getBlock();
    if (block.number === null || !block.hash || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
      return { ok: false, code: "PROVIDER_ERROR", message: "The provider returned a malformed block. No swap was prepared.", fallThrough: false };
    }
    const quote = await discoverV2Quote(swapV2QuoteSource(client, block.number), input.sellToken, input.buyToken, input.gross);
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
      return { ok: false, code: "QUOTE_CHANGED", message: "The chain moved while the route was quoted. Request a fresh quote.", fallThrough: false };
    }
    const baseReader = asReader(client);
    const allowance = input.nativeIn
      ? null
      : await readErc20Allowance(client as unknown as AllowanceClient, input.sellToken, input.taker, deployment.executor, block.number);
    const needsApproval = allowance !== null && allowance < input.gross;
    const override = needsApproval
      ? await erc20AllowanceOverride(client as unknown as AllowanceClient, input.sellToken, input.taker, deployment.executor, block.number)
      : undefined;
    const reader = override ? readerWithAllowance(baseReader, override) : baseReader;
    const blockPin = { number: block.number, hash: block.hash as Hex, timestamp: BigInt(block.timestamp) };
    const request: V2ExecutionRequest = {
      quote,
      taker: input.taker,
      slippageBps: input.slippageBps,
      deadline: input.deadline,
      nativeIn: input.nativeIn,
      nativeOut: input.nativeOut,
    };
    let swap;
    try {
      swap = await prepareV2Execution(reader, deployment, request, blockPin);
    } catch (error) {
      if (error instanceof V2PreflightError || error instanceof V2QuoteError) return mapV2Error(error);
      if (!needsApproval) {
        return { ok: false, code: "EXECUTION_UNAVAILABLE", message: "The V2 executor could not verify this route. No swap was prepared.", fallThrough: false };
      }
      try {
        swap = await prepareV2Execution(baseReader, deployment, request, blockPin, { quoteWithoutFunding: true });
      } catch (again) {
        return mapV2Error(again);
      }
    }
    if (swap.fee !== quote.fee || swap.executor.toLowerCase() !== deployment.executor.toLowerCase()) {
      return { ok: false, code: "FEE_POLICY_INVALID", message: "The V2 execution fee does not match the quoted fee.", fallThrough: false };
    }
    return {
      ok: true,
      fee: quote.fee,
      amountOut: quote.amountOut,
      priceImpactBps: typeof quote.priceImpactBps === "number" ? quote.priceImpactBps : null,
      binding: bindingFrom(swap, quote),
    };
  } catch (error) {
    return mapV2Error(error);
  }
}

/** Re-check the live executor before the wallet is shown the quoted transaction. */
export async function confirmPaigerSwapV2(
  binding: PaigerSwapV2Binding,
  taker: Address,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const deployment = swapV2Executor();
  if (!deployment || deployment.executor.toLowerCase() !== binding.executor.toLowerCase()) {
    return { ok: false, code: "V2_NOT_ACTIVATED", message: "PaigerSwap V2 is not the active executor for this quote." };
  }
  try {
    const client = getTradePublicClient();
    if (await client.getChainId() !== 8453) {
      return { ok: false, code: "UNSUPPORTED_NETWORK", message: "PaigerSwap V2 confirmation requires Base mainnet (8453)." };
    }
    const block = await client.getBlock();
    if (block.number === null) {
      return { ok: false, code: "PROVIDER_ERROR", message: "The provider did not return a block. Nothing was sent." };
    }
    await verifyV2Posture(asReader(client), deployment, block.number, BigInt(block.timestamp));
    if (binding.executionSimulation === "quoted-before-approval") return { ok: true };
    const simulated = await client.call({
      account: taker,
      to: binding.transaction.to,
      data: binding.transaction.data,
      value: BigInt(binding.transaction.value),
      blockNumber: block.number,
    });
    if (!simulated.data || BigInt(simulated.data) < BigInt(binding.minBuyAmount)) {
      return { ok: false, code: "QUOTE_STALE", message: "The quoted V2 route no longer clears its minimum. Request a fresh quote. Nothing was sent." };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof V2PreflightError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "QUOTE_STALE", message: "The quoted V2 transaction could not be re-checked. Request a fresh quote. Nothing was sent." };
  }
}

export function createPaigerSwapV2Port(): PaigerSwapV2Port {
  const deployment = swapV2Executor();
  return {
    activated: deployment !== null,
    executor: deployment?.executor ?? SWAP_V2_SEALED_MANIFEST.executor,
    quote: quoteOnPaigerSwapV2,
    confirm: confirmPaigerSwapV2,
  };
}
