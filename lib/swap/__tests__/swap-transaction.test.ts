import { expect, it } from "vitest";
import { concatHex, encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { Attribution } from "ox/erc8021";
import { swapTransactionMatches } from "../swap-transaction";
import { ENTRYPOINT_V06 } from "../swap-mined-call";
const owner = "0x1111111111111111111111111111111111111111" as Address;
const target = "0x2222222222222222222222222222222222222222" as Address;
const bundler = "0x3333333333333333333333333333333333333333" as Address;
const hash = `0x${"aa".repeat(32)}` as Hash;
const p = { taker: owner, transaction: { to: target, data: "0xabcdef" as Hex, value: "123" } };
const receipt = { transactionHash: hash, from: owner, to: target, blockHash: hash, blockNumber: 100n };
const tx = { hash, from: owner, to: target, input: "0xabcdef" as Hex, value: 123n, blockHash: hash, blockNumber: 100n };
const appSuffix = Attribution.toDataSuffix({ codes: ["bc_6w84mi9m"] });
const walletSuffix = Attribution.toDataSuffix({ codes: ["bc_6w84mi9m", "bc_mnip"] });
const EXECUTE_BATCH = { type: "function", name: "executeBatch", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], outputs: [] } as const;
const HANDLE_OPS = { type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ name: "ops", type: "tuple[]", components: [{ name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" }, { name: "callData", type: "bytes" }, { name: "callGasLimit", type: "uint256" }, { name: "verificationGasLimit", type: "uint256" }, { name: "preVerificationGas", type: "uint256" }, { name: "maxFeePerGas", type: "uint256" }, { name: "maxPriorityFeePerGas", type: "uint256" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }] }, { name: "beneficiary", type: "address" }], outputs: [] } as const;
function bundled(sender: Address, calls: { target: Address; value: bigint; data: Hex }[]) {
  const inner = calls.map((call) => ({ ...call, data: concatHex([call.data, appSuffix]) }));
  const callData = concatHex([encodeFunctionData({ abi: [EXECUTE_BATCH], functionName: "executeBatch", args: [inner] }), walletSuffix]);
  const input = encodeFunctionData({ abi: [HANDLE_OPS], functionName: "handleOps", args: [[{ sender, nonce: 1n, initCode: "0x", callData, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: "0x", signature: "0x" }], bundler] });
  const mined = { hash, from: bundler, to: ENTRYPOINT_V06, input, value: 0n, blockHash: hash, blockNumber: 100n };
  return { mined, receipt: { ...receipt, from: bundler, to: ENTRYPOINT_V06 } };
}
it("matches the exact mined swap, not just an Executor event", () => expect(swapTransactionMatches(p, receipt, tx)).toBe(true));
it.each([{ hash: `0x${"bb".repeat(32)}` as Hash }, { from: target }, { to: owner }, { input: "0x00" as Hex }, { value: 124n }, { blockNumber: 99n }, { blockHash: null }, { blockNumber: null }])("rejects mismatching mined field case %#", change => expect(swapTransactionMatches(p, receipt, { ...tx, ...change })).toBe(false));
it("receipt from a different wallet is not proof", () => expect(swapTransactionMatches(p, { ...receipt, from: target }, tx)).toBe(false));
it("matches reviewed calldata with a builder-code suffix and rejects an extra byte before that suffix", () => {
  expect(swapTransactionMatches(p, receipt, { ...tx, input: concatHex([tx.input, appSuffix]) })).toBe(true);
  expect(swapTransactionMatches(p, receipt, { ...tx, input: concatHex([tx.input, appSuffix, walletSuffix]) })).toBe(true);
  expect(swapTransactionMatches(p, receipt, { ...tx, input: concatHex([tx.input, "0xaa", appSuffix]) })).toBe(false);
});
it("matches one smart-wallet executeBatch whose inner value and calldata are the reviewed swap", () => {
  const built = bundled(owner, [{ target, value: 123n, data: p.transaction.data }]);
  expect(swapTransactionMatches(p, built.receipt, built.mined)).toBe(true);
});
it("ignores another sender's user operation and does not treat it as this taker's swap", () => {
  const built = bundled(target, [{ target, value: 123n, data: p.transaction.data }]);
  expect(swapTransactionMatches(p, built.receipt, built.mined)).toBe(false);
});
it("rejects an executeBatch that does more than the single reviewed swap", () => {
  const built = bundled(owner, [{ target, value: 123n, data: p.transaction.data }, { target, value: 0n, data: "0x" }]);
  expect(swapTransactionMatches(p, built.receipt, built.mined)).toBe(false);
});
