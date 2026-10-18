// Arbitrary exact-address ERC-20 inspection, independent of executable identities.
import { erc20Abi, getAddress, hexToString, parseAbi, zeroAddress } from "viem";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { contractInterfaceError, exactSwapAddress, finishSwapSnapshot, snapshotEvidence, startSwapSnapshot, SwapDiscoveryError, type SwapDiscoveryClient } from "./swap-discovery-read";
import { safeSwapTokenText } from "./swap-token-text";
export async function readSwapTokenMetadata(client: SwapDiscoveryClient, input: unknown, blockNumber: bigint): Promise<TradeTokenRef> {
  const address = getAddress(exactSwapAddress(input));
  if (isNativeEthSentinel(address)) throw new SwapDiscoveryError("NATIVE_NOT_ERC20", "ETH is the native Base asset, not an ERC-20 contract. Select ETH separately.", 422);
  try {
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === "0x") throw new SwapDiscoveryError("TOKEN_NOT_CONTRACT", "No contract exists at this Base address. Do not import a wallet address.", 422);
    const text = async (functionName: "symbol" | "name") => {
      try { return await client.readContract({ address, abi: erc20Abi, functionName, blockNumber }); }
      catch (e) {
        if (!contractInterfaceError(e)) throw e;
        const bytes = await client.readContract({ address, abi: parseAbi([`function ${functionName}() view returns (bytes32)`]), functionName, blockNumber });
        if (typeof bytes !== "string" || !/^0x[0-9a-f]{64}$/i.test(bytes)) return null;
        return hexToString(bytes as `0x${string}`, { size: 32 }).replace(/\0+$/, "");
      }
    };
    const [decimals, supply, balance, symbol, name] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
      client.readContract({ address, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
      client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [zeroAddress], blockNumber }),
      text("symbol"), text("name").catch(e => { if (contractInterfaceError(e)) return null; throw e; }),
    ]);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || typeof supply !== "bigint" || supply < 0n || typeof balance !== "bigint" || balance < 0n || !safeSwapTokenText(symbol, 32)) throw new SwapDiscoveryError("TOKEN_METADATA_INVALID", "The contract's ERC-20 metadata could not be validated safely.", 422);
    const known = findKnownTradeToken(address);
    // Catalog identity is not liquidity/transfer safety. Conflicting metadata is not silently substituted.
    if (known && (known.decimals !== decimals || known.symbol !== symbol)) throw new SwapDiscoveryError("TOKEN_IDENTITY_MISMATCH", "On-chain metadata conflicts with this known Base token identity. Nothing was imported.", 422);
    return { address, decimals, symbol, name: safeSwapTokenText(name, 128) ? name : symbol, kind: known?.kind ?? "erc20", verified: known !== null };
  } catch (e) {
    if (e instanceof SwapDiscoveryError) throw e;
    if (contractInterfaceError(e)) throw new SwapDiscoveryError("TOKEN_NOT_ERC20", "The Base contract does not expose readable ERC-20 metadata. It was not imported.", 422);
    throw new SwapDiscoveryError("TOKEN_PROVIDER_UNAVAILABLE", "Base token metadata is temporarily unavailable. Retry; no trading permission was granted.");
  }
}
export async function inspectSwapToken(client: SwapDiscoveryClient, input: unknown) {
  exactSwapAddress(input); // reject before any RPC
  const snapshot = await startSwapSnapshot(client);
  const token = await readSwapTokenMetadata(client, input, snapshot.blockNumber);
  await finishSwapSnapshot(client, snapshot);
  return { chainId: 8453 as const, token, snapshot: snapshotEvidence(snapshot), executionAuthorized: false as const };
}
