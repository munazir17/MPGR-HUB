import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { concatHex, encodeFunctionData, type Address } from "viem";
import { Attribution } from "ox/erc8021";
const m = vi.hoisted(() => ({ block: vi.fn(), tx: vi.fn(), read: vi.fn() }));
vi.mock("wagmi/actions", () => ({ getBlock: m.block, getTransaction: m.tx, readContract: m.read }));
vi.mock("@/lib/wagmi", () => ({ config: {} }));
import { readSwapAllowance, type ApprovalReceipt } from "../swap-allowance";
import { ENTRYPOINT_V06 } from "../swap-mined-call";
import { SWAP_PATH_EXECUTOR_DEPLOYMENT } from "../swap-executor-config";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d } from "@/lib/executor/executor-config";
import { erc20Abi } from "@/lib/erc20-abi";
import type { TradeProposal } from "@/lib/trade/trade-types";
const owner = "0x1111111111111111111111111111111111111111" as const;
const hash = `0x${"ab".repeat(32)}` as const;
const p = { chainId: 8453, taker: owner, from: { address: d.tokens[0].address, decimals: 6, symbol: "USDC", name: "USD Coin", kind: "erc20", verified: true }, fromAmount: "1000000", permit2Spender: d.executor, transaction: { to: d.executor, data: "0x", value: "0" } } satisfies Pick<TradeProposal, "chainId" | "taker" | "from" | "fromAmount" | "permit2Spender" | "transaction">;
const receipt: ApprovalReceipt = { status: "success", from: owner, to: p.from.address, transactionHash: hash, blockNumber: 100n, blockHash: hash };
const approval = () => ({ hash, from: owner as Address, to: p.from.address, value: 0n, input: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.executor, BigInt(p.fromAmount)] }) });
beforeEach(() => {
  vi.resetAllMocks(); m.block.mockResolvedValue({ number: 101n, hash }); m.tx.mockResolvedValue(approval());
  m.read.mockImplementation(async (_c, r) => r.blockNumber == null ? 0n : 1000000n);
});
afterEach(() => vi.useRealTimers());
it("does not mistake cached/pre-approval latest zero for insufficient allowance", async () => {
  expect(await readSwapAllowance(p, receipt)).toBe(1000000n);
  expect(m.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ blockNumber: 101n, address: p.from.address, args: [owner, d.executor] }));
});
it("waits boundedly for lagging RPC to reach receipt block", async () => {
  vi.useFakeTimers();
  m.block.mockImplementation(async (_c, r) => ({ number: r.blockNumber ?? (m.block.mock.calls.length < 4 ? 99n : 101n), hash }));
  const result = readSwapAllowance(p, receipt); await vi.runAllTimersAsync(); expect(await result).toBe(1000000n);
  expect(m.read).toHaveBeenCalledTimes(1);
});
it("RPC that never catches up is unknown, never insufficient and never event-inferred", async () => {
  vi.useFakeTimers(); m.block.mockImplementation(async (_c, r) => ({ number: r.blockNumber ?? 99n, hash }));
  const result = readSwapAllowance(p, receipt); await vi.runAllTimersAsync(); expect(await result).toBeNull(); expect(m.read).not.toHaveBeenCalled();
});
it.each([0n, 999999n])("a genuine pinned insufficient allowance %s is returned without fabricating permission", async amount => { m.read.mockResolvedValue(amount); expect(await readSwapAllowance(p, receipt)).toBe(amount); });
it.each([6, 8, 18])("approval amount is atomic, never rescaled using %s decimals", async decimals => {
  expect(await readSwapAllowance({ ...p, from: { ...p.from, decimals } }, receipt)).toBe(1000000n);
});
it.each(["spender", "amount", "token", "wallet", "value"])("wrong mined approval %s is not accepted", async field => {
  const tx = approval();
  if (field === "spender") tx.input = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [owner, 1000000n] });
  if (field === "amount") tx.input = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.executor, 999999n] });
  if (field === "token") tx.to = owner;
  if (field === "wallet") tx.from = d.executor;
  if (field === "value") tx.value = 1n;
  m.tx.mockResolvedValue(tx); expect(await readSwapAllowance(p, receipt)).toBeNull(); expect(m.read).not.toHaveBeenCalled();
});
it("reorged receipt is unknown", async () => { m.block.mockResolvedValue({ number: 101n, hash: `0x${"cd".repeat(32)}` }); expect(await readSwapAllowance(p, receipt)).toBeNull(); });
it("head changes during read is unknown", async () => { m.block.mockResolvedValueOnce({ number: 100n, hash }).mockResolvedValueOnce({ number: 101n, hash }).mockResolvedValueOnce({ number: 101n, hash: `0x${"cd".repeat(32)}` }); expect(await readSwapAllowance(p, receipt)).toBeNull(); });
it("failed/invalid RPC allowance is unknown", async () => { m.read.mockRejectedValue(new Error("RPC failure")); expect(await readSwapAllowance(p, receipt)).toBeNull(); });
it("already-approved proposals without a spender hint still read the actual Executor allowance", async () => { expect(await readSwapAllowance({ ...p, permit2Spender: null })).toBe(1000000n); });

// Swap-path proposals (deployed fixed-fee Swap executor): the spender is
// resolved from the transaction TARGET, never assumed to be the legacy
// Agent executor.
const swapExecutor = SWAP_PATH_EXECUTOR_DEPLOYMENT!.executor;
const pathP = { ...p, permit2Spender: swapExecutor, transaction: { to: swapExecutor, data: "0x", value: "0" } } satisfies Pick<TradeProposal, "chainId" | "taker" | "from" | "fromAmount" | "permit2Spender" | "transaction">;
const pathApproval = () => ({ hash, from: owner as Address, to: p.from.address, value: 0n, input: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [swapExecutor, BigInt(p.fromAmount)] }) });
it("path proposals read allowance for the Swap executor and accept only its mined approval", async () => {
  m.tx.mockResolvedValue(pathApproval());
  expect(await readSwapAllowance(pathP, receipt)).toBe(1000000n);
  expect(m.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ blockNumber: 101n, address: p.from.address, args: [owner, swapExecutor] }));
});
it("a mined approval to the legacy executor is not proof for a path proposal", async () => {
  expect(await readSwapAllowance(pathP, receipt)).toBeNull(); expect(m.read).not.toHaveBeenCalled();
});
it("a spender hint that disagrees with the transaction target is unknown, never guessed", async () => {
  m.tx.mockResolvedValue(pathApproval());
  expect(await readSwapAllowance({ ...pathP, permit2Spender: d.executor }, receipt)).toBeNull(); expect(m.read).not.toHaveBeenCalled();
});
it("path proposals without a spender hint still read the Swap executor allowance", async () => {
  expect(await readSwapAllowance({ ...pathP, permit2Spender: null })).toBe(1000000n);
  expect(m.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ args: [owner, swapExecutor] }));
});
it("approve calldata with a builder suffix still reads the allowance", async () => {
  const tx = approval();
  tx.input = concatHex([tx.input, Attribution.toDataSuffix({ codes: ["bc_6w84mi9m"] })]);
  m.tx.mockResolvedValue(tx);
  expect(await readSwapAllowance(p, receipt)).toBe(1000000n);
});
it("a suffixed approval of the wrong spender is still not an allowance", async () => {
  const tx = approval();
  tx.input = concatHex([encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [owner, 1000000n] }), Attribution.toDataSuffix({ codes: ["bc_6w84mi9m"] })]);
  m.tx.mockResolvedValue(tx);
  expect(await readSwapAllowance(p, receipt)).toBeNull();
  expect(m.read).not.toHaveBeenCalled();
});
it("a smart-wallet approve is the inner call, not the bundler transaction", async () => {
  const bundler = "0x3333333333333333333333333333333333333333" as Address;
  const inner = concatHex([approval().input, Attribution.toDataSuffix({ codes: ["bc_6w84mi9m"] })]);
  const executeBatch = { type: "function", name: "executeBatch", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], outputs: [] } as const;
  const handleOps = { type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ name: "ops", type: "tuple[]", components: [{ name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" }, { name: "callData", type: "bytes" }, { name: "callGasLimit", type: "uint256" }, { name: "verificationGasLimit", type: "uint256" }, { name: "preVerificationGas", type: "uint256" }, { name: "maxFeePerGas", type: "uint256" }, { name: "maxPriorityFeePerGas", type: "uint256" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }] }, { name: "beneficiary", type: "address" }], outputs: [] } as const;
  const callData = concatHex([encodeFunctionData({ abi: [executeBatch], functionName: "executeBatch", args: [[{ target: p.from.address, value: 0n, data: inner }]] }), Attribution.toDataSuffix({ codes: ["bc_6w84mi9m", "bc_mnip"] })]);
  const input = encodeFunctionData({ abi: [handleOps], functionName: "handleOps", args: [[{ sender: owner, nonce: 1n, initCode: "0x", callData, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: "0x", signature: "0x" }], bundler] });
  m.tx.mockResolvedValue({ hash, from: bundler, to: ENTRYPOINT_V06, value: 0n, input });
  const bundled: ApprovalReceipt = { ...receipt, from: bundler, to: ENTRYPOINT_V06 };
  expect(await readSwapAllowance(p, bundled)).toBe(1000000n);
});

