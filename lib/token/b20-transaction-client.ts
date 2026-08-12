// lib/token/b20-transaction-client.ts

import { getAccount, writeContract } from "wagmi/actions";
import type { Abi, Address, Hash } from "viem";
import { config } from "@/lib/wagmi";

// Central write path for every transaction that touches Base's B20 native
// -asset precompile — either directly (MPGR's own approve/transfer/
// transferFrom) or indirectly (a contract call, like TokenLock.createLock or
// MPGRStaking.stake, whose own logic performs a transfer/transferFrom
// against MPGR internally). Two independent problems have been observed
// against this specific path, and this module exists so both are fixed once
// instead of re-discovered per feature:
//
//   1. eth_estimateGas's binary search under-estimates gas for calls that
//      execute through the precompile, producing on-chain "out of gas"
//      reverts even for entirely valid calls (the original 150,000 gas fix
//      for approve()).
//   2. Some wallets' own pre-sign simulators (observed: Rabby, "Simulation
//      Failed #-39000") cannot correctly simulate this precompile path
//      either, and surface a warning even for a call that will succeed
//      on-chain.
//
// Neither problem is fixed by our own simulateContract() pre-check running
// harder — it hits the same precompile-simulation gap eth_estimateGas does.
// The fix for (1) is a known-safe explicit `gas`, chosen per operation (see
// the comment at each call site in staking-client.ts / token-lock-client.ts
// for the reasoning behind that operation's number — this module does not
// pick gas values itself). There is no dapp-side fix for (2) — see the
// comment on sendB20Write below.
//
// This module is opt-in per call site, not a global override: contract
// calls that do NOT touch MPGR/B20 keep using simulateContract() normally
// in their own client, untouched by this file.

export interface B20WriteParams<TAbi extends Abi> {
  address: Address;
  abi: TAbi;
  functionName: string;
  args?: readonly unknown[];
  chainId: number;
  gas: bigint;
  // Optional — defaults to the currently connected wallet. Pass explicitly
  // only when a caller needs to guarantee this write uses the exact same
  // account as a preceding step in the same flow (see TokenLock's
  // createLock(), which keeps its own explicit `account` parameter from
  // the approval/allowance-sync fix — unchanged by this module).
  account?: Address;
}

function resolveAccount(explicit?: Address): Address {
  if (explicit) return explicit;
  const { address } = getAccount(config);
  if (!address) {
    throw new Error("No connected wallet account — connect a wallet before sending this transaction.");
  }
  return address;
}

// Sends a B20-touching write directly via writeContract(), skipping our own
// simulateContract() entirely.
//
// IMPORTANT — what this does and does NOT fix:
// This does NOT and CANNOT suppress a wallet's own pre-sign simulation
// warning (e.g. Rabby's "Simulation Failed #-39000"). That simulation runs
// inside the wallet itself, after this function has already handed off the
// raw transaction request — it is entirely wallet-side and outside dapp
// control. The only legitimate ways past it are the wallet's own affordance
// for that (e.g. Rabby's "Ignore all"), or the user reviewing the raw
// calldata ("View Raw") and choosing to proceed. What this function DOES
// fix: it stops OUR OWN dapp code from (a) running a redundant local
// eth_call that can spuriously fail before the wallet is ever shown the
// transaction at all, and (b) letting a bad eth_estimateGas guess get baked
// into the gas limit that's ultimately sent.
export async function sendB20Write<TAbi extends Abi>(params: B20WriteParams<TAbi>): Promise<Hash> {
  const { address, abi, functionName, args, chainId, gas } = params;
  const account = resolveAccount(params.account);

  return writeContract(config, {
    address,
    abi,
    functionName,
    args,
    chainId,
    gas,
    account,
  } as Parameters<typeof writeContract>[1]);
}
