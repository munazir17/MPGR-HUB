// Mined swap and approval identity for Base.
//
// Two production shapes are not the exact transaction the wallet was shown:
//   1. An EOA send whose calldata is the reviewed payload plus an ERC-8021
//      builder-code suffix (wagmi does not apply dataSuffix itself).
//   2. A Coinbase Smart Wallet user operation: the outer transaction is a
//      bundler calling EntryPoint.handleOps, and the account's executeBatch
//      carries the swap. The outer value is often 0; the ETH amount is the
//      inner call value. A wallet suffix sits OUTSIDE the execute ABI, and
//      the app suffix sits INSIDE the inner bytes.
//
// Strip a suffix only when its length fields define an exact tail that
// ox can parse and re-encode. Never treat "starts with the reviewed calldata"
// as a match: extra ABI words plus a valid suffix must still fail.
import { Attribution } from "ox/erc8021";
import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi } from "@/lib/erc20-abi";

const ERC_SUFFIX = "80218021802180218021802180218021";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

/** Canonical EntryPoint addresses. v0.6 is what Coinbase Smart Wallet uses on Base. */
export const ENTRYPOINT_V06: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
export const ENTRYPOINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type AccountCall = { from: Address; to: Address; data: Hex; value: bigint };

type WalletCall = { to: Address; value: bigint; data: Hex };

const callTuple = [
  { name: "target", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
] as const;

const EXECUTE_BATCH = {
  type: "function",
  name: "executeBatch",
  stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: callTuple }],
  outputs: [],
} as const;

const EXECUTE_CALLS = {
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: callTuple }],
  outputs: [],
} as const;

const EXECUTE_SINGLE = {
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  outputs: [],
} as const;

const WALLET_ABI = [EXECUTE_BATCH, EXECUTE_CALLS, EXECUTE_SINGLE] as const;

const userOpV06 = [
  { name: "sender", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "initCode", type: "bytes" },
  { name: "callData", type: "bytes" },
  { name: "callGasLimit", type: "uint256" },
  { name: "verificationGasLimit", type: "uint256" },
  { name: "preVerificationGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "maxPriorityFeePerGas", type: "uint256" },
  { name: "paymasterAndData", type: "bytes" },
  { name: "signature", type: "bytes" },
] as const;

const userOpV07 = [
  { name: "sender", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "initCode", type: "bytes" },
  { name: "callData", type: "bytes" },
  { name: "accountGasLimits", type: "bytes32" },
  { name: "preVerificationGas", type: "uint256" },
  { name: "gasFees", type: "bytes32" },
  { name: "paymasterAndData", type: "bytes" },
  { name: "signature", type: "bytes" },
] as const;

const HANDLE_OPS_V06 = {
  type: "function",
  name: "handleOps",
  stateMutability: "nonpayable",
  inputs: [
    { name: "ops", type: "tuple[]", components: userOpV06 },
    { name: "beneficiary", type: "address" },
  ],
  outputs: [],
} as const;

const HANDLE_OPS_V07 = {
  type: "function",
  name: "handleOps",
  stateMutability: "nonpayable",
  inputs: [
    { name: "ops", type: "tuple[]", components: userOpV07 },
    { name: "beneficiary", type: "address" },
  ],
  outputs: [],
} as const;

export function isEntryPointAddress(address?: string | null): boolean {
  return eq(address, ENTRYPOINT_V06) || eq(address, ENTRYPOINT_V07);
}

/** Remove one exact ERC-8021 tail (schema 0, 1, or 2). Returns null when the tail is not a canonical suffix. */
export function stripOneAttributionSuffix(data: Hex): Hex | null {
  try {
    if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 2 || (data.length - 2) % 2 !== 0) return null;
    const body = data.slice(2).toLowerCase();
    if (!body.endsWith(ERC_SUFFIX) || body.length < 18 * 2) return null;
    const schemaPos = body.length - 32 - 2;
    const schema = Number.parseInt(body.slice(schemaPos, schemaPos + 2), 16);
    let suffixBytes = 0;
    if (schema === 0 || schema === 1) {
      const codesLenPos = schemaPos - 2;
      if (codesLenPos < 0) return null;
      const codesLength = Number.parseInt(body.slice(codesLenPos, codesLenPos + 2), 16);
      if (schema === 0) suffixBytes = codesLength + 1 + 1 + 16;
      else {
        const chainLenPos = codesLenPos - codesLength * 2 - 2;
        if (chainLenPos < 0) return null;
        const chainIdLen = Number.parseInt(body.slice(chainLenPos, chainLenPos + 2), 16);
        if (chainIdLen <= 0 || chainIdLen > 32) return null;
        suffixBytes = 20 + chainIdLen + 1 + codesLength + 1 + 1 + 16;
      }
    } else if (schema === 2) {
      const cborLenPos = schemaPos - 4;
      if (cborLenPos < 0) return null;
      const cborLength = Number.parseInt(body.slice(cborLenPos, cborLenPos + 4), 16);
      suffixBytes = cborLength + 2 + 1 + 16;
    } else return null;
    if (suffixBytes * 2 > body.length || suffixBytes < 18) return null;
    const tail = `0x${body.slice(body.length - suffixBytes * 2)}` as Hex;
    const parsed = Attribution.fromData(tail);
    if (!parsed) return null;
    if (Attribution.toDataSuffix(parsed).toLowerCase() !== tail.toLowerCase()) return null;
    const remain = data.slice(0, data.length - (tail.length - 2));
    return (remain.length <= 2 ? "0x" : remain) as Hex;
  } catch {
    return null;
  }
}

/** Strip up to `max` canonical suffixes. Stops at the first tail that is not one. */
export function stripAttributionSuffixes(data: Hex, max = 3): Hex {
  let current = data;
  for (let i = 0; i < max; i++) {
    const next = stripOneAttributionSuffix(current);
    if (!next) break;
    current = next;
  }
  return current;
}

/** True when `mined` is `reviewed`, or `reviewed` plus at most three canonical ERC-8021 suffixes. */
export function reviewedCalldataMatches(mined: Hex, reviewed: Hex): boolean {
  if (eq(mined, reviewed)) return true;
  let current = mined;
  for (let i = 0; i < 3; i++) {
    const next = stripOneAttributionSuffix(current);
    if (!next) return false;
    if (eq(next, reviewed)) return true;
    current = next;
  }
  return false;
}

export function isExactApprove(data: Hex, spender: Address, amount: bigint): boolean {
  const expected = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  return reviewedCalldataMatches(data, expected);
}

function tryDecodeWalletCalls(data: Hex): WalletCall[] | null {
  try {
    const decoded = decodeFunctionData({ abi: WALLET_ABI, data });
    if (decoded.functionName === "executeBatch" || (decoded.functionName === "execute" && Array.isArray(decoded.args[0]))) {
      const calls = decoded.args[0] as readonly { target: Address; value: bigint; data: Hex }[];
      return calls.map((call) => ({ to: call.target, value: call.value, data: call.data }));
    }
    if (decoded.functionName === "execute") {
      const [target, value, callData] = decoded.args as readonly [Address, bigint, Hex];
      return [{ to: target, value, data: callData }];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a smart-wallet execute payload. A suffix is removed only until the
 * wrapper ABI decodes — looping until no 8021 bytes remain would eat the
 * suffix that lives inside the inner `bytes` and break that length.
 */
function unwrapAccountCalls(callData: Hex): WalletCall[] | null {
  let data = callData;
  for (let attempt = 0; attempt < 4; attempt++) {
    const decoded = tryDecodeWalletCalls(data);
    if (decoded) return decoded;
    const next = stripOneAttributionSuffix(data);
    if (!next || eq(next, data)) return null;
    data = next;
  }
  return null;
}

function decodeUserOps(to: Address, input: Hex): { sender: Address; callData: Hex }[] | null {
  const abi = eq(to, ENTRYPOINT_V06) ? [HANDLE_OPS_V06] : eq(to, ENTRYPOINT_V07) ? [HANDLE_OPS_V07] : null;
  if (!abi) return null;
  let data = input;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const decoded = decodeFunctionData({ abi, data });
      const ops = decoded.args[0] as readonly { sender: Address; callData: Hex }[];
      return ops.map((op) => ({ sender: op.sender, callData: op.callData }));
    } catch {
      const next = stripOneAttributionSuffix(data);
      if (!next || eq(next, data)) return null;
      data = next;
    }
  }
  return null;
}

/**
 * Account-level calls a mined transaction actually performed.
 * Direct sends yield one call. EntryPoint bundles yield each unwrapped
 * inner call attributed to that operation's sender. An unknown wrapper
 * contributes nothing (fail closed) rather than a guessed substring match.
 */
export function accountCallsFromTransaction(tx: { from: Address; to: Address | null; input: Hex; value: bigint }): AccountCall[] {
  if (!tx.to) return [];
  if (isEntryPointAddress(tx.to)) {
    const ops = decodeUserOps(tx.to, tx.input);
    if (!ops) return [];
    const calls: AccountCall[] = [];
    for (const op of ops) {
      const inner = unwrapAccountCalls(op.callData);
      if (!inner) continue;
      for (const call of inner) calls.push({ from: op.sender, to: call.to, data: call.data, value: call.value });
    }
    return calls;
  }
  return [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }];
}

/** The taker's only account call, or null when they made none or more than one. */
export function resolveSingleAccountCall(
  tx: { from: Address; to: Address | null; input: Hex; value: bigint },
  taker: Address,
): AccountCall | null {
  const mine = accountCallsFromTransaction(tx).filter((call) => eq(call.from, taker));
  return mine.length === 1 ? mine[0] : null;
}

type ApprovalLog = {
  address?: string | null;
  topics?: readonly (string | null | undefined)[] | null;
  data?: string | null;
};

function topicAddress(topic: string | null | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

/**
 * Identifies an Approval log. The amount is only a filter so a dust approval
 * cannot stand in for the quoted one; the allowance() read remains the proof.
 */
export function receiptHasApproval(
  logs: readonly ApprovalLog[] | undefined,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
): boolean {
  if (!logs?.length || amount < 0n) return false;
  return logs.some((log) => {
    if (!eq(log.address, token)) return false;
    if (log.topics?.[0]?.toLowerCase() !== APPROVAL_TOPIC) return false;
    if (topicAddress(log.topics[1]) !== owner.toLowerCase()) return false;
    if (topicAddress(log.topics[2]) !== spender.toLowerCase()) return false;
    if (!log.data || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return false;
    try { return BigInt(log.data) >= amount; } catch { return false; }
  });
}

/** Direct from/to match, or an Approval log for this wallet, token, spender and amount. */
export function approvalReceiptIdentifies(
  receipt: { from?: string | null; to?: string | null; logs?: readonly ApprovalLog[] },
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
): boolean {
  if (eq(receipt.from, account) && eq(receipt.to, token)) return true;
  return receiptHasApproval(receipt.logs, token, account, spender, amount);
}
