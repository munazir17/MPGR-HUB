// Read-only wallet checks; execution remains in trade-execution.ts.
import { encodeFunctionData, type Address } from "viem";
import { estimateTotalFee } from "viem/op-stack";
import { getAccount, getBalance, getPublicClient, readContract } from "wagmi/actions";
import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment } from "@/lib/executor/executor-config";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { swapQuoteFresh } from "./swap-lifecycle";
import type { TradeError, TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { swapQuotePolicyError } from "./swap-policy";
export async function readSwapBalance(account: Address, token: TradeTokenRef) {
  if (isNativeEthSentinel(token.address)) return { value: (await getBalance(config, { address: account, chainId: 8453 })).value, decimals: 18 };
  const [value, decimals] = await Promise.all([
    readContract(config, { address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: 8453 }),
    readContract(config, { address: token.address, abi: erc20Abi, functionName: "decimals", chainId: 8453 }),
  ]);
  if (typeof value !== "bigint" || value < 0n || !Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 255) throw new Error("Invalid balance metadata");
  return { value, decimals: Number(decimals) };
}
export async function estimateSwapGas(p: TradeProposal, phase: "approval" | "swap" = "swap"): Promise<bigint> {
  const client = getPublicClient(config, { chainId: 8453 });
  if (!client || !p.transaction) throw new Error("Base gas estimate unavailable");
  const tx = phase === "approval" ? { to: p.from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.executor, BigInt(p.fromAmount)] }), value: 0n }
    : { to: p.transaction.to, data: p.transaction.data, value: BigInt(p.transaction.value) };
  // Base is OP Stack: include L1 data, operator and L2 fees, not gas*price alone.
  const total = await estimateTotalFee(client, { account: p.taker, ...tx });
  if (total <= 0n) throw new Error("Base gas estimate unavailable");
  return total;
}
export async function validateSwapWallet(p: TradeProposal, phase: "approval" | "swap"): Promise<TradeError | null> {
  const fail = (code: TradeError["code"], message: string): TradeError => ({ code, message });
  const context = () => {
    const account = getAccount(config);
    if (!account.isConnected || account.address?.toLowerCase() !== p.taker.toLowerCase()) return fail("WALLET_REQUIRED", "Wallet changed. Connect the quoted wallet and request a fresh quote.");
    if (account.chainId !== 8453) return fail("UNSUPPORTED_NETWORK", "Network changed. Switch to Base and request a fresh quote.");
    return null;
  };
  const changed = context(); if (changed) return changed;
  const invalid = swapQuotePolicyError(p); if (invalid) return fail("EXECUTION_UNAVAILABLE", invalid);
  if (p.risk.some(r => r.severity === "critical")) return fail("EXECUTION_UNAVAILABLE", "A critical route warning prevents signing. Request a fresh quote.");
  if (!swapQuoteFresh(p)) return fail("QUOTE_EXPIRED", "Quote expired. Refresh it; any confirmed approval is retained.");
  // Unknown allowance must not become an approval prompt. A changed sufficient
  // allowance needs a fresh review, not a redundant approval transaction.
  if (!isNativeEthSentinel(p.from.address)) {
    let allowance: bigint;
    try {
      allowance = await readContract(config, { address: p.from.address, abi: erc20Abi, functionName: "allowance", args: [p.taker, deployment.executor], chainId: 8453 });
      if (typeof allowance !== "bigint" || allowance < 0n) throw new Error("Unknown allowance");
    } catch { return fail("PROVIDER_ERROR", "Token allowance could not be verified. Retry the check; no approval or swap was requested by this step."); }
    if (phase === "approval" && allowance >= BigInt(p.fromAmount)) return fail("QUOTE_CHANGED", "Allowance now covers this pay amount. Refresh the quote; another approval is not needed.");
    if (phase === "swap" && allowance < BigInt(p.fromAmount)) return fail("APPROVAL_FAILED", "Actual allowance is insufficient. Retry approval; no swap was submitted.");
  }
  try {
    const [balance, native, recipient, bps, gas] = await Promise.all([
      readSwapBalance(p.taker, p.from), getBalance(config, { address: p.taker, chainId: 8453 }),
      readContract(config, { address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "feeRecipient", chainId: 8453 }),
      readContract(config, { address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "feeBps", chainId: 8453 }),
      estimateSwapGas(p, phase),
    ]);
    if (String(recipient).toLowerCase() !== p.agentFee!.recipient!.toLowerCase() || Number(bps) !== 25) return fail("QUOTE_CHANGED", "Executor fee configuration changed. Request a fresh quote; nothing was submitted.");
    if (balance.decimals !== p.from.decimals) return fail("QUOTE_CHANGED", "Token decimals changed. Request a fresh quote.");
    if (balance.value < BigInt(p.fromAmount)) return fail("INSUFFICIENT_BALANCE", `Insufficient ${p.from.symbol} balance. Lower the pay amount.`);
    const nativePay = isNativeEthSentinel(p.from.address) ? BigInt(p.fromAmount) : 0n;
    if (native.value < nativePay + gas * 2n) return fail("INSUFFICIENT_BALANCE", "Insufficient ETH for the pay amount and a buffered Base network fee. Lower the amount or add ETH.");
    if (phase === "swap" && !isNativeEthSentinel(p.from.address)) {
      const allowance = await readContract(config, { address: p.from.address, abi: erc20Abi, functionName: "allowance", args: [p.taker, deployment.executor], chainId: 8453 });
      if (typeof allowance !== "bigint" || allowance < 0n) throw new Error("Unknown allowance");
      if (allowance < BigInt(p.fromAmount)) return fail("APPROVAL_FAILED", "Actual allowance is insufficient. Retry approval; no swap was submitted.");
    }
    return context() ?? (!swapQuoteFresh(p) ? fail("QUOTE_EXPIRED", "Quote expired during validation. Refresh before signing.") : null);
  } catch { return fail("PROVIDER_ERROR", "Could not verify live balance, allowance, fee configuration or Base gas. Retry the checks; nothing was submitted by this step."); }
}
