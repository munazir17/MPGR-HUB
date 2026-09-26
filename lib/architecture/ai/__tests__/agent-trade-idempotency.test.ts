import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAIService, type AgentAIServiceDeps } from "../agent-ai-service";
import { appendAssistantReply, appendUserMessage, type AgentState } from "@/lib/agent-engine";
import type { AgentContext } from "@/lib/agent-context";

const mocks = vi.hoisted(() => ({ reply: vi.fn(), saved: new Map<string, unknown>(), write: vi.fn() }));
vi.mock("../ai-provider-registry", () => ({ getAIProvider: () => ({ generateReply: mocks.reply }) }));
vi.mock("@/lib/agent-prompt-context", () => ({ buildAgentPromptContext: async () => ({ agent: {}, memory: {}, previousIntent: null }) }));
vi.mock("@/lib/architecture/memory/memory-keys", () => ({
  readMigratedMemory: async (_scope: string, address: string, fallback: unknown) => mocks.saved.get(address) ?? fallback,
  writeMemory: async (_scope: string, address: string, value: unknown) => { mocks.write(value); mocks.saved.set(address, value); },
}));
const ADDRESS = "0x2222222222222222222222222222222222222222";
const context = { isConnected: true } as AgentContext;
function service() {
  const deps = { performanceMonitor: { time: async (_name: string, fn: () => Promise<unknown>) => fn() }, eventBus: { emit: vi.fn() }, taskQueue: { enqueue: vi.fn() } } as unknown as AgentAIServiceDeps;
  return { instance: new AgentAIService(deps), deps };
}
beforeEach(() => {
  mocks.saved.clear(); vi.clearAllMocks();
  mocks.reply.mockResolvedValue({ intent: "general_help", reply: '{"liquidityAvailable":true}', tradeProposal: { id: "same-trade", requiresConfirmation: true, executionAvailable: true } });
});
describe("Agent request/proposal idempotency", () => {
  it("shares duplicate in-flight turns and persists/emits only one assistant reply", async () => {
    const { instance, deps } = service();
    const [a, b] = await Promise.all([instance.generateReply(ADDRESS, "Swap 1 USDC to MPGR", context), instance.generateReply(ADDRESS, "Swap 1 USDC to MPGR", context)]);
    expect(a).toEqual(b); expect(a.messages).toHaveLength(1);
    expect(mocks.reply).toHaveBeenCalledTimes(1); expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.eventBus.emit).mock.calls.filter(([type]) => type === "message_received")).toHaveLength(1);
  });
  it("only leaves one identical proposal actionable after duplicate sequential messages", async () => {
    await appendAssistantReply(ADDRESS, "Swap 1 USDC to MPGR", context);
    await appendUserMessage(ADDRESS, "Swap 1 USDC to MPGR");
    const state = await appendAssistantReply(ADDRESS, "Swap 1 USDC to MPGR", context);
    expect(state.messages.filter(m => m.tradeProposal)).toHaveLength(1);
    expect(state.messages.at(-1)?.tradeProposal?.id).toBe("same-trade");
    expect(mocks.reply).toHaveBeenCalledTimes(2); // fresh turn, never silently reuse a stale quote
  });
  it("never persists raw model JSON alongside a proposal", async () => {
    const state = await appendAssistantReply(ADDRESS, "Swap 1 USDC to MPGR", context);
    expect(state.messages[0].content).not.toContain("liquidityAvailable");
    expect((mocks.saved.get(ADDRESS) as AgentState).messages[0].content).toContain("confirm");
  });
  it("clears the in-flight guard after failure so explicit retry remains possible", async () => {
    mocks.reply.mockRejectedValueOnce(new Error("temporary failure"));
    const { instance } = service();
    await expect(instance.generateReply(ADDRESS, "Swap 1 USDC to MPGR", context)).rejects.toThrow("temporary failure");
    await expect(instance.generateReply(ADDRESS, "Swap 1 USDC to MPGR", context)).resolves.toMatchObject({ address: ADDRESS });
    expect(mocks.reply).toHaveBeenCalledTimes(2);
  });
});
