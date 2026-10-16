import { describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, parseAbi, type Log } from "viem";
import { readSwapFeeAudit } from "@/scripts/read-swap-fee-audit.mjs";
import { LIVE_PINS as p, LIVE_TRADES, historicalReceipt } from "@/lib/mcp/__tests__/base-mainnet-live-fixtures";
const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function reader({ missingTransfer = false, wrongChain = false, error = false } = {}) {
  return {
    getChainId: vi.fn(async () => wrongChain ? 1 : 8453), getBlockNumber: vi.fn(async () => 999n),
    getCode: vi.fn(async () => "0x6000"),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => { if (error) throw new Error("Simulated unavailable RPC"); return functionName === "feeRecipient" ? p.feeRecipient : functionName === "feeBps" ? 25 : false; }),
    getTransaction: vi.fn(async ({ hash }: { hash: string }) => ({ from: p.taker, to: p.executor, input: LIVE_TRADES.find(f => f.hash === hash)!.input })),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
      const f = LIVE_TRADES.find(f => f.hash === hash)!; const r = historicalReceipt(f);
      if (missingTransfer) return r;
      const transfer = { ...r.logs[0], address: f.sellToken, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: p.executor, to: p.feeRecipient } }), data: encodeAbiParameters(parseAbiParameters("uint256"), [f.fee]) } as Log;
      return { ...r, logs: [...r.logs, transfer] };
    }),
  };
}
describe("read-only audit distinguishes archived fixtures from fresh RPC and actual ERC20 transfers", () => {
  it("only claims historical collection with matching fee transfer as well as Executor event", async () => {
    const rpc = reader(); const result = await readSwapFeeAudit(rpc);
    expect(result.current).toMatchObject({ verified: true, feeRecipient: p.feeRecipient, feeBps: 25, blockNumber: "999" });
    expect(result.historical).toHaveLength(2); expect(result.historical.every(r => r.verified)).toBe(true); expect(result.liveTradesInitiated).toBe(false);
    expect(rpc.readContract.mock.calls.every(([args]) => "blockNumber" in args && args.blockNumber === 999n)).toBe(true);
  });
  it("an Executor event alone is insufficient for the independent historical transfer audit", async () => { const result = await readSwapFeeAudit(reader({ missingTransfer: true })); expect(result.historical.every(r => !r.verified)).toBe(true); });
  it("wrong chain refuses all contract and historical reads", async () => { const rpc = reader({ wrongChain: true }); const r = await readSwapFeeAudit(rpc); expect(r.current.verified).toBe(false); expect(rpc.readContract).not.toHaveBeenCalled(); expect(rpc.getTransaction).not.toHaveBeenCalled(); });
  it("unavailable RPC is unverified, never silently replaced by recorded recipient", async () => { const r = await readSwapFeeAudit(reader({ error: true })); expect(r.current).toMatchObject({ verified: false }); expect(r.current).not.toHaveProperty("feeRecipient"); });
});
