import { describe, expect, it } from "vitest";
import { buildSiweMessage, parseSiweMessage } from "./siwe";
const address = "0x0000000000000000000000000000000000000001" as `0x${string}`;
describe("MPGR wallet authentication message", () => {
  it("round-trips the exact signed message shape", () => {
    const input = { domain: "example.com", address, uri: "https://example.com", nonce: "abc123", issuedAt: "2026-09-10T00:00:00.000Z", expirationTime: "2026-09-10T00:05:00.000Z", chainId: 8453 } as const;
    expect(parseSiweMessage(buildSiweMessage(input))).toEqual(input);
  });
  it("rejects another chain", () => {
    const message = buildSiweMessage({ domain: "example.com", address, uri: "https://example.com", nonce: "abc123", issuedAt: "2026-09-10T00:00:00.000Z", expirationTime: "2026-09-10T00:05:00.000Z", chainId: 1 });
    expect(parseSiweMessage(message)).toBeNull();
  });
});
