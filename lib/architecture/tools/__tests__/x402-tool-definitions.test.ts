// lib/architecture/tools/__tests__/x402-tool-definitions.test.ts

import { describe, expect, it, vi } from "vitest";

import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import { getAgentToolRegistry } from "../agent-tool-registry-instance";
import type {
  EventBus,
  Logger,
  PerformanceMonitor,
} from "@/lib/architecture/core/types";

const {
  x402DiscoverResourceTool,
  x402PreparePaymentTool,
} = await import("../x402-tool-definitions");

const X402_SUPPORTED_NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid";

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

  return {
    eventBus,
    logger,
    performanceMonitor,
  };
}

function makeRuntime() {
  const registry = new AgentToolRegistry();

  for (const tool of [
    x402DiscoverResourceTool,
    x402PreparePaymentTool,
  ]) {
    registry.register(tool);
  }

  const {
    eventBus,
    logger,
    performanceMonitor,
  } = makeDeps();

  return new AgentToolRuntime(
    registry,
    eventBus,
    logger,
    performanceMonitor,
  );
}

/**
 * Mock a real x402 HTTP 402 response.
 *
 * IMPORTANT:
 * The HTTP status itself must be 402.
 * The JSON body must be the direct x402 payment-required
 * payload because the discovery layer passes response.json()
 * directly into parseX402PaymentRequired().
 */
function fetchReturning402() {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: X402_SUPPORTED_NETWORK,
            maxAmountRequired: "1000000",
            resource: RESOURCE,
            payTo: PAY_TO,
            asset: USDC,
          },
        ],
      }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  );
}

/**
 * Mock a normal non-payment resource response.
 */
function fetchReturningOk() {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        message: "ok",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  );
}

describe("x402 tool shapes", () => {
  it("31. x402_discover_resource is a read-mode payment tool", () => {
    expect(x402DiscoverResourceTool.mode).toBe("read");
    expect(x402DiscoverResourceTool.category).toBe("payment");
  });

  it("32. x402_prepare_payment is a prepare-mode payment tool that requires confirmation", () => {
    expect(x402PreparePaymentTool.mode).toBe("prepare");
    expect(x402PreparePaymentTool.category).toBe("payment");
    expect(x402PreparePaymentTool.requiresConfirmation).toBe(true);
  });

  it('33. no x402 tool has mode "execute" — payment signing/submission is structurally unreachable via tool-calling', () => {
    for (const tool of [
      x402DiscoverResourceTool,
      x402PreparePaymentTool,
    ]) {
      expect(tool.mode).not.toBe("execute");
    }
  });

  it("34. the side-effect import registers both tools into the real production registry singleton", () => {
    const registry = getAgentToolRegistry();

    expect(
      registry.get("x402_discover_resource"),
    ).toBeDefined();

    expect(
      registry.get("x402_prepare_payment"),
    ).toBeDefined();
  });
});

describe("x402 tools via AgentToolRuntime", () => {
  it("35. x402_discover_resource runs through the runtime and reports a payment requirement", async () => {
    vi.stubGlobal("fetch", fetchReturning402());

    try {
      const runtime = makeRuntime();

      const result = await runtime.executeTool(
        "x402_discover_resource",
        {
          resourceUrl: RESOURCE,
        },
        {},
      );

      expect(result.success).toBe(true);

      expect(
        (result.data as {
          paymentRequired: boolean;
        }).paymentRequired,
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("36. x402_discover_resource reports paymentRequired: false for a non-402 resource", async () => {
    vi.stubGlobal("fetch", fetchReturningOk());

    try {
      const runtime = makeRuntime();

      const result = await runtime.executeTool(
        "x402_discover_resource",
        {
          resourceUrl: RESOURCE,
        },
        {},
      );

      expect(result.success).toBe(true);

      expect(
        (result.data as {
          paymentRequired: boolean;
        }).paymentRequired,
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("37. x402_prepare_payment returns a structured proposal, never a signature or submission", async () => {
    vi.stubGlobal("fetch", fetchReturning402());

    try {
      const runtime = makeRuntime();

      const result = await runtime.executeTool(
        "x402_prepare_payment",
        {
          resourceUrl: RESOURCE,
        },
        {},
      );

      expect(result.success).toBe(true);

      const data = result.data as {
        proposal: {
          requiresConfirmation: boolean;
          phase: string;
          id: string;
        };
      };

      expect(
        data.proposal.requiresConfirmation,
      ).toBe(true);

      expect(
        data.proposal.phase,
      ).toBe("idle");

      expect(
        typeof data.proposal.id,
      ).toBe("string");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("38. x402_prepare_payment rejects a resource that isn't actually payment-required", async () => {
    vi.stubGlobal("fetch", fetchReturningOk());

    try {
      const runtime = makeRuntime();

      const result = await runtime.executeTool(
        "x402_prepare_payment",
        {
          resourceUrl: RESOURCE,
        },
        {},
      );

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("39. calling a hypothetical execute-mode x402 tool id fails at lookup — it was never registered", async () => {
    const runtime = makeRuntime();

    const result = await runtime.executeTool(
      "x402_execute_payment",
      {},
      {},
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("40. rejects an invalid resourceUrl before ever calling fetch", async () => {
    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    try {
      const runtime = makeRuntime();

      const result = await runtime.executeTool(
        "x402_discover_resource",
        {
          resourceUrl: "not-a-url",
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
