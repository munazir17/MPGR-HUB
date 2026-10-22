import { encodeFunctionResult, erc20Abi, type Address, type Hex, type StateOverride } from "viem";
import { expect, it } from "vitest";
import { erc20AllowanceOverride, erc20AllowanceSlot, readErc20Allowance } from "../simulation-allowance";

const TOKEN = "0x00000000000000000000000000000000000000a1" as Address;
const OWNER = "0x00000000000000000000000000000000000000b1" as Address;
const SPENDER = "0x00000000000000000000000000000000000000c1" as Address;
const BLOCK = 10n;
const MAX = (1n << 256n) - 1n;

it("reads a missing allowance as unknown instead of failing the quote", async () => {
  const client = { readContract: async () => { throw new Error("no allowance()"); } };
  expect(await readErc20Allowance(client, TOKEN, OWNER, SPENDER, BLOCK)).toBeNull();
});

it("finds a standard allowance slot and returns only that simulation override", async () => {
  const calls: StateOverride[] = [];
  const client = {
    async call(args: { stateOverride?: StateOverride }) {
      calls.push(args.stateOverride ?? []);
      const slot = args.stateOverride?.[0]?.stateDiff?.[0]?.slot;
      const hit = slot === erc20AllowanceSlot(OWNER, SPENDER, 1);
      return { data: encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: hit ? MAX : 0n }) };
    },
  };
  const found = await erc20AllowanceOverride(client, TOKEN, OWNER, SPENDER, BLOCK);
  expect(found?.[0]?.stateDiff?.[0]?.slot).toBe(erc20AllowanceSlot(OWNER, SPENDER, 1));
  expect(calls.length).toBe(2);
  const again = await erc20AllowanceOverride(client, TOKEN, OWNER, SPENDER, BLOCK);
  expect(again?.[0]?.stateDiff?.[0]?.slot).toBe(erc20AllowanceSlot(OWNER, SPENDER, 1));
});

it("gives up when the RPC refuses a state override", async () => {
  const client = { async call(): Promise<{ data: Hex }> { throw new Error("state override unsupported"); } };
  expect(await erc20AllowanceOverride(client, "0x00000000000000000000000000000000000000a2", OWNER, SPENDER, BLOCK)).toBeUndefined();
});
