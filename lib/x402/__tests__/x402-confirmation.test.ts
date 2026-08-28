import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { parseX402PaymentRequired } from "../x402-parse";
import { buildX402PaymentProposal, type X402PaymentProposal } from "../x402-proposal";
import { revalidateX402Proposal, runX402Confirmation } from "../x402-confirmation";
import { X402_SUPPORTED_NETWORK } from "../x402-config";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid";
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;

function mustBuildProposal(overrides: Record<string, unknown> = {}): X402PaymentProposal {
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
        ...overrides,
      },
    ],
  });
  if (!parsed.ok) throw new Error("bad test setup");
  const proposal = buildX402PaymentProposal(RESOURCE, parsed.requirements[0]);
  if (!proposal.ok) throw new Error("bad test setup");
  return proposal.proposal;
}

describe("x402 confirmation", () => {
  it("15. requires a wallet before validating", async () => {
    const transitions: string[] = [];
    const result = await runX402Confirmation(mustBuildProposal(), null, (s) => transitions.push(s.state));
    expect(result.state).toBe("WALLET_REQUIRED");
    expect(transitions).toEqual(["WALLET_REQUIRED"]);
  });

  it("16. reaches READY_FOR_CONFIRMATION for a valid proposal with a connected wallet", async () => {
    const transitions: string[] = [];
    const result = await runX402Confirmation(mustBuildProposal(), ACCOUNT, (s) => transitions.push(s.state));
    expect(result.state).toBe("READY_FOR_CONFIRMATION");
    expect(transitions).toEqual(["VALIDATING", "VALIDATED", "READY_FOR_CONFIRMATION"]);
  });

  it("17. revalidation fails a proposal whose requirement was mutated to an unsupported network", () => {
    const proposal = mustBuildProposal();
    const tampered: X402PaymentProposal = {
      ...proposal,
      requirement: { ...proposal.requirement, network: "eip155:1" },
    };
    const result = revalidateX402Proposal(tampered);
    expect(result.state).toBe("VALIDATION_FAILED");
    expect(result.error?.code).toBe("UNSUPPORTED_NETWORK");
  });

  it("18. revalidation fails a proposal with a zeroed-out amount", () => {
    const proposal = mustBuildProposal();
    const tampered: X402PaymentProposal = {
      ...proposal,
      requirement: { ...proposal.requirement, maxAmountRequired: "0" },
    };
    const result = revalidateX402Proposal(tampered);
    expect(result.state).toBe("VALIDATION_FAILED");
    expect(result.error?.code).toBe("INVALID_AMOUNT");
  });
});
