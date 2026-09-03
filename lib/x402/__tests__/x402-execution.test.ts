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

function mockRegisterThenSubmit(submitResponse: Response, registerOverrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/x402/register") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            registrationId: "reg_test_123",
            eip712Name: "USD Coin",
            eip712Version: "2",
            x402Version: 2,
            wireNetwork: "eip155:8453",
            ...registerOverrides,
          }),
          { status: 200 },
        ),
      );
    }
    if (url === "/api/x402/submit") {
      return Promise.resolve(submitResponse);
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
    mockRegisterThenSubmit(new Response("{}", { status: 200 }));
    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REJECTED");
    expect(result.error?.message).not.toMatch(/User rejected the request/);
  });
});

describe("executeX402Payment — submission & verification outcomes", () => {
  it("23. successful payment: signs once, submits via /api/x402/submit, verifies settlement", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    const fetchMock = mockRegisterThenSubmit(
      new Response(
        JSON.stringify({
          status: 200,
          paymentResponse: settlementHeader({ success: true, transaction: "0xabc", payer: ACCOUNT }),
        }),
        { status: 200 },
      ),
    );

    const transitions: string[] = [];
    const result = await executeX402Payment(baseInput(), (s) => transitions.push(s.state));

    expect(result.state).toBe("SETTLED");
    expect(result.settlement?.success).toBe(true);
    expect(mockSignTypedData).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transitions).toEqual(["AWAITING_SIGNATURE", "SIGNED", "SUBMITTING", "SETTLED"]);
  });

  it("24. rejected payment: resource returns 402 again", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    mockRegisterThenSubmit(
      new Response(JSON.stringify({ status: 402, paymentResponse: null }), { status: 200 }),
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("PAYMENT_REJECTED");
  });

  it("25. failed payment: 200 with settlement.success === false", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    mockRegisterThenSubmit(
      new Response(
        JSON.stringify({
          status: 200,
          paymentResponse: settlementHeader({ success: false, errorReason: "insufficient_funds" }),
        }),
        { status: 200 },
      ),
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("PAYMENT_FAILED");
  });

  it("26. verification failure: 200 with no settlement header", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    mockRegisterThenSubmit(
      new Response(JSON.stringify({ status: 200, paymentResponse: null }), { status: 200 }),
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("VERIFICATION_FAILED");
  });

  it("27. resource request failure: non-2xx, non-402 status", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    mockRegisterThenSubmit(
      new Response(JSON.stringify({ status: 500, paymentResponse: null }), { status: 200 }),
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SUBMISSION_FAILED");
  });

  it("28. network failure while submitting never leaks the raw fetch exception", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/x402/register") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              registrationId: "reg_test_123",
              eip712Name: "USD Coin",
              eip712Version: "2",
              x402Version: 2,
              wireNetwork: "eip155:8453",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error("getaddrinfo ENOTFOUND api.example.com"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SUBMISSION_FAILED");
    expect(result.error?.message).not.toMatch(/ENOTFOUND/);
  });
});

describe("executeX402Payment — idempotency / duplicate protection", () => {
  it("29. a second concurrent call for the same proposal is refused, not double-signed", async () => {
    mockSignTypedData.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(SIGNATURE), 20)));
    mockRegisterThenSubmit(
      new Response(
        JSON.stringify({
          status: 200,
          paymentResponse: settlementHeader({ success: true }),
        }),
        { status: 200 },
      ),
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

describe("executeX402Payment — wire payload (PayAI v2 / eip155:8453)", () => {
  it("31. outgoing payment uses x402Version 2, CAIP-2 eip155:8453, and an `accepted` object — never the v1 alias 'base'", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);

    const fetchMock = mockRegisterThenSubmit(
      new Response(
        JSON.stringify({
          status: 200,
          paymentResponse: settlementHeader({ success: true, transaction: "0xabc", payer: ACCOUNT }),
        }),
        { status: 200 },
      ),
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("SETTLED");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, registerInit] = fetchMock.mock.calls.find(([url]) => url === "/api/x402/register")!;
    const registerBody = JSON.parse((registerInit as RequestInit).body as string);
    expect(registerBody.requirement.network).toBe(X402_SUPPORTED_NETWORK);

    const [, submitInit] = fetchMock.mock.calls.find(([url]) => url === "/api/x402/submit")!;
    const submitBody = JSON.parse((submitInit as RequestInit).body as string);
    const decodedPayment = JSON.parse(Buffer.from(submitBody.xPayment, "base64").toString("utf-8"));
    expect(decodedPayment.x402Version).toBe(2);
    expect(decodedPayment.network).toBe("eip155:8453");
    expect(decodedPayment.network).not.toBe("base");
    expect(decodedPayment.accepted).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000000",
      asset: USDC,
      payTo: PAY_TO,
    });
    expect(decodedPayment.payload.signature).toBe(SIGNATURE);
  });

  it("31b. v1 Coinbase resources still emit network 'base' and omit `accepted`", async () => {
    mockSignTypedData.mockResolvedValueOnce(SIGNATURE);
    const fetchMock = mockRegisterThenSubmit(
      new Response(
        JSON.stringify({
          status: 200,
          paymentResponse: settlementHeader({ success: true, transaction: "0xabc", payer: ACCOUNT }),
        }),
        { status: 200 },
      ),
      { x402Version: 1, wireNetwork: "base", eip712Name: "USD Coin" },
    );

    const result = await executeX402Payment(baseInput(), () => {});
    expect(result.state).toBe("SETTLED");
    const [, submitInit] = fetchMock.mock.calls.find(([url]) => url === "/api/x402/submit")!;
    const submitBody = JSON.parse((submitInit as RequestInit).body as string);
    const decodedPayment = JSON.parse(Buffer.from(submitBody.xPayment, "base64").toString("utf-8"));
    expect(decodedPayment.x402Version).toBe(1);
    expect(decodedPayment.network).toBe("base");
    expect(decodedPayment.accepted).toBeUndefined();
  });

  it("32. Base Sepolia never reaches executeX402Payment in the first place — the chain gate already refuses it", async () => {
    const result = await executeX402Payment(baseInput({ currentChainId: 84532 }), () => {});
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("UNSUPPORTED_NETWORK");
    expect(mockSignTypedData).not.toHaveBeenCalled();
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
