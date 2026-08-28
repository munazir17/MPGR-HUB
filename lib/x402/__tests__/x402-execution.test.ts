import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

// Mock ONLY wagmi's signing primitive — nothing about parsing, proposal
// building, or verification classification is reimplemented here.
const { mockSignTypedData } = vi.hoisted(() => ({
  mockSignTypedData: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  signTypedData: (...args: unknown[]) => mockSignTypedData(...args),
}));

vi.mock("@/lib/wagmi", () => ({
  config: {},
}));

const { executeX402Payment, idleX402ExecutionSnapshot } = await import("../x402-execution");
const { parseX402PaymentRequired } = await import("../x402-parse");
const { buildX402PaymentProposal } = await import("../x402-proposal");
const { X402_SUPPORTED_NETWORK, X402_CHAIN_ID } = await import("../x402-config");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid";
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const SIGNATURE = ("0x" + "aa".repeat(65)) as `0x${string}`;

function mustBuildProposal() {
  const parsed = parseX402PaymentRequired({
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
  });
  if (!parsed.ok) throw new Error("bad test setup");
  const proposal = buildX402PaymentProposal(RESOURCE, parsed.requirements[0]);
  if (!proposal.ok) throw new Error("bad test setup");
  return proposal.proposal;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    proposal: mustBuildProposal(),
    confirmationState: "READY_FOR_CONFIRMATION" as const,
    currentAccount: ACCOUNT,
    currentChainId: X402_CHAIN_ID,
    ...overrides,
  };
}

function settlementHeader(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

beforeEach(() => {
  mockSignTypedData.mockReset();
  vi.unstubAllGlobals();
});

describe("executeX402Payment — gating (blocked, no signature requested)", () => {
  it("19. no wallet -> blocked", async () => {
    const result = await executeX402Payment(baseInput({ currentAccount: null }), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REQUIRED");
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  it("20. not READY_FOR_CONFIRMATION -> blocked (execution cannot be triggered without confirmation)", async () => {
    const result = await executeX402Payment(baseInput({ confirmationState: "VALIDATING" }), () => {});
    expect(result.state).toBe("ERROR");
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  it("21. wrong chain -> blocked", async () => {
    const result = await executeX402Payment(baseInput({ currentChainId: 1 }), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("UNSUPPORTED_NETWORK");
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });
});

describe("executeX402Payment — signing boundary", () => {
  it("22. wallet rejection during signing is classified, never a raw exception message", async () => {
    mockSignTypedData.mockRejectedValueOnce(new Error("User rejected the request"));
    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REJECTED");
    expect(result.error?.message).not.toMatch(/User rejected the request/);
  });
});

describe("executeX402Payment — submission & verification outcomes", () => {
  it("23. successful payment: signs once, submits X-PAYMENT, verifies settlement", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "X-PAYMENT-RESPONSE": settlementHeader({ success: true, transaction: "0xabc", payer: ACCOUNT }) },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const transitions: string[] = [];
    const result = await executeX402Payment(baseInput(), (s) => transitions.push(s.state));

    expect(result.state).toBe("SETTLED");
    expect(result.settlement?.success).toBe(true);
    expect(mockSignTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers["X-PAYMENT"]).toBeTruthy();
    expect(transitions).toEqual(["AWAITING_SIGNATURE", "SIGNED", "SUBMITTING", "SETTLED"]);
  });

  it("24. rejected payment: resource returns 402 again", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 402 })));

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("PAYMENT_REJECTED");
  });

  it("25. failed payment: 200 with settlement.success === false", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "X-PAYMENT-RESPONSE": settlementHeader({ success: false, errorReason: "insufficient_funds" }) },
        })
      )
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("PAYMENT_FAILED");
  });

  it("26. verification failure: 200 with no settlement header", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
  });

  it("27. resource request failure: non-2xx, non-402 status", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SUBMISSION_FAILED");
  });

  it("28. network failure while submitting never leaks the raw fetch exception", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.example.com")));

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SUBMISSION_FAILED");
    expect(result.error?.message).not.toMatch(/ENOTFOUND/);
  });
});

describe("executeX402Payment — idempotency / duplicate protection", () => {
  it("29. a second concurrent call for the same proposal is refused, not double-signed", async () => {
    mockSignTypedData.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(SIGNATURE), 20)));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", { status: 200, headers: { "X-PAYMENT-RESPONSE": settlementHeader({ success: true }) } })
      )
    );

    const proposal = mustBuildProposal();
    const input = { proposal, confirmationState: "READY_FOR_CONFIRMATION" as const, currentAccount: ACCOUNT, currentChainId: X402_CHAIN_ID };

    const [first, second] = await Promise.all([
      executeX402Payment(input, () => {}),
      executeX402Payment(input, () => {}),
    ]);

    const outcomes = [first.state, second.state].sort();
    expect(outcomes).toContain("ERROR");
    const errored = [first, second].find((r) => r.state === "ERROR");
    expect(errored?.error?.code).toBe("EXECUTION_IN_PROGRESS");
    expect(mockSignTypedData).toHaveBeenCalledTimes(1);
  });
});

describe("idleX402ExecutionSnapshot", () => {
  it("30. starts IDLE with no settlement/error", () => {
    const snapshot = idleX402ExecutionSnapshot();
    expect(snapshot.state).toBe("IDLE");
    expect(snapshot.settlement).toBeNull();
    expect(snapshot.error).toBeNull();
  });
});
