// Read-only wallet checks; execution remains in trade-execution.ts.
import { encodeFunctionData, type Address, type TransactionReceipt } from "viem";
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
import { readSwapAllowance } from "./swap-allowance";
import { MPGR_SWAP_EXECUTOR_ABI } from "./swap-executor-abi";
import { swapPathExecutor } from "./swap-executor-config";
import { swapV2Target } from "@/lib/swap/v2/v2-target";
import { SWAP_V2_ABI } from "@/lib/swap/v2/abi";
import { SWAP_V2_POSTURE_ABI } from "@/lib/swap/v2/posture-abi";

// Both executor families share provider "mpgr-executor"; the transaction
// TARGET identifies which deployed contract will pull funds and take the
// fee (the same discriminator swap-policy and swap-allowance use). Wallet
// preflight must verify THAT contract's allowance target and fee terms —
// the other executor's posture is irrelevant to this swap.
function swapPathTarget(p: TradeProposal) {
  const swapDeployment = swapPathExecutor();
  return swapDeployment && p.transaction && p.transaction.to.toLowerCase() === swapDeployment.executor.toLowerCase() ? swapDeployment : null;
}
/** The address an ERC-20 approval must name for THIS proposal: the executor that
 * will actually pull the funds. Estimating gas for an approval to the wrong
 * spender would understate or overstate the real approval cost. */
function approvalSpender(p: TradeProposal): Address {
  return swapV2Target(p)?.executor ?? swapPathTarget(p)?.executor ?? deployment.executor;
}
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
  const tx = phase === "approval" ? { to: p.from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approvalSpender(p), BigInt(p.fromAmount)] }), value: 0n }
    : { to: p.transaction.to, data: p.transaction.data, value: BigInt(p.transaction.value) };
  // Base is OP Stack: include L1 data, operator and L2 fees, not gas*price alone.
  const total = await estimateTotalFee(client, { account: p.taker, ...tx });
  if (total <= 0n) throw new Error("Base gas estimate unavailable");
  return total;
}
export async function validateSwapWallet(p: TradeProposal, phase: "approval" | "swap", approvalReceipt?: TransactionReceipt): Promise<TradeError | null> {
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
      const value = await readSwapAllowance(p, approvalReceipt);
      if (value === null) throw new Error("Unknown allowance");
      allowance = value;
      if (typeof allowance !== "bigint" || allowance < 0n) throw new Error("Unknown allowance");
    } catch { return fail("PROVIDER_ERROR", "Token allowance could not be verified. Retry the check; no approval or swap was requested by this step."); }
    if (phase === "approval" && allowance >= BigInt(p.fromAmount)) return fail("QUOTE_CHANGED", "Allowance now covers this pay amount. Refresh the quote; another approval is not needed.");
    if (phase === "swap" && allowance < BigInt(p.fromAmount)) return fail("APPROVAL_FAILED", "Actual allowance is insufficient. Retry approval; no swap was submitted.");
  }
  try {
    // V2 first: its calldata and ABI are distinct from both other executors.
    // swapV2Target() is null while the V2 gate is dormant, so the V1/legacy
    // reads below are exactly as they were.
    const v2Deployment = swapV2Target(p);
    const pathDeployment = v2Deployment ? null : swapPathTarget(p);
    const feeConfig: [Promise<unknown>, Promise<unknown>] = v2Deployment
      ? [readContract(config, { address: v2Deployment.executor, abi: SWAP_V2_ABI, functionName: "feeRecipient", chainId: 8453 }),
         readContract(config, { address: v2Deployment.executor, abi: SWAP_V2_ABI, functionName: "feeBps", chainId: 8453 })]
      : pathDeployment
      ? [readContract(config, { address: pathDeployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "feeRecipient", chainId: 8453 }),
         readContract(config, { address: pathDeployment.executor, abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "feeBps", chainId: 8453 })]
      : [readContract(config, { address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "feeRecipient", chainId: 8453 }),
         readContract(config, { address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "feeBps", chainId: 8453 })];
    // V2 exposes an on-chain pause switch; check it before prompting the wallet
    // so a paused executor never becomes a signed transaction. V1 has no such
    // switch, so this resolves to null and changes nothing for V1.
    const v2Paused: Promise<unknown> = v2Deployment
      ? readContract(config, { address: v2Deployment.executor, abi: SWAP_V2_POSTURE_ABI, functionName: "paused", chainId: 8453 })
      : Promise.resolve(null);
    const [balance, native, recipient, bps, gas, paused] = await Promise.all([
      readSwapBalance(p.taker, p.from), getBalance(config, { address: p.taker, chainId: 8453 }),
      feeConfig[0], feeConfig[1],
      estimateSwapGas(p, phase),
      v2Paused,
    ]);
    if (paused !== null && paused !== false) return fail("EXECUTION_UNAVAILABLE", "The MPGR V2 executor is paused on-chain. Nothing was submitted; request a fresh quote later.");
    if (String(recipient).toLowerCase() !== p.agentFee!.recipient!.toLowerCase() || Number(bps) !== 25) return fail("QUOTE_CHANGED", "Executor fee configuration changed. Request a fresh quote; nothing was submitted.");
    if (balance.decimals !== p.from.decimals) return fail("QUOTE_CHANGED", "Token decimals changed. Request a fresh quote.");
    if (balance.value < BigInt(p.fromAmount)) return fail("INSUFFICIENT_BALANCE", `Insufficient ${p.from.symbol} balance. Lower the pay amount.`);
    const nativePay = isNativeEthSentinel(p.from.address) ? BigInt(p.fromAmount) : 0n;
    if (native.value < nativePay + gas * 2n) return fail("INSUFFICIENT_BALANCE", "Insufficient ETH for the pay amount and a buffered Base network fee. Lower the amount or add ETH.");
    if (phase === "swap" && !isNativeEthSentinel(p.from.address)) {
      const allowance = await readSwapAllowance(p, approvalReceipt);
      if (typeof allowance !== "bigint" || allowance < 0n) throw new Error("Unknown allowance");
      if (allowance < BigInt(p.fromAmount)) return fail("APPROVAL_FAILED", "Actual allowance is insufficient. Retry approval; no swap was submitted.");
    }
    return context() ?? (!swapQuoteFresh(p) ? fail("QUOTE_EXPIRED", "Quote expired during validation. Refresh before signing.") : null);
  } catch { return fail("PROVIDER_ERROR", "Could not verify live balance, allowance, fee configuration or Base gas. Retry the checks; nothing was submitted by this step."); }
}
