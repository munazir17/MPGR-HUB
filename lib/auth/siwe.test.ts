import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildSiweMessage,
  parseSiweMessage,
  siweSignatureVerifier,
  verifySiweSignature,
  type AuthMessage,
} from "./siwe";

const address = "0x0000000000000000000000000000000000000001" as `0x${string}`;

function validTimes() {
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return { issuedAt, expirationTime };
}

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

describe("verifySiweSignature", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function signedEoa(): Promise<{
    account: ReturnType<typeof privateKeyToAccount>;
    expected: AuthMessage;
    message: string;
    signature: `0x${string}`;
  }> {
    const account = privateKeyToAccount(generatePrivateKey());
    const times = validTimes();
    const expected: AuthMessage = {
      domain: "mpgrhub.xyz",
      address: account.address,
      uri: "https://mpgrhub.xyz",
      nonce: "test-nonce-value",
      chainId: 8453,
      ...times,
    };
    const message = buildSiweMessage(expected);
    const signature = await account.signMessage({ message });
    return { account, expected, message, signature };
  }

  it("accepts a valid EOA personal_sign over the canonical SIWE message", async () => {
    const { expected, message, signature } = await signedEoa();
    const contractSpy = vi.spyOn(siweSignatureVerifier, "contract");
    await expect(verifySiweSignature(message, signature, expected)).resolves.toBe(true);
    expect(contractSpy).not.toHaveBeenCalled();
  });

  it("rejects a signature from a different wallet", async () => {
    const { expected, message } = await signedEoa();
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = await other.signMessage({ message });
    vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(false);
    await expect(verifySiweSignature(message, signature, expected)).resolves.toBe(false);
  });

  it("falls back to ERC-1271 when ecrecover does not match the claimed smart-wallet address", async () => {
    const { expected, message, signature } = await signedEoa();
    const contractSpy = vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(true);
    vi.spyOn(siweSignatureVerifier, "eoa").mockResolvedValue(false);
    await expect(verifySiweSignature(message, signature, expected)).resolves.toBe(true);
    expect(contractSpy).toHaveBeenCalledTimes(1);
    expect(contractSpy.mock.calls[0]?.[0]).toBe(expected.address);
    expect(contractSpy.mock.calls[0]?.[1]).toBe(message);
  });

  it("does not treat an unverified smart-wallet signature as authenticated", async () => {
    const { expected, message, signature } = await signedEoa();
    vi.spyOn(siweSignatureVerifier, "eoa").mockResolvedValue(false);
    vi.spyOn(siweSignatureVerifier, "contract").mockResolvedValue(false);
    await expect(verifySiweSignature(message, signature, expected)).resolves.toBe(false);
  });
});
