import { describe, expect, it } from "vitest";

import {
  X402_SUPPORTED_NETWORK,
  X402_WIRE_NETWORK_BASE_MAINNET,
  normalizeX402Network,
  toX402WireNetwork,
} from "../x402-config";

describe("toX402WireNetwork", () => {
  it("maps the canonical Base Mainnet identifier to the x402 wire alias 'base'", () => {
    expect(X402_SUPPORTED_NETWORK).toBe("eip155:8453");
    expect(toX402WireNetwork(X402_SUPPORTED_NETWORK)).toBe("base");
    expect(toX402WireNetwork(X402_SUPPORTED_NETWORK)).toBe(
      X402_WIRE_NETWORK_BASE_MAINNET,
    );
  });

  it("leaves anything else unchanged — it never invents a payable network", () => {
    expect(toX402WireNetwork("eip155:84532")).toBe("eip155:84532"); // Base Sepolia
    expect(toX402WireNetwork("eip155:1")).toBe("eip155:1"); // Ethereum mainnet
    expect(toX402WireNetwork("")).toBe("");
  });

  it("round-trips through normalizeX402Network back to the same canonical identifier", () => {
    // This is the exact property the fix depends on: the receiving
    // side (verifyAgainstStoredRecord in x402-submit.ts) already
    // treats "base" as an alias of eip155:8453, so emitting "base" on
    // the wire does not change what network is considered valid.
    const wire = toX402WireNetwork(X402_SUPPORTED_NETWORK);
    expect(normalizeX402Network(wire)).toBe(X402_SUPPORTED_NETWORK);
  });
});
