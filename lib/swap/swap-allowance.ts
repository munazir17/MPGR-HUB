// Swap-only allowance reads. A pinned block is preferred so a lagging `latest`
// cannot report the pre-approval allowance. If the RPC refuses that block as
// archive state, `latest` is accepted only once it covers the pay amount.
// Events alone are NOT allowance proof. No state overrides or wallet writes.
import type { TransactionReceipt } from "viem";
import { getBlock, getTransaction, readContract } from "wagmi/actions";
import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment } from "@/lib/executor/executor-config";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { isExactApprove, receiptHasApproval, resolveSingleAccountCall } from "./swap-mined-call";
import { swapPathExecutor } from "./swap-executor-config";
import { swapV2Target } from "@/lib/swap/v2/v2-target";
import { isAllowlistedPublicRouter } from "@/lib/swap/route-desk";

export type ApprovalReceipt = Pick<TransactionReceipt, "status" | "from" | "to" | "transactionHash" | "blockNumber" | "blockHash"> & {
  logs?: TransactionReceipt["logs"];
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function readSwapAllowance(p: Pick<TradeProposal, "chainId" | "taker" | "from" | "fromAmount" | "permit2Spender" | "transaction">, receipt?: ApprovalReceipt): Promise<bigint | null> {
  try {
    // The spender is the executor the swap transaction actually targets: the
    // deployed V2 executor for V2 swaps, the fixed-fee Swap executor for path
    // swaps, the legacy Agent executor otherwise (the same target discriminator
    // swap-policy uses). Reading or demanding an allowance for the wrong spender
    // would strand the swap before signing. V2 is tested first because its
    // calldata is undecodable by the other two ABIs; swapV2Target() is null while
    // the V2 gate is dormant, so the resolution below is unchanged today.
    const hinted = p.transaction?.to;
    const publicRouter = hinted && isAllowlistedPublicRouter(hinted) && (p.permit2Spender == null || p.permit2Spender.toLowerCase() === hinted.toLowerCase())
      ? hinted
      : null;
    const v2Deployment = publicRouter ? null : swapV2Target(p);
    const swapDeployment = swapPathExecutor();
    const spender = publicRouter
      ? publicRouter
      : v2Deployment
      ? v2Deployment.executor
      : swapDeployment && p.transaction && p.transaction.to.toLowerCase() === swapDeployment.executor.toLowerCase()
      ? swapDeployment.executor
      : deployment.executor;
    if (p.chainId !== 8453 || (p.permit2Spender != null && p.permit2Spender.toLowerCase() !== spender.toLowerCase())) return null;
    if (receipt) {
      if (receipt.status !== "success" || !receipt.blockHash || receipt.blockNumber == null) return null;
      const logProof = receiptHasApproval(receipt.logs, p.from.address, p.taker, spender, BigInt(p.fromAmount));
      let indexed = false;
      for (const delay of [0, 350, 800]) {
        if (delay) await pause(delay);
        try {
          const tx = await getTransaction(config, { chainId: 8453, hash: receipt.transactionHash });
          if (tx.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()) return null;
          if (receipt.from && tx.from && receipt.from.toLowerCase() !== tx.from.toLowerCase()) return null;
          if ((receipt.to || tx.to) && receipt.to?.toLowerCase() !== tx.to?.toLowerCase()) return null;
          const call = resolveSingleAccountCall(tx, p.taker);
          const approveCall = !!call && call.to.toLowerCase() === p.from.address.toLowerCase()
            && call.value === 0n && isExactApprove(call.data, spender, BigInt(p.fromAmount));
          // A decoded call that is not this exact approve is not proof, even if
          // some other log mentions the token. Logs only identify a receipt we
          // could not unwrap to a single account call (a smart-wallet bundle).
          if (!approveCall && !(logProof && !call)) return null;
          indexed = true;
          break;
        } catch { /* the receipt can land before this RPC has indexed the transaction */ }
      }
      if (!indexed) return null;
      const mined = await getBlock(config, { chainId: 8453, blockNumber: receipt.blockNumber });
      if (mined.hash !== receipt.blockHash) return null;
    }
    for (const delay of [0, 200, 450]) {
      if (delay) await pause(delay);
      const head = await getBlock(config, { chainId: 8453, blockTag: "latest" });
      if (head.number == null || !head.hash) return null;
      if (receipt && head.number < receipt.blockNumber) continue;
      try {
        const value = await readContract(config, { chainId: 8453, address: p.from.address, abi: erc20Abi,
          functionName: "allowance", args: [p.taker, spender], blockNumber: head.number });
        const after = await getBlock(config, { chainId: 8453, blockNumber: head.number });
        if (after.hash !== head.hash) return null;
        return typeof value === "bigint" && value >= 0n ? value : null;
      } catch {
        // A pinned read can fail because the node treats that head as archive
        // state, or because the RPC blipped after the approval mined. Neither
        // is an insufficient allowance. Try latest, then the next backoff.
        // A stale zero is not accepted while the receipt is in hand.
        try {
          const latest = await readContract(config, { chainId: 8453, address: p.from.address, abi: erc20Abi,
            functionName: "allowance", args: [p.taker, spender], blockTag: "latest" });
          if (typeof latest === "bigint" && latest >= 0n && (!receipt || latest >= BigInt(p.fromAmount))) return latest;
        } catch { /* the next head */ }
      }
    }
    return null; // RPC has not caught up. This is unknown, NOT insufficient.
  } catch { return null; }
}
