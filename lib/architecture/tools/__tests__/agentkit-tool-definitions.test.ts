import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import { getAgentToolRegistry } from "../agent-tool-registry-instance";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

const {
  agentkitWalletDetailsTool,
  agentkitDiscoverX402ServicesTool,
  agentkitOnchainPolicyTool,
} = await import("../agentkit-tool-definitions");

function makeDeps() {
  const eventBus: EventBus = {
    on: () => () => {},
    off: () => {},
    emit: () => {},
    use: () => () => {},
  };
  const logger: Logger = {
    debug: () => {},
    warn: () => {},
    error: () => {},
  };
  const performanceMonitor: PerformanceMonitor = {
    time: async (_label, fn) => fn(),
    timeSync: (_label, fn) => fn(),
    getMetrics: () => [],
    clear: () => {},
  };
  return { eventBus, logger, performanceMonitor };
}

function makeRuntime() {
  const registry = new AgentToolRegistry();
  for (const tool of [
    agentkitWalletDetailsTool,
    agentkitDiscoverX402ServicesTool,
    agentkitOnchainPolicyTool,
  ]) {
    registry.register(tool);
  }
  const { eventBus, logger, performanceMonitor } = makeDeps();
  return new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);
}

describe("AgentKit client tool shapes", () => {
  it("registers read-only AgentKit wrappers and never an execute-mode tool", () => {
    const registry = getAgentToolRegistry();
    expect(registry.get("agentkit_wallet_details")).toBeDefined();
    expect(registry.get("agentkit_discover_x402_services")).toBeDefined();
    expect(registry.get("agentkit_onchain_policy")).toBeDefined();

    for (const tool of [
      agentkitWalletDetailsTool,
      agentkitDiscoverX402ServicesTool,
      agentkitOnchainPolicyTool,
    ]) {
      expect(tool.mode).toBe("read");
      expect(tool.requiresConfirmation).toBe(false);
    }
  });

  it("does not import @coinbase/agentkit or CDP secrets in the client tool file", () => {
    const src = readFileSync(
      join(__dirname, "..", "agentkit-tool-definitions.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']@coinbase\/agentkit["']/);
    expect(src).not.toMatch(/require\(["']@coinbase\/agentkit["']\)/);
    expect(src).not.toContain("CDP_");
    expect(src).not.toContain("privateKey");
    expect(src).toContain("/api/agentkit/invoke");
  });
});

describe("AgentKit client tools via AgentToolRuntime", () => {
  it("agentkit_onchain_policy posts the canonical AgentKit action name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          actionName: "mpgr_onchain_policy",
          result: {
            networkId: "base-mainnet",
            signing: "user-wallet-only",
            autoPay: false,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = makeRuntime();

    const result = await runtime.executeTool("agentkit_onchain_policy", {}, {});

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as { body: string }).body),
    ) as { actionName: string };
    expect(body.actionName).toBe("mpgr_onchain_policy");
    vi.unstubAllGlobals();
  });

  it("surfaces a 403 write-action denial as PERMISSION_DENIED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "AgentKit is configured prepare-only on Base.",
            code: "ACTION_DENIED",
          }),
          { status: 403 },
        ),
      ),
    );
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "agentkit_wallet_details",
      {},
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    vi.unstubAllGlobals();
  });
});
