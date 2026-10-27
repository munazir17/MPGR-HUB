import type { TradeProposal } from "@/lib/trade/trade-types";
import type { Address, Hash, Hex } from "viem";
import { resolveSingleAccountCall, reviewedCalldataMatches } from "@/lib/swap/swap-mined-call";
// Events omit the pool key. Match the actual mined account call before showing
// success, both on immediate confirmation and on later history recovery.
// A builder-code suffix or an EntryPoint user operation is still the same call:
// the taker, target, value and reviewed calldata have to agree. The bundle's
// own from/to must agree with the receipt, but they are the bundler and the
// EntryPoint, not the wallet and the executor.
type MinedTx = { hash: Hash; from: Address; to: Address | null; input: Hex; value: bigint; blockNumber: bigint | null; blockHash: Hash | null };
type MinedReceipt = { transactionHash: Hash; from: Address; to: Address | null; blockNumber: bigint; blockHash: Hash };
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** Parties, target, calldata and value. Block metadata can still be missing while a node indexes the receipt. */
export function swapTransactionIdentityMatches(p: Pick<TradeProposal, "taker" | "transaction">, receipt: MinedReceipt, tx: MinedTx): boolean {
  if (!p.transaction || !eq(tx.hash, receipt.transactionHash) || !eq(receipt.from, tx.from) || !eq(receipt.to, tx.to)) return false;
  const call = resolveSingleAccountCall(tx, p.taker);
  return !!call && eq(call.to, p.transaction.to) && call.value === BigInt(p.transaction.value)
    && reviewedCalldataMatches(call.data, p.transaction.data);
}
export function swapTransactionMatches(p: Pick<TradeProposal, "taker" | "transaction">, receipt: MinedReceipt, tx: MinedTx): boolean {
  return swapTransactionIdentityMatches(p, receipt, tx) && tx.blockNumber === receipt.blockNumber && eq(tx.blockHash, receipt.blockHash);
}
