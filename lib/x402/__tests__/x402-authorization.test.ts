import { describe, expect, it } from "vitest";
import { getAddress, isHex, type Address, type Hex } from "viem";

import { parseX402PaymentRequired } from "../x402-parse";
import { buildX402PaymentProposal } from "../x402-proposal";
import {
  buildAuthorizationTypedData,
  generateAuthorizationNonce,
} from "../x402-authorization";
import { X402_CHAIN_ID, X402_SUPPORTED_NETWORK } from "../x402-config";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x2a835A505d4Ea32372Cc420d2663b885cE089453";
const RESOURCE = "https://x402.payai.network/api/base/paid-content";
const PAYER = "0x2222222222222222222222222222222222222222" as Address;

function mustBuildProposal(overrides: Record<string, unknown> = {}) {
  const parsed = parseX402PaymentRequired({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: X402_SUPPORTED_NETWORK,
        amount: "10000",
        resource: RESOURCE,
        payTo: PAY_TO,
        asset: USDC,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
        ...overrides,
      },
    ],
  });
  if (!parsed.ok) throw new Error("bad test setup: parse");
  const proposal = buildX402PaymentProposal(RESOURCE, parsed.requirements[0]);
  if (!proposal.ok) throw new Error("bad test setup: proposal");
  return proposal.proposal;
}

describe("generateAuthorizationNonce", () => {
  it("returns a 32-byte hex nonce and does not repeat", () => {
    const a = generateAuthorizationNonce();
    const b = generateAuthorizationNonce();
    expect(isHex(a)).toBe(true);
    expect(a).toHaveLength(66);
    expect(a).not.toBe(b);
  });
});

describe("buildAuthorizationTypedData", () => {
  it("derives EIP-712 typed data only from the proposal's trusted fields", () => {
    const proposal = mustBuildProposal();
    const nonce = ("0x" + "ab".repeat(32)) as Hex;
    const typed = buildAuthorizationTypedData(proposal, {
      payerAddress: PAYER,
      chainId: X402_CHAIN_ID,
      validAfter: 0n,
      validForSeconds: 300,
      nonce,
    });

    expect(typed.primaryType).toBe("TransferWithAuthorization");
    expect(typed.types.TransferWithAuthorization.map((f) => f.name)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);
    expect(typed.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC,
    });
    expect(typed.message.from).toBe(PAYER);
    expect(typed.message.to).toBe(PAY_TO);
    expect(typed.message.value).toBe(10000n);
    expect(typed.message.validAfter).toBe(0n);
    expect(typed.message.nonce).toBe(nonce);
  });

  it("validBefore is now + the requirement timeout (never invented from description text)", () => {
    const proposal = mustBuildProposal({ maxTimeoutSeconds: 60 });
    const before = BigInt(Math.floor(Date.now() / 1000));
    const typed = buildAuthorizationTypedData(proposal, {
      payerAddress: PAYER,
      chainId: X402_CHAIN_ID,
      validAfter: 0n,
    });
    const after = BigInt(Math.floor(Date.now() / 1000));
    expect(typed.message.validBefore).toBeGreaterThanOrEqual(before + 60n);
    expect(typed.message.validBefore).toBeLessThanOrEqual(after + 60n);
    expect(getAddress(typed.message.to)).toBe(getAddress(PAY_TO));
  });

  it("throws when the proposal has no EIP-712 domain", () => {
    const proposal = mustBuildProposal();
    const broken = { ...proposal, eip712Domain: null as never };
    expect(() =>
      buildAuthorizationTypedData(broken, {
        payerAddress: PAYER,
        chainId: X402_CHAIN_ID,
      }),
    ).toThrow(/no EIP-712 domain/);
  });
});

