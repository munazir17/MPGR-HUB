import type { TradeProposal } from "@/lib/trade/trade-types";
import type { Address, Hash, Hex } from "viem";
// Events omit the pool key. Match the actual mined calldata before showing
// success, both on immediate confirmation and on later history recovery.
type MinedTx = { hash: Hash; from: Address; to: Address | null; input: Hex; value: bigint; blockNumber: bigint | null; blockHash: Hash | null };
type MinedReceipt = { transactionHash: Hash; from: Address; to: Address | null; blockNumber: bigint; blockHash: Hash };
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** Parties, target, calldata and value. Block metadata can still be missing while a node indexes the receipt. */
export function swapTransactionIdentityMatches(p: Pick<TradeProposal, "taker" | "transaction">, receipt: MinedReceipt, tx: MinedTx): boolean {
  return !!p.transaction && eq(tx.hash, receipt.transactionHash) && eq(tx.from, p.taker) && eq(receipt.from, tx.from)
    && eq(tx.to, p.transaction.to) && eq(receipt.to, tx.to) && eq(tx.input, p.transaction.data)
    && tx.value === BigInt(p.transaction.value);
}
export function swapTransactionMatches(p: Pick<TradeProposal, "taker" | "transaction">, receipt: MinedReceipt, tx: MinedTx): boolean {
  return swapTransactionIdentityMatches(p, receipt, tx) && tx.blockNumber === receipt.blockNumber && eq(tx.blockHash, receipt.blockHash);
}
