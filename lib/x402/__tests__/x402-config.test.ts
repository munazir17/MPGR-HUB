import { describe, expect, it } from "vitest";

import {
  X402_SUPPORTED_NETWORK,
  X402_WIRE_NETWORK_BASE_MAINNET,
  normalizeX402Network,
  toX402WireNetwork,
} from "../x402-config";

describe("toX402WireNetwork", () => {
  it("defaults modern / v2 payments to CAIP-2 eip155:8453 (PayAI, x402 v2 spec)", () => {
    expect(X402_SUPPORTED_NETWORK).toBe("eip155:8453");
    expect(toX402WireNetwork(X402_SUPPORTED_NETWORK)).toBe("eip155:8453");
    expect(toX402WireNetwork(X402_SUPPORTED_NETWORK, { x402Version: 2 })).toBe(
      "eip155:8453",
    );
  });

  it("echoes the resource's advertised network when it is a known Base Mainnet alias", () => {
    expect(
      toX402WireNetwork(X402_SUPPORTED_NETWORK, {
        x402Version: 2,
        originalNetwork: "eip155:8453",
      }),
    ).toBe("eip155:8453");
    expect(
      toX402WireNetwork(X402_SUPPORTED_NETWORK, {
        x402Version: 1,
        originalNetwork: "base",
      }),
    ).toBe("base");
    expect(
      toX402WireNetwork(X402_SUPPORTED_NETWORK, {
        x402Version: 1,
        originalNetwork: "base-mainnet",
      }),
    ).toBe("base-mainnet");
  });

  it("emits the v1 Coinbase alias 'base' only when x402Version is 1 and no original network was advertised", () => {
    expect(toX402WireNetwork(X402_SUPPORTED_NETWORK, { x402Version: 1 })).toBe(
      X402_WIRE_NETWORK_BASE_MAINNET,
    );
  });

  it("leaves anything else unchanged — it never invents a payable network", () => {
    expect(toX402WireNetwork("eip155:84532")).toBe("eip155:84532"); // Base Sepolia
    expect(toX402WireNetwork("eip155:1")).toBe("eip155:1"); // Ethereum mainnet
    expect(toX402WireNetwork("")).toBe("");
  });

  it("round-trips through normalizeX402Network back to the same canonical identifier", () => {
    const v2 = toX402WireNetwork(X402_SUPPORTED_NETWORK, { x402Version: 2 });
    expect(normalizeX402Network(v2)).toBe(X402_SUPPORTED_NETWORK);
    const v1 = toX402WireNetwork(X402_SUPPORTED_NETWORK, { x402Version: 1 });
    expect(normalizeX402Network(v1)).toBe(X402_SUPPORTED_NETWORK);
  });
});
