import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("../lib/swap/swap-route-selection", async original => ({ ...await original<typeof import("../lib/swap/swap-route-selection")>(), qualifyRegisteredSwapRoute: m.qualify }));
import { auditSwapRoutes } from "./audit-swap-routes";
import { selectRegisteredSwapRoute, type SwapRouteReadClient } from "../lib/swap/swap-route-selection";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d } from "../lib/executor/executor-config";
const read = vi.fn(), simulate = vi.fn(), block = vi.fn();
const client = { getChainId: async () => 8453, getBlockNumber: async () => 123n, getBlock: block, readContract: read, simulateContract: simulate } as unknown as SwapRouteReadClient;
beforeEach(() => {
  vi.resetAllMocks(); read.mockResolvedValue(true); simulate.mockResolvedValue({ result: 1000n });
  block.mockResolvedValue({ number: 123n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  m.qualify.mockImplementation(async (_client, from, to, blockNumber) => ({ ...selectRegisteredSwapRoute(from, to), pool: "0x7777777777777777777777777777777777777777", blockNumber,
    reader: { simulateContract: async () => ({ result: [1000n] }) } }));
});
it("RPC failure reports all 14 routes in both directions/two amounts and all 35 candidates as unverified", async () => {
  const broken = { ...client, getChainId: async () => { throw new Error("private diagnostics"); } };
  const result = await auditSwapRoutes(broken);
  expect(result.tokens).toHaveLength(50); expect(result.tokens.filter(t => !t.registered)).toHaveLength(35);
  expect(result.routes).toHaveLength(60); // 28 directions * 2 amounts + 2 native directions * 2 amounts
  expect(result.routes.every(r => r.qualification === "unavailable" && !r.executionEvidenceComplete)).toBe(true);
  expect(result.tokens.every(t => t.permission === "unknown")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private diagnostics"); expect(read).not.toHaveBeenCalled();
});
it("discovered pool inputs are annotations only, even when token permission reads return true", async () => {
  const result = await auditSwapRoutes(client, [{ asset: "MPGR", token: "0xB2000000000000000000008d204203177a78AF01", pool: `0x${"cd".repeat(32)}`, routeEvidence: "discovery only", source: "fixture" }]);
  expect(result.tokens.find(t => t.symbol === "MPGR")).toMatchObject({ registered: false, permission: "allowed", candidate: { routeEvidence: "discovery only" } });
  expect(result.routes.some(r => /8d204203177a78af01/i.test(r.from + r.to))).toBe(false);
  expect(result.routes.every(r => r.quote === "positive_net_input_quote_only" && r.executorSimulation === "not_run_no_public_taker_supplied")).toBe(true);
  expect(simulate).not.toHaveBeenCalled(); expect(result.liveSettlementVerified).toBe(false);
  expect(read.mock.calls.every(([args]) => args.blockNumber === 123n)).toBe(true);
});
it("optional public-taker simulations use exact 25bps net amounts and never claim fee payment", async () => {
  const result = await auditSwapRoutes(client, [], d.owner);
  expect(simulate).toHaveBeenCalledTimes(60);
  expect(simulate.mock.calls.every(([args]) => args.blockNumber === 123n && args.account === d.owner)).toBe(true);
  expect(result.routes.every(r => BigInt(r.fee) === BigInt(r.gross) * 25n / 10000n && BigInt(r.fee) + BigInt(r.net) === BigInt(r.gross))).toBe(true);
  expect(result.routes.every(r => r.executorSimulation === "eth_call_succeeded_no_receipt_or_fee_transfer_proof" && !r.executionEvidenceComplete)).toBe(true);
  expect(result.signatures).toBe(false); expect(result.broadcasts).toBe(false); expect(result.stateOverrides).toBe(false);
});
it("a reorganization invalidates collected evidence rather than publishing stale success", async () => {
  block.mockResolvedValueOnce({ number: 123n, hash: `0x${"ab".repeat(32)}` }).mockResolvedValue({ number: 123n, hash: `0x${"cd".repeat(32)}` });
  const result = await auditSwapRoutes(client); expect(result.failure).not.toBeNull();
  expect(result.tokens.every(t => t.permission === "unknown")).toBe(true); expect(result.routes.every(r => r.output === null && r.quote === "unavailable")).toBe(true);
});
it("never treats a failed Executor eth_call as successful execution", async () => {
  simulate.mockRejectedValue(new Error("Insufficient allowance")); const result = await auditSwapRoutes(client, [], d.owner);
  expect(result.routes.every(r => r.executorSimulation === "eth_call_failed_no_execution_claim" && !r.executionEvidenceComplete)).toBe(true);
});
it("invalid/zero public takers fail before any RPC", async () => {
  await expect(auditSwapRoutes(client, [], "0x0000000000000000000000000000000000000000")).rejects.toThrow("nonzero public Base address"); expect(read).not.toHaveBeenCalled();
});
