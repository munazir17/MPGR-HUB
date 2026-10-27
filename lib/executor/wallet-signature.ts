import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  isHex,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

// Permit2 accepts a 65-byte ECDSA signature, and any other length as an
// ERC-1271 contract-wallet signature. Base Smart Wallet (the recommended
// connector) returns the latter. A 65-byte-only check rejects it before
// the signature is ever recovered — the "Malformed authorization slot"
// failure on autonomous goals.

const EIP1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magic", type: "bytes4" }],
  },
] as const;

const EIP1271_MAGIC = "0x1626ba7e";
const ERC6492_MAGIC = "6492649264926492649264926492649264926492649264926492649264926492";
const MIN_CONTRACT_SIG_BYTES = 66;
const MAX_SIG_BYTES = 12_000;

export function unwrapErc6492Signature(signature: Hex): Hex {
  const body = signature.slice(2);
  if (!body.toLowerCase().endsWith(ERC6492_MAGIC) || body.length <= ERC6492_MAGIC.length) return signature;
  try {
    const payload = `0x${body.slice(0, -ERC6492_MAGIC.length)}` as Hex;
    const [decoded] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "create2Factory", type: "address" },
            { name: "factoryCalldata", type: "bytes" },
            { name: "originalSignature", type: "bytes" },
          ],
        },
      ],
      payload,
    );
    const inner = decoded.originalSignature;
    return isHex(inner) ? inner : signature;
  } catch {
    return signature;
  }
}

/** 65-byte rsv, or a longer contract-wallet signature. Null when unusable. */
export function normalizeWalletSignature(raw: unknown): Hex | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!isHex(value) || (value.length - 2) % 2 !== 0) return null;
  const unwrapped = unwrapErc6492Signature(value);
  const bytes = (unwrapped.length - 2) / 2;
  if (bytes === 65 || (bytes >= MIN_CONTRACT_SIG_BYTES && bytes <= MAX_SIG_BYTES)) return unwrapped;
  return null;
}

export function isEoaWalletSignature(signature: Hex): boolean {
  return (signature.length - 2) / 2 === 65;
}

export async function walletOwnsSignature(
  digest: Hex,
  signature: Hex,
  wallet: Address,
  client: Pick<PublicClient, "call">,
): Promise<boolean> {
  if (isEoaWalletSignature(signature)) {
    try {
      const signer = await recoverAddress({ hash: digest, signature });
      return signer.toLowerCase() === wallet.toLowerCase();
    } catch {
      return false;
    }
  }
  const data = encodeFunctionData({
    abi: EIP1271_ABI,
    functionName: "isValidSignature",
    args: [digest, signature],
  });
  try {
    const result = await client.call({ to: wallet, data });
    if (!result.data || result.data === "0x") return false;
    const magic = decodeFunctionResult({ abi: EIP1271_ABI, functionName: "isValidSignature", data: result.data });
    return magic.toLowerCase() === EIP1271_MAGIC;
  } catch {
    return false;
  }
}
