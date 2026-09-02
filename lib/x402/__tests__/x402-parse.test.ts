import { describe, expect, it } from "vitest";

import { parseX402PaymentRequired } from "../x402-parse";
import { X402_SUPPORTED_NETWORK } from "../x402-config";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid";

function validAccepts(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: X402_SUPPORTED_NETWORK,
        maxAmountRequired: "1000000",
        resource: RESOURCE,
        payTo: PAY_TO,
        asset: USDC,
        description: "Premium data",
        ...overrides,
      },
    ],
  };
}

describe("parseX402PaymentRequired", () => {
  it("1. parses a valid payment requirement", () => {
    const result = parseX402PaymentRequired(validAccepts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirements).toHaveLength(1);
      expect(result.requirements[0].requirement.asset.toLowerCase()).toBe(USDC.toLowerCase());
      expect(result.requirements[0].eip712Domain?.domain.name).toBe("USDC");
    }
  });

  it("2. rejects a malformed (non-object) body", () => {
    const result = parseX402PaymentRequired("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_RESPONSE");
  });

  it("3. rejects a body with no accepts array", () => {
    const result = parseX402PaymentRequired({ x402Version: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_RESPONSE");
  });

  it("4. rejects an unsupported network", () => {
    const result = parseX402PaymentRequired(validAccepts({ network: "eip155:1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
  });

  it("5. rejects an unsupported/unknown asset with no extra domain", () => {
    const result = parseX402PaymentRequired(
      validAccepts({ asset: "0x2222222222222222222222222222222222222222" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
  });

  it("5b. accepts an unknown asset when the requirement supplies its own EIP-712 domain via `extra`", () => {
    const result = parseX402PaymentRequired(
      validAccepts({
        asset: "0x2222222222222222222222222222222222222222",
        extra: { name: "Some Token", version: "1" },
      })
    );
    expect(result.ok).toBe(true);
  });

  it('11. accepts network "base" + canonical Base USDC and stores eip155:8453', () => {
    const result = parseX402PaymentRequired(validAccepts({ network: "base" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirements).toHaveLength(1);
      expect(result.requirements[0].requirement.network).toBe(X402_SUPPORTED_NETWORK);
      expect(result.requirements[0].requirement.network).toBe("eip155:8453");
      expect(result.requirements[0].requirement.asset.toLowerCase()).toBe(USDC.toLowerCase());
    }
  });

  it('12. accepts network "base-mainnet" and stores eip155:8453', () => {
    const result = parseX402PaymentRequired(validAccepts({ network: "base-mainnet" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirements[0].requirement.network).toBe(X402_SUPPORTED_NETWORK);
    }
  });

  it('13. accepts network "eip155:8453"', () => {
    const result = parseX402PaymentRequired(validAccepts({ network: "eip155:8453" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requirements[0].requirement.network).toBe(X402_SUPPORTED_NETWORK);
    }
  });

  it('14. rejects Base Sepolia alias "base-sepolia"', () => {
    const result = parseX402PaymentRequired(validAccepts({ network: "base-sepolia" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
  });

  it('15. rejects Base Sepolia CAIP-2 "eip155:84532"', () => {
    const result = parseX402PaymentRequired(validAccepts({ network: "eip155:84532" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
  });

  it("6. rejects an invalid (zero) amount", () => {
    const result = parseX402PaymentRequired(validAccepts({ maxAmountRequired: "0" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_ACCEPTABLE_REQUIREMENT");
  });

  it("7. rejects a non-integer amount string", () => {
    const result = parseX402PaymentRequired(validAccepts({ maxAmountRequired: "1.5" }));
    expect(result.ok).toBe(false);
  });

  it("8. rejects an invalid payTo address", () => {
    const result = parseX402PaymentRequired(validAccepts({ payTo: "not-an-address" }));
    expect(result.ok).toBe(false);
  });

  it("9. rejects an unsupported scheme", () => {
    const result = parseX402PaymentRequired(validAccepts({ scheme: "upto" }));
    expect(result.ok).toBe(false);
  });

  it("10. filters out only the bad option when multiple accepts are offered", () => {
    const body = {
      x402Version: 1,
      accepts: [
        { scheme: "exact", network: "eip155:1", maxAmountRequired: "1", resource: RESOURCE, payTo: PAY_TO, asset: USDC },
        {
          scheme: "exact",
          network: X402_SUPPORTED_NETWORK,
          maxAmountRequired: "1000000",
          resource: RESOURCE,
          payTo: PAY_TO,
          asset: USDC,
        },
      ],
    };
    const result = parseX402PaymentRequired(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requirements).toHaveLength(1);
  });
});
