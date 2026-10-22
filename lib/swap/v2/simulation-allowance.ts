// A quote has to show the receive amount before the wallet approves the executor.
// eth_call as the taker reverts on transferFrom until that approval exists, which
// hid every ERC-20 quote. This finds the standard allowance slot and overrides it
// for the simulation only. The signed transaction is unchanged, and the real
// approval still happens in the wallet.
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, type Address, type Hex, type StateOverride } from "viem";

const MAX = (1n << 256n) - 1n;
const MAX_HEX = `0x${MAX.toString(16)}` as Hex;
const SLOT_SCAN = 32;
const slots = new Map<string, number>();

export interface AllowanceClient {
  readContract(args: { address: Address; abi: typeof erc20Abi; functionName: "allowance"; args: readonly [Address, Address]; blockNumber: bigint }): Promise<unknown>;
  call(args: { to: Address; data: Hex; blockNumber: bigint; stateOverride?: StateOverride }): Promise<{ data?: Hex | null }>;
}

export function erc20AllowanceSlot(owner: Address, spender: Address, slot: number): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(slot)]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

function override(token: Address, slot: Hex): StateOverride {
  return [{ address: token, stateDiff: [{ slot, value: MAX_HEX }] }];
}

/** Current allowance, or null when the token does not answer. A null result
 * keeps the existing fail-closed simulation; it never invents an approval. */
export async function readErc20Allowance(client: Pick<AllowanceClient, "readContract">, token: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<bigint | null> {
  try {
    const value = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender], blockNumber });
    return typeof value === "bigint" ? value : null;
  } catch {
    return null;
  }
}

/** State override that makes `allowance(owner, spender)` report max uint256.
 * Undefined when the token does not use a standard mapping slot, or the RPC
 * refuses overrides. The caller's real allowance is not modified. */
export async function erc20AllowanceOverride(client: Pick<AllowanceClient, "call">, token: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<StateOverride | undefined> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  const key = token.toLowerCase();
  const cached = slots.get(key);
  const candidates = cached === undefined ? [...Array(SLOT_SCAN).keys()] : [cached, ...[...Array(SLOT_SCAN).keys()].filter((slot) => slot !== cached)];
  for (const slot of candidates) {
    try {
      const stateOverride = override(token, erc20AllowanceSlot(owner, spender, slot));
      const result = await client.call({ to: token, data, blockNumber, stateOverride });
      if (result.data && BigInt(result.data) === MAX) {
        slots.set(key, slot);
        return stateOverride;
      }
    } catch {
      return undefined;
    }
  }
  slots.delete(key);
  return undefined;
}
