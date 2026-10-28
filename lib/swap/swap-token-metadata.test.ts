import { expect, it } from "vitest";
import { stringToHex, zeroAddress } from "viem";
import { BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { inspectSwapToken } from "./swap-token-metadata";
import { discoveryFixture, IMPORTED } from "./swap-discovery-fixture";
import { safeSwapTokenText } from "./swap-token-text";
it("imports an arbitrary non-catalog Unicode ERC-20, all reads pinned, never authorizes", async () => {
  const f = discoveryFixture(); const result = await inspectSwapToken(f.reader, IMPORTED);
  expect(result).toMatchObject({ chainId: 8453, executionAuthorized: false, token: { symbol: "新🦄", decimals: 18, kind: "erc20", verified: false }, snapshot: { blockNumber: "123" } });
  expect(f.client.getBlock).toHaveBeenCalledTimes(2);
  for (const [args] of [...f.client.readContract.mock.calls, ...f.client.getCode.mock.calls]) expect(args.blockNumber).toBe(123n);
  expect(result).not.toHaveProperty("transaction");
});
it.each([null, "USDC", "0x123", zeroAddress])("rejects invalid address before RPC: %s", async input => { const f = discoveryFixture(); await expect(inspectSwapToken(f.reader, input)).rejects.toMatchObject({ code: "INVALID_ADDRESS" }); expect(f.client.getChainId).not.toHaveBeenCalled(); });
it("does not import the native sentinel as ERC-20", async () => { const f = discoveryFixture(); await expect(inspectSwapToken(f.reader, NATIVE_ETH_SENTINEL)).rejects.toMatchObject({ code: "NATIVE_NOT_ERC20" }); expect(f.client.getCode).not.toHaveBeenCalled(); });
it("verifies Base even when address is known", async () => { const f = discoveryFixture(); f.client.getChainId.mockResolvedValue(1); await expect(inspectSwapToken(f.reader, BASE_MAINNET_USDC)).rejects.toMatchObject({ code: "WRONG_RPC_CHAIN" }); expect(f.client.readContract).not.toHaveBeenCalled(); });
it("rejects EOA", async () => { const f = discoveryFixture(); f.client.getCode.mockResolvedValue("0x"); await expect(inspectSwapToken(f.reader, IMPORTED)).rejects.toMatchObject({ code: "TOKEN_NOT_CONTRACT", status: 422 }); });
it.each([0, 6, 8, 18, 255])("supports valid decimal range %s", async decimals => { const f = discoveryFixture(); f.client.readContract.mockImplementation(args => args.functionName === "decimals" ? Promise.resolve(decimals) : f.read(args)); expect((await inspectSwapToken(f.reader, IMPORTED)).token.decimals).toBe(decimals); });
it.each([-1, 256, 1.1, "18"]) ("rejects invalid decimals %s", async decimals => { const f = discoveryFixture(); f.client.readContract.mockImplementation(args => args.functionName === "decimals" ? Promise.resolve(decimals) : f.read(args)); await expect(inspectSwapToken(f.reader, IMPORTED)).rejects.toMatchObject({ code: "TOKEN_METADATA_INVALID" }); });
it.each(["", "X\u202eUSDC", "X\u200b", "X\n", "x".repeat(33)])("rejects unsafe/missing symbol %#", async symbol => { const f = discoveryFixture(); f.client.readContract.mockImplementation(args => args.functionName === "symbol" ? Promise.resolve(symbol) : f.read(args)); await expect(inspectSwapToken(f.reader, IMPORTED)).rejects.toMatchObject({ code: "TOKEN_METADATA_INVALID" }); });
it("supports legacy bytes32 metadata, only after decoding/revert error", async () => { const f = discoveryFixture(); f.client.readContract.mockImplementation(args => {
  if (args.functionName !== "symbol") return f.read(args);
  if (JSON.stringify(args.abi).includes('"type":"bytes32"')) return Promise.resolve(stringToHex("LEGACY", { size: 32 }));
  return Promise.reject({ name: "AbiDecodingDataSizeTooSmallError" });
}); expect((await inspectSwapToken(f.reader, IMPORTED)).token.symbol).toBe("LEGACY"); });
it("missing optional name falls back to symbol, not unsafe text", async () => { const f = discoveryFixture(); f.client.readContract.mockImplementation(args => args.functionName === "name" ? Promise.resolve("bad\u202ename") : f.read(args)); const { token } = await inspectSwapToken(f.reader, IMPORTED); expect(token.name).toBe(token.symbol); });
it("known identity conflicts fail rather than silently substituting decimals", async () => { const f = discoveryFixture(); f.client.readContract.mockImplementation(args => args.functionName === "decimals" ? Promise.resolve(18) : f.read(args)); await expect(inspectSwapToken(f.reader, BASE_MAINNET_USDC)).rejects.toMatchObject({ code: "TOKEN_IDENTITY_MISMATCH" }); });
it("network metadata failure is not invalid token or absent liquidity", async () => { const f = discoveryFixture(); f.client.readContract.mockRejectedValue(new Error("PRIVATE_RPC_KEY")); await expect(inspectSwapToken(f.reader, IMPORTED)).rejects.toMatchObject({ code: "TOKEN_PROVIDER_UNAVAILABLE", status: 503 }); });
it("unreadable ERC-20 interface is distinguished from network error", async () => { const f = discoveryFixture(); f.client.readContract.mockRejectedValue({ name: "ContractFunctionRevertedError" }); await expect(inspectSwapToken(f.reader, IMPORTED)).rejects.toMatchObject({ code: "TOKEN_NOT_ERC20", status: 422 }); });
// +120s, not +16s. fresh() allows 15s of future skew, and floor(now)+16 is only
// 15.0–16.0s ahead, so one delayed second on CI accepted the block.
it.each(["stale", "future", "reorg"]) ("rejects %s snapshot", async mode => { const f = discoveryFixture(); if (mode === "reorg") f.client.getBlock.mockResolvedValueOnce(f.block).mockResolvedValueOnce({ ...f.block, hash: `0x${"cd".repeat(32)}` }); else f.client.getBlock.mockResolvedValue({ ...f.block, timestamp: f.block.timestamp + (mode === "stale" ? -31n : 120n) }); await expect(inspectSwapToken(f.reader, IMPORTED)).rejects.toMatchObject({ code: mode === "reorg" ? "BLOCK_CHANGED" : "STALE_BLOCK" }); });
it("text validation permits Unicode, rejects invisible identities", () => { expect(safeSwapTokenText("🦄 トークン", 32)).toBe(true); expect(safeSwapTokenText("\u2066USDC", 32)).toBe(false); });
