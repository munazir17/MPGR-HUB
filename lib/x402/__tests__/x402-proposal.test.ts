import { describe, expect, it } from "vitest";

import { parseX402PaymentRequired } from "../x402-parse";
import { buildX402PaymentProposal } from "../x402-proposal";
import { X402_SUPPORTED_NETWORK } from "../x402-config";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid";

function parsedRequirement(overrides: Record<string, unknown> = {}) {
  const parsed = parseX402PaymentRequired({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: X402_SUPPORTED_NETWORK,
        maxAmountRequired: "1500000",
        resource: RESOURCE,
        payTo: PAY_TO,
        asset: USDC,
        description: "Premium data",
        ...overrides,
      },
    ],
  });
  if (!parsed.ok) throw new Error("test setup failed to parse requirement");
  return parsed.requirements[0];
}

describe("buildX402PaymentProposal", () => {
  it("11. generates a proposal with correct display amount and phase", () => {
    const result = buildX402PaymentProposal(RESOURCE, parsedRequirement());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.displayAmount).toBe("1.5 USDC");
      expect(result.proposal.phase).toBe("idle");
      expect(result.proposal.requiresConfirmation).toBe(true);
      expect(result.proposal.postConfirmationSteps.length).toBeGreaterThan(0);
    }
  });

  it("12. is deterministic for the same requirement", () => {
    const a = buildX402PaymentProposal(RESOURCE, parsedRequirement());
    const b = buildX402PaymentProposal(RESOURCE, parsedRequirement());
    expect(a.ok && b.ok && a.proposal.id === b.proposal.id).toBe(true);
  });

  it("13. rejects when the resource URL does not match the requirement's own resource", () => {
    const result = buildX402PaymentProposal("https://other.example.com/paid", parsedRequirement());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("REQUIREMENT_CHANGED");
  });

  it("14. warns when maxTimeoutSeconds is present", () => {
    const result = buildX402PaymentProposal(RESOURCE, parsedRequirement({ maxTimeoutSeconds: 60 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.warnings.some((w) => w.includes("60 seconds"))).toBe(true);
    }
  });
});
