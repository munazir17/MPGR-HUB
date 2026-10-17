// Isolated wallet/RPC transport. Real app controllers; no connector/key/RPC.
import { decodeFunctionData, type Address, type Hash } from "viem";
import { erc20Abi } from "../../lib/erc20-abi";
import { findKnownTradeToken } from "../../lib/trade/trade-tokens";
import type { TradeProposal } from "../../lib/trade/trade-types";
import { simulatedSwapReceipt } from "./swap-receipt-fixture";
type Tx = { minedStatus?: "success" | "reverted"; proposal: TradeProposal; hash: Hash; account: Address; to: Address; data: `0x${string}`; value: bigint; approval: boolean };
type Browser = { simulatedPendingSwap?: () => void; simulatedHistoryDelay?: boolean; simulatedHistoryResolvers?: (() => void)[]; simulatedWalletCalls?: string[]; simulatedWalletScenario?: string; simulatedAccount?: { address: Address; chainId: number; isConnected: boolean }; simulatedProposal?: TradeProposal; simulatedTransactions?: { hash: Hash; to: Address; data: string; value: string }[] };
const state = () => window as unknown as Browser;
const record = (method: string) => { (state().simulatedWalletCalls ??= []).push(method); };
const scenario = () => state().simulatedWalletScenario;
const transactions = new Map<Hash, Tx>();
const allowances = new Map<string, bigint>();
const balanceChanges = new Map<string, bigint>();
const applied = new Set<Hash>();
const native = "native";
const balanceKey = (owner: string, token: string) => `${owner}:${token}`.toLowerCase();
const change = (owner: string, token: string, delta: bigint) => { const key = balanceKey(owner, token); balanceChanges.set(key, (balanceChanges.get(key) ?? 0n) + delta); };
const allowanceKey = (account: string, token: string, spender: string) => `${account}:${token}:${spender}`.toLowerCase();
export function getAccount() { return state().simulatedAccount ?? { address: "0x1111111111111111111111111111111111111111", chainId: 8453, isConnected: true }; }
export function getPublicClient() { return {}; }
export async function getBalance(_config?: unknown, params?: { address: Address }) { record("native-balance-read"); const owner = params?.address ?? getAccount().address; return { value: scenario() === "insufficient-gas" ? 0n : (owner.startsWith("0x3333") ? 3n : 2n) * 10n ** 18n + (balanceChanges.get(balanceKey(owner, native)) ?? 0n), decimals: 18 }; }
export async function readContract(_config: unknown, params: { address: Address; functionName: string; args?: readonly unknown[] }) {
  record(params.functionName);
  const decimals = findKnownTradeToken(params.address)?.decimals ?? 6;
  if (params.functionName === "decimals") return decimals;
  if (params.functionName === "feeRecipient") return state().simulatedProposal?.agentFee?.recipient;
  if (params.functionName === "feeBps") return scenario() === "fee-changed" ? 50 : 25;
  if (params.functionName === "allowance") {
    if (scenario() === "allowance-read-error") throw new Error("Simulated unavailable allowance");
    const [owner, spender] = params.args!;
    return allowances.get(allowanceKey(String(owner), params.address, String(spender))) ?? 0n;
  }
  if (params.functionName === "balanceOf") {
    if (scenario() === "balance-error") throw new Error("Simulated balance unavailable");
    const owner = String(params.args?.[0]);
    return scenario() === "dust-balance" ? 399n : scenario() === "insufficient" ? 0n : (owner.startsWith("0x3333") ? 42n : 100n) * 10n ** BigInt(decimals) + (balanceChanges.get(balanceKey(owner, params.address)) ?? 0n);
  }
  throw new Error(`Unexpected simulated read ${params.functionName}`);
}
export async function sendTransaction(_config: unknown, params: Omit<Tx, "hash" | "approval" | "proposal">) {
  record("simulated-send");
  const approval = params.data.startsWith("0x095ea7b3");
  if (scenario() === "wallet-rejected" || (approval && scenario() === "approval-rejected") || (!approval && scenario() === "swap-rejected")) throw Object.assign(new Error("User rejected request"), { code: 4001 });
  const hash = (`0x${(transactions.size + 1).toString(16).padStart(64, "0")}`) as Hash;
  transactions.set(hash, { ...params, hash, approval, proposal: state().simulatedProposal! });
  (state().simulatedTransactions ??= []).push({ hash, to: params.to, data: params.data, value: params.value.toString() });
  return hash;
}
export async function signTypedData() { record("simulated-permit"); return ("0x" + "cd".repeat(65)) as `0x${string}`; }
async function receipt(hash: Hash) {
  const tx = transactions.get(hash); if (!tx) throw new Error("Unknown simulated transaction");
  const p = tx.proposal;
  if (tx.approval) {
    if (scenario() === "approval-receipt-error") throw new Error("Simulated approval receipt unavailable");
    const status = tx.minedStatus ??= (["reverted", "approval-reverted"].includes(scenario() ?? "") ? "reverted" : "success");
    if (!applied.has(hash) && status === "success" && scenario() !== "allowance-insufficient") {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (decoded.functionName !== "approve") throw new Error("Not an approval");
      allowances.set(allowanceKey(tx.account, tx.to, decoded.args[0]), decoded.args[1]);
    }
    if (!applied.has(hash)) { applied.add(hash); change(tx.account, native, -1_000_000_000_000n); }
    if (scenario() === "approval-expired") await new Promise(r => setTimeout(r, 1800));
    return { status, transactionHash: hash, blockNumber: 999n, from: tx.account, to: tx.to, logs: [] };
  }
  if (scenario() === "swap-receipt-error") throw new Error("Simulated swap receipt unavailable");
  const result = simulatedSwapReceipt(p, hash, scenario() === "wrong-fee-recipient" ? { feeRecipient: "0x9999999999999999999999999999999999999999" } : {});
  if (scenario() === "wrong-receipt-hash") result.transactionHash = `0x${"ff".repeat(32)}`;
  if (scenario() === "missing-fee-event") result.logs = [];
  result.status = tx.minedStatus ??= (scenario() === "swap-reverted" ? "reverted" : "success");
  if (!applied.has(hash)) {
    applied.add(hash); change(tx.account, native, -1_000_000_000_000n);
    if (result.status === "success") {
      if (p.from.kind !== "native") {
        const key = allowanceKey(tx.account, p.from.address, p.transaction!.to);
        allowances.set(key, (allowances.get(key) ?? 0n) - BigInt(p.fromAmount));
      }
      change(tx.account, p.from.kind === "native" ? native : p.from.address, -BigInt(p.fromAmount));
      change(tx.account, p.to.kind === "native" ? native : p.to.address, BigInt(p.toAmount));
    }
  }
  return result;
}
export async function waitForTransactionReceipt(_config: unknown, params: { hash: Hash }) { record("simulated-receipt"); if (!transactions.get(params.hash)?.approval && scenario() === "swap-pending") await new Promise<void>(resolve => { state().simulatedPendingSwap = resolve; }); return receipt(params.hash); }
export async function getTransactionReceipt(_config: unknown, params: { hash: Hash }) {
  if (state().simulatedHistoryDelay) await new Promise<void>(resolve => { (state().simulatedHistoryResolvers ??= []).push(resolve); });
  const result = await receipt(params.hash); record("history-read-completed"); return result;
}
export async function getTransaction(_config: unknown, params: { hash: Hash }) { const tx = transactions.get(params.hash); if (!tx) throw new Error("Unknown simulated transaction"); return { from: tx.account, to: tx.to, input: tx.data, value: tx.value, hash: tx.hash }; }
export const config = {};
