import { describe, expect, it } from "vitest";

import {
  X402_SUPPORTED_NETWORK,
  X402_WIRE_NETWORK_BASE_MAINNET,
  formatX402NetworkDisplay,
  normalizeX402Network,
  toX402WireNetwork,
  x402NetworksEquivalent,
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

describe("formatX402NetworkDisplay", () => {
  it("shows 'Base' for every Base Mainnet alias — never the CAIP-2 identifier", () => {
    expect(formatX402NetworkDisplay("eip155:8453")).toBe("Base");
    expect(formatX402NetworkDisplay("base")).toBe("Base");
    expect(formatX402NetworkDisplay("base-mainnet")).toBe("Base");
    expect(formatX402NetworkDisplay("BASE")).toBe("Base");
    expect(formatX402NetworkDisplay(X402_SUPPORTED_NETWORK)).toBe("Base");
  });

  it("does not rename unsupported networks", () => {
    expect(formatX402NetworkDisplay("eip155:84532")).toBe("eip155:84532");
    expect(formatX402NetworkDisplay("eip155:1")).toBe("eip155:1");
    expect(formatX402NetworkDisplay("")).toBe("Unknown");
    expect(formatX402NetworkDisplay(null)).toBe("Unknown");
  });
});

describe("x402NetworksEquivalent", () => {
  it("treats base / base-mainnet / eip155:8453 as the same network", () => {
    expect(x402NetworksEquivalent("base", "eip155:8453")).toBe(true);
    expect(x402NetworksEquivalent("eip155:8453", "base")).toBe(true);
    expect(x402NetworksEquivalent("base-mainnet", "base")).toBe(true);
    expect(x402NetworksEquivalent("BASE", "eip155:8453")).toBe(true);
  });

  it("rejects a different chain even when it looks similar", () => {
    expect(x402NetworksEquivalent("eip155:8453", "eip155:84532")).toBe(false);
    expect(x402NetworksEquivalent("base", "base-sepolia")).toBe(false);
    expect(x402NetworksEquivalent("eip155:8453", "eip155:1")).toBe(false);
    expect(x402NetworksEquivalent("", "eip155:8453")).toBe(false);
  });
});
