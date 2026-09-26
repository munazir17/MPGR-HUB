import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getAIProvider } from "../ai-provider-registry";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import { runRegisteredTool } from "../tool-execution-service";
import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import { extractBaseSwapIntent, extractUnresolvedSwapOrder } from "@/lib/agent-intelligence";
import type { AIProviderRequest } from "../ai-provider";
import { createSingleFlight } from "@/lib/trade/trade-inflight";

function request(prompt: string): AIProviderRequest {
  return { prompt, address: "0x2222222222222222222222222222222222222222", agentContext: { isConnected: true } as AIProviderRequest["agentContext"], previousIntent: null, memoryContext: {} as AIProviderRequest["memoryContext"] };
}
const proposal = { id: "fixture", executionAvailable: true, requiresConfirmation: true };
beforeEach(() => {
  vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(toolSuccess("prepare_swap", { proposal }));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("direct trading intent", () => {
  it.each(["Swap 0.08 USDC to MPGR", "Swap.0.08 USDC for MPGR", "Buy MPGR with 0.08 USDC", "Swap 1 USDC to DEGEN", "Swap 1 USDC to 0x1234567890abcdef1234567890abcdef12345678", "Sell 2 WETH for USDC", "Swap 1 USDC to AAPLc"])("default provider immediately prepares without a model/help/capability loop: %s", async prompt => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network model should run"));
    const result = await getAIProvider().generateReply(request(prompt));
    expect(result.tradeProposal).toEqual(proposal);
    expect(agentToolRuntime.executeTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentToolRuntime.executeTool).mock.calls[0][0]).toMatch(/prepare/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.reply).not.toMatch(/Portfolio|capabilit|liquidityAvailable/);
  });
  it.each(["Trade WETH for USDC", "Buy AAPLc"])("asks for the missing size instead of inventing an amount: %s", async prompt => {
    const result = await getAIProvider().generateReply(request(prompt));
    expect(agentToolRuntime.executeTool).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/how much/i);
  });
  it("rejects the exact malformed address example without replacing missing digits", async () => {
    const example = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efeed";
    expect(example.length).toBe(41);
    expect(extractBaseSwapIntent(`Swap 1 USDC to ${example}`)).toBeNull();
    expect(extractUnresolvedSwapOrder(`Swap 1 USDC to ${example}`)?.buy).toBe(example);
  });
  it("preserves quoted full token names for discovery rather than guessing a ticker", () => {
    expect(extractUnresolvedSwapOrder('Swap 1 USDC to "Example Token"')?.buy).toBe("Example Token");
  });
  it("never lets a negative amount turn into a positive prepare", async () => {
    await new DeterministicAIProvider().generateReply(request("Swap -1 USDC to MPGR"));
    expect(agentToolRuntime.executeTool).not.toHaveBeenCalled();
  });
});

describe("read/prepare tool deduplication and signing boundary", () => {
  it("shares in-flight and repeated identical tool calls within a turn", async () => {
    const req = request("Swap 1 USDC to MPGR"); const args = { fromToken: "USDC", toToken: "MPGR", amount: "1" };
    const [a, b] = await Promise.all([runRegisteredTool("trade_prepare_swap", args, req), runRegisteredTool("trade_prepare_swap", args, req)]);
    const c = await runRegisteredTool("trade_prepare_swap", args, req);
    expect(a).toEqual(b); expect(b).toEqual(c); expect(agentToolRuntime.executeTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentToolRuntime.executeTool).mock.calls[0][2]).toMatchObject({ permissions: { canRead: true, canPrepare: true, canExecute: false } });
  });
  it("does not reuse a stale turn result or a changed amount", async () => {
    vi.useFakeTimers(); const req = request("Swap 1 USDC to MPGR"); const args = { fromToken: "USDC", toToken: "MPGR", amount: "1" };
    await runRegisteredTool("trade_prepare_swap", args, req);
    await runRegisteredTool("trade_prepare_swap", { ...args, amount: "2" }, req);
    vi.advanceTimersByTime(6001); await runRegisteredTool("trade_prepare_swap", args, req);
    expect(agentToolRuntime.executeTool).toHaveBeenCalledTimes(3);
  });
  it("never retains failed tools and never permits an execute tool", async () => {
    vi.mocked(agentToolRuntime.executeTool).mockResolvedValue(toolError("trade_prepare_swap", { code: "PROVIDER_ERROR", message: "Temporarily unavailable" }));
    const req = request("Swap 1 USDC to MPGR"); const args = { fromToken: "USDC", toToken: "MPGR", amount: "1" };
    await runRegisteredTool("trade_prepare_swap", args, req); await runRegisteredTool("trade_prepare_swap", args, req);
    expect(agentToolRuntime.executeTool).toHaveBeenCalledTimes(2);
    expect((await runRegisteredTool("trade_execute", args, req)).success).toBe(false);
    expect(agentToolRuntime.executeTool).toHaveBeenCalledTimes(2);
  });
  it("single-flight only deduplicates pending identical requests, not later/stale requests", async () => {
    const run = createSingleFlight<string>(); const compute = vi.fn(async () => "proposal");
    await Promise.all([run("wallet:order", compute), run("wallet:order", compute)]);
    expect(compute).toHaveBeenCalledTimes(1);
    await run("wallet:order", compute); expect(compute).toHaveBeenCalledTimes(2);
  });
});

it("deduplicates an in-flight tool even when its computation exceeds the reuse window", async () => {
  vi.useFakeTimers();
  let release!: (value: ReturnType<typeof toolSuccess>) => void;
  vi.mocked(agentToolRuntime.executeTool).mockReturnValue(new Promise(resolve => { release = resolve; }));
  const req = request("Swap 1 USDC to MPGR"); const args = { fromToken: "USDC", toToken: "MPGR", amount: "1" };
  const first = runRegisteredTool("trade_prepare_swap", args, req);
  vi.advanceTimersByTime(7000);
  const second = runRegisteredTool("trade_prepare_swap", args, req);
  expect(agentToolRuntime.executeTool).toHaveBeenCalledTimes(1);
  release(toolSuccess("trade_prepare_swap", { proposal }));
  expect(await first).toEqual(await second);
});
