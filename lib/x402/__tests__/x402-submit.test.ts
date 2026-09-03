import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { ConfirmedX402Proposal } from "../x402-proposal-store";

const { mockClaim, mockConsume } = vi.hoisted(() => ({
  mockClaim: vi.fn(),
  mockConsume: vi.fn(),
}));

vi.mock("../x402-proposal-store", () => ({
  claimConfirmedProposal: (...args: unknown[]) => mockClaim(...args),
  consumeConfirmedProposal: (...args: unknown[]) => mockConsume(...args),
  X402_PAID_GET_TIMEOUT_MS: 20_000,
  X402_PROCESSING_LEASE_SECONDS: 30,
}));

const {
  decodeXPaymentHeader,
  parseSubmitBody,
  verifyAgainstStoredRecord,
  submitBoundX402Payment,
} = await import("../x402-submit");
const { X402_SUPPORTED_NETWORK, X402_CHAIN_ID } = await import("../x402-config");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x2a835A505d4Ea32372Cc420d2663b885cE089453";
const RESOURCE = "https://x402.payai.network/api/base/paid-content";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function signAuthorization(opts?: {
  value?: string;
  to?: string;
  validAfter?: string;
  validBefore?: string;
  network?: string;
  eip712Name?: string;
  eip712Version?: string;
}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = {
    from: account.address,
    to: opts?.to ?? PAY_TO,
    value: opts?.value ?? "10000",
    validAfter: opts?.validAfter ?? "0",
    validBefore: opts?.validBefore ?? (now + 300n).toString(),
    nonce: ("0x" + "11".repeat(32)) as Hex,
  };
  const domain = {
    name: opts?.eip712Name ?? "USD Coin",
    version: opts?.eip712Version ?? "2",
    chainId: X402_CHAIN_ID,
    verifyingContract: getAddress(USDC),
  };
  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const payload = {
    x402Version: 2,
    scheme: "exact" as const,
    network: opts?.network ?? "eip155:8453",
    payload: { signature, authorization },
  };
  const xPayment = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  return { account, authorization, signature, xPayment, payload };
}

function storedRecord(
  overrides: Partial<ConfirmedX402Proposal> = {},
): ConfirmedX402Proposal {
  return {
    registrationId: "reg_test_abcdef",
    proposalId: "x402_abc",
    resource: RESOURCE,
    scheme: "exact",
    network: X402_SUPPORTED_NETWORK,
    x402Version: 2,
    wireNetwork: "eip155:8453",
    asset: USDC,
    maxAmountRequired: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    eip712Name: "USD Coin",
    eip712Version: "2",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    status: "processing",
    ...overrides,
  };
}

beforeEach(() => {
  mockClaim.mockReset();
  mockConsume.mockReset();
  vi.unstubAllGlobals();
});

describe("parseSubmitBody", () => {
  it("accepts a well-formed registration + xPayment", () => {
    const result = parseSubmitBody({
      registrationId: "reg_12345678",
      xPayment: "abc",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing or tiny registration ids and empty headers", () => {
    expect(parseSubmitBody(null).ok).toBe(false);
    expect(parseSubmitBody({ registrationId: "short", xPayment: "abc" }).ok).toBe(false);
    expect(parseSubmitBody({ registrationId: "reg_12345678", xPayment: "" }).ok).toBe(false);
  });
});

describe("decodeXPaymentHeader", () => {
  it("round-trips a valid exact/EVM payload", async () => {
    const signed = await signAuthorization();
    const decoded = decodeXPaymentHeader(signed.xPayment);
    expect(decoded).not.toBeNull();
    expect(decoded?.scheme).toBe("exact");
    expect(decoded?.network).toBe("eip155:8453");
    expect(decoded?.payload.authorization.value).toBe("10000");
    expect(decoded?.payload.signature).toBe(signed.signature);
  });

  it("returns null for garbage, non-exact schemes, and missing auth fields", () => {
    expect(decodeXPaymentHeader("")).toBeNull();
    expect(decodeXPaymentHeader("%%%")).toBeNull();
    expect(
      decodeXPaymentHeader(
        Buffer.from(JSON.stringify({ scheme: "upto", network: "eip155:8453", x402Version: 2, payload: {} })).toString(
          "base64",
        ),
      ),
    ).toBeNull();
  });
});

describe("verifyAgainstStoredRecord", () => {
  it("accepts a matching PayAI v2 payload (eip155:8453 signed, eip155:8453 stored)", async () => {
    const signed = await signAuthorization({ network: "eip155:8453" });
    const result = await verifyAgainstStoredRecord(
      storedRecord(),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(true);
  });

  it("ROOT CAUSE: accepts signed network 'base' against stored CAIP-2 eip155:8453", async () => {
    const signed = await signAuthorization({ network: "base" });
    const result = await verifyAgainstStoredRecord(
      storedRecord({ network: "eip155:8453" }),
      signed.authorization,
      signed.signature,
      "base",
    );
    expect(result.ok).toBe(true);
  });

  it("ROOT CAUSE: accepts signed CAIP-2 against a legacy stored alias 'base'", async () => {
    const signed = await signAuthorization({ network: "eip155:8453" });
    const result = await verifyAgainstStoredRecord(
      storedRecord({ network: "base" }),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(true);
  });

  it("REQUIREMENT_CHANGED when the signed network is a different chain", async () => {
    const signed = await signAuthorization({ network: "eip155:1" });
    const result = await verifyAgainstStoredRecord(
      storedRecord(),
      signed.authorization,
      signed.signature,
      "eip155:1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REQUIREMENT_CHANGED");
  });

  it("REQUIREMENT_CHANGED when payTo does not match the stored recipient", async () => {
    const signed = await signAuthorization({
      to: "0x1111111111111111111111111111111111111111",
    });
    const result = await verifyAgainstStoredRecord(
      storedRecord(),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REQUIREMENT_CHANGED");
  });

  it("REQUIREMENT_CHANGED when the signed amount does not match", async () => {
    const signed = await signAuthorization({ value: "1" });
    const result = await verifyAgainstStoredRecord(
      storedRecord(),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REQUIREMENT_CHANGED");
  });

  it("REQUIREMENT_CHANGED when the EIP-712 domain does not match what was signed", async () => {
    const signed = await signAuthorization({ eip712Name: "Not USDC" });
    const result = await verifyAgainstStoredRecord(
      storedRecord(),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REQUIREMENT_CHANGED");
  });

  it("INVALID_INPUT when the authorization has already expired", async () => {
    const signed = await signAuthorization({
      validAfter: "0",
      validBefore: "1",
    });
    const result = await verifyAgainstStoredRecord(
      storedRecord(),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("still matches payTo across mixed-case checksums", async () => {
    const signed = await signAuthorization({ to: PAY_TO.toLowerCase() });
    const result = await verifyAgainstStoredRecord(
      storedRecord({ payTo: PAY_TO }),
      signed.authorization,
      signed.signature,
      "eip155:8453",
    );
    expect(result.ok).toBe(true);
  });
});

describe("submitBoundX402Payment", () => {
  it("rejects an unusable xPayment before touching the store", async () => {
    const result = await submitBoundX402Payment({
      registrationId: "reg_12345678",
      xPayment: "not-valid-base64-json",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("maps a missing registration onto INVALID_INPUT", async () => {
    const signed = await signAuthorization();
    mockClaim.mockResolvedValueOnce({
      ok: false,
      code: "NOT_FOUND",
      message: "This payment registration was not found or has expired.",
    });
    const result = await submitBoundX402Payment({
      registrationId: "reg_missing_1",
      xPayment: signed.xPayment,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_INPUT");
  });

  it("settles a matching signed payment: claim → verify → PAYMENT-SIGNATURE GET → consume", async () => {
    const signed = await signAuthorization();
    const record = storedRecord();
    mockClaim.mockResolvedValueOnce({ ok: true, record, claimToken: "claim_token_1" });
    mockConsume.mockResolvedValueOnce({ ok: true, record: { ...record, status: "consumed" } });

    const settlement = Buffer.from(
      JSON.stringify({ success: true, transaction: "0xabc123" }),
      "utf-8",
    ).toString("base64");

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": settlement,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitBoundX402Payment({
      registrationId: record.registrationId,
      xPayment: signed.xPayment,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.paymentResponse).toBe(settlement);
    }
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledWith(record.registrationId, "claim_token_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("PAYMENT-SIGNATURE")).toBe(signed.xPayment);
    expect(headers.get("X-PAYMENT")).toBeNull();
  });

  it("v1 Coinbase resources still submit X-PAYMENT (not PAYMENT-SIGNATURE)", async () => {
    const signed = await signAuthorization({ network: "base" });
    const record = storedRecord({ x402Version: 1, wireNetwork: "base", network: "base" });
    mockClaim.mockResolvedValueOnce({ ok: true, record, claimToken: "claim_token_v1" });
    mockConsume.mockResolvedValueOnce({ ok: true, record: { ...record, status: "consumed" } });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitBoundX402Payment({
      registrationId: record.registrationId,
      xPayment: signed.xPayment,
    });
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-PAYMENT")).toBe(signed.xPayment);
    expect(headers.get("PAYMENT-SIGNATURE")).toBeNull();
  });

  it("does not report settled when consume fails after the upstream GET", async () => {
    const signed = await signAuthorization();
    const record = storedRecord();
    mockClaim.mockResolvedValueOnce({ ok: true, record, claimToken: "claim_token_2" });
    mockConsume.mockResolvedValueOnce({
      ok: false,
      code: "STALE_CLAIM",
      message: "This payment submission is no longer the active claimant.",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })),
    );

    const result = await submitBoundX402Payment({
      registrationId: record.registrationId,
      xPayment: signed.xPayment,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SUBMISSION_FAILED");
  });
});

