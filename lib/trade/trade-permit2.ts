// lib/trade/trade-permit2.ts
//
// CDP Swap API (0x-style) Permit2 signature append.
// Official BYO-wallet pattern: sign the quote's EIP-712 permit, then
// concat [tx.data, signatureLength32, signature] before broadcast.
//
// viem rejects an EIP712Domain entry inside `types`, so it is stripped
// before signTypedData.

import {
  concat,
  numberToHex,
  size,
  type Hex,
} from "viem";

import type { CdpPermit2Eip712 } from "./trade-types";

export function stripEip712Domain(
  types: CdpPermit2Eip712["types"],
): CdpPermit2Eip712["types"] {
  const next: CdpPermit2Eip712["types"] = {};
  for (const [key, value] of Object.entries(types)) {
    if (key === "EIP712Domain") continue;
    next[key] = value;
  }
  return next;
}

export function appendPermit2Signature(txData: Hex, signature: Hex): Hex {
  const signatureLengthInHex = numberToHex(size(signature), {
    signed: false,
    size: 32,
  });
  return concat([txData, signatureLengthInHex, signature]);
}
