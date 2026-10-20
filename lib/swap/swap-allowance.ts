// Swap-only allowance reads. A mined approval must never be followed by a
// pre-approval `latest` read from a lagging fallback RPC. Events alone are NOT
// allowance proof. No state overrides, inferred allowances or wallet writes.
import { encodeFunctionData, type TransactionReceipt } from "viem";
import { getBlock, getTransaction, readContract } from "wagmi/actions";
import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment } from "@/lib/executor/executor-config";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { swapPathExecutor } from "./swap-executor-config";
import { swapV2Target } from "@/lib/swap/v2/v2-target";

export type ApprovalReceipt = Pick<TransactionReceipt, "status" | "from" | "to" | "transactionHash" | "blockNumber" | "blockHash">;
export async function readSwapAllowance(p: Pick<TradeProposal, "chainId" | "taker" | "from" | "fromAmount" | "permit2Spender" | "transaction">, receipt?: ApprovalReceipt): Promise<bigint | null> {
  try {
    // The spender is the executor the swap transaction actually targets: the
    // deployed V2 executor for V2 swaps, the fixed-fee Swap executor for path
    // swaps, the legacy Agent executor otherwise (the same target discriminator
    // swap-policy uses). Reading or demanding an allowance for the wrong spender
    // would strand the swap before signing. V2 is tested first because its
    // calldata is undecodable by the other two ABIs; swapV2Target() is null while
    // the V2 gate is dormant, so the resolution below is unchanged today.
    const v2Deployment = swapV2Target(p);
    const swapDeployment = swapPathExecutor();
    const spender = v2Deployment
      ? v2Deployment.executor
      : swapDeployment && p.transaction && p.transaction.to.toLowerCase() === swapDeployment.executor.toLowerCase()
      ? swapDeployment.executor
      : deployment.executor;
    if (p.chainId !== 8453 || (p.permit2Spender != null && p.permit2Spender.toLowerCase() !== spender.toLowerCase())) return null;
    if (receipt) {
      if (receipt.status !== "success" || receipt.from.toLowerCase() !== p.taker.toLowerCase() ||
          receipt.to?.toLowerCase() !== p.from.address.toLowerCase() || !receipt.blockHash || receipt.blockNumber == null) return null;
      const tx = await getTransaction(config, { chainId: 8453, hash: receipt.transactionHash });
      if (tx.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() || tx.from.toLowerCase() !== p.taker.toLowerCase() ||
          tx.to?.toLowerCase() !== p.from.address.toLowerCase() || tx.value !== 0n ||
          tx.input.toLowerCase() !== encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(p.fromAmount)] }).toLowerCase()) return null;
      const mined = await getBlock(config, { chainId: 8453, blockNumber: receipt.blockNumber });
      if (mined.hash !== receipt.blockHash) return null;
    }
    for (const delay of [0, 500, 1000, 2000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const head = await getBlock(config, { chainId: 8453, blockTag: "latest" });
      if (head.number == null || !head.hash) return null;
      if (receipt && head.number < receipt.blockNumber) continue;
      const value = await readContract(config, { chainId: 8453, address: p.from.address, abi: erc20Abi,
        functionName: "allowance", args: [p.taker, spender], blockNumber: head.number });
      const after = await getBlock(config, { chainId: 8453, blockNumber: head.number });
      if (after.hash !== head.hash) return null;
      return typeof value === "bigint" && value >= 0n ? value : null;
    }
    return null; // RPC has not caught up. This is unknown, NOT insufficient.
  } catch { return null; }
}
