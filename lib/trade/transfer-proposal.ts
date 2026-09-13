// lib/trade/transfer-proposal.ts
//
// Builds a TransferProposal from a parsed transfer request plus the
// authenticated sender address. This is the ONLY module that decides what
// goes into the unsigned transaction the user will be asked to sign — it
// never signs or sends anything itself (see transfer-execution.ts for
// the one place that does, and only from an explicit Confirm click).
//
// Balance is read live from Base via viem (never trusted from the
// client). Insufficient balance does not throw — it is surfaced as a
// critical risk fact and `sufficientBalance: false`, mirroring how
// trade-proposal.ts surfaces CDP's `issues.balance` rather than
// rejecting outright, so the UI can show the user why nothing is
// signable instead of a bare error.

import "server-only";

import { encodeFunctionData, isAddress, type Address } from "viem";

import { erc20Abi } from "@/lib/erc20-abi";
import { getTradePublicClient } from "./trade-public-client";
import { isNativeEthSentinel, TRADE_CHAIN_ID } from "./trade-config";
import { formatAtomicAmount } from "./trade-format";
import { buildTransferRiskFacts, riskToWarnings } from "./transfer-risk";
import { isTransferProposalFresh, TRANSFER_PROPOSAL_MAX_AGE_MS } from "./transfer-freshness";
import type { ParsedTransferRequest } from "./transfer-request";
import type { TransferError, TransferProposal } from "./transfer-types";

async function readSenderBalance(asset: ParsedTransferRequest["asset"], sender: Address): Promise<bigint> {
  const client = getTradePublicClient();
  if (asset.kind === "native" || isNativeEthSentinel(asset.address)) {
    return client.getBalance({ address: sender });
  }
  return client.readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [sender],
  });
}

function buildTransferTransaction(
  asset: ParsedTransferRequest["asset"],
  recipientAddress: Address,
  amount: bigint,
): TransferProposal["transaction"] {
  if (asset.kind === "native" || isNativeEthSentinel(asset.address)) {
    return { to: recipientAddress, data: "0x", value: amount.toString() };
  }
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipientAddress, amount],
  });
  return { to: asset.address, data, value: "0" };
}

export interface BuildTransferProposalInput {
  parsed: ParsedTransferRequest;
  sender: Address;
}

export type BuildTransferProposalResult =
  | { ok: true; proposal: TransferProposal }
  | { ok: false; error: TransferError };

export async function buildTransferProposal(
  input: BuildTransferProposalInput,
): Promise<BuildTransferProposalResult> {
  const { parsed, sender } = input;

  if (!isAddress(sender)) {
    return { ok: false, error: { code: "WALLET_REQUIRED", message: "A connected Base wallet is required to prepare a transfer." } };
  }

  let amount: bigint;
  try {
    amount = BigInt(parsed.amount);
    if (amount <= 0n) throw new Error("non-positive");
  } catch {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Transfer amount must be a positive value." } };
  }

  if (parsed.recipient.address.toLowerCase() === sender.toLowerCase()) {
    return { ok: false, error: { code: "INVALID_RECIPIENT", message: "Recipient cannot be your own connected wallet." } };
  }

  let senderBalance: bigint;
  try {
    senderBalance = await readSenderBalance(parsed.asset, sender);
  } catch {
    return {
      ok: false,
      error: { code: "PROVIDER_ERROR", message: `Could not read your ${parsed.asset.symbol} balance on Base. Try again shortly.` },
    };
  }

  const sufficientBalance = senderBalance >= amount;

  const risk = buildTransferRiskFacts({
    asset: parsed.asset,
    recipient: parsed.recipient,
    sufficientBalance,
  });

  const transaction = buildTransferTransaction(parsed.asset, parsed.recipient.address, amount);
  const displayAmount = `${formatAtomicAmount(amount.toString(), parsed.asset.decimals)} ${parsed.asset.symbol}`;
  const recipientLabel = parsed.recipient.basename
    ? `${parsed.recipient.basename} (${parsed.recipient.address})`
    : parsed.recipient.address;

  const proposal: TransferProposal = {
    id: `transfer-${sender.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: parsed.asset.kind === "native" ? "native-transfer" : "erc20-transfer",
    network: "base",
    chainId: TRADE_CHAIN_ID,
    asset: parsed.asset,
    amount: amount.toString(),
    sender,
    recipient: parsed.recipient,
    senderBalance: senderBalance.toString(),
    sufficientBalance,
    transaction,
    quotedAt: new Date().toISOString(),
    risk,
    warnings: riskToWarnings(risk),
    displayAmount,
    description: `Send ${displayAmount} on Base to ${recipientLabel}.`,
    requiresConfirmation: true,
    phase: "idle",
  };

  return { ok: true, proposal };
}
