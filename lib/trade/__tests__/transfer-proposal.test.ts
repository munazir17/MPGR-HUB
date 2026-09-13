import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const getBalance = vi.fn();
const readContract = vi.fn();

vi.mock("../trade-public-client", () => ({
  getTradePublicClient: () => ({ getBalance, readContract }),
}));

const { buildTransferProposal } = await import("../transfer-proposal");
const { NATIVE_ETH_SENTINEL, BASE_USDC } = await import("../trade-config");

const SENDER = "0x2222222222222222222222222222222222222222" as const;
const RECIPIENT = "0x3333333333333333333333333333333333333333" as const;

const ethAsset = {
  address: NATIVE_ETH_SENTINEL,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  kind: "native" as const,
  verified: true,
};

const usdcAsset = {
  address: BASE_USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20" as const,
  verified: true,
};

function recipient(overrides: Partial<{ address: Address; inputKind: "address" | "basename"; basename: string | null }> = {}) {
  return {
    input: RECIPIENT,
    inputKind: "address" as const,
    address: RECIPIENT,
    basename: null,
    ...overrides,
  };
}

describe("buildTransferProposal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("builds a native ETH transfer with an empty-data transaction and the amount as value", async () => {
    getBalance.mockResolvedValueOnce(10n ** 18n); // 1 ETH
    const result = await buildTransferProposal({
      parsed: { asset: ethAsset, amount: (10n ** 16n).toString(), recipient: recipient() },
      sender: SENDER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.kind).toBe("native-transfer");
      expect(result.proposal.transaction.to).toBe(RECIPIENT);
      expect(result.proposal.transaction.data).toBe("0x");
      expect(result.proposal.transaction.value).toBe((10n ** 16n).toString());
      expect(result.proposal.sufficientBalance).toBe(true);
    }
    expect(readContract).not.toHaveBeenCalled();
  });

  it("builds an ERC-20 transfer with encoded calldata and zero value", async () => {
    readContract.mockResolvedValueOnce(50_000_000n); // 50 USDC
    const result = await buildTransferProposal({
      parsed: { asset: usdcAsset, amount: (10_000_000n).toString(), recipient: recipient() },
      sender: SENDER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.kind).toBe("erc20-transfer");
      expect(result.proposal.transaction.to.toLowerCase()).toBe(BASE_USDC.toLowerCase());
      expect(result.proposal.transaction.value).toBe("0");
      expect(result.proposal.transaction.data.startsWith("0xa9059cbb")).toBe(true); // transfer(address,uint256) selector
    }
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("flags insufficient balance as a critical risk fact rather than throwing", async () => {
    getBalance.mockResolvedValueOnce(1n); // far less than requested
    const result = await buildTransferProposal({
      parsed: { asset: ethAsset, amount: (10n ** 16n).toString(), recipient: recipient() },
      sender: SENDER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.sufficientBalance).toBe(false);
      expect(result.proposal.risk.some((f) => f.id === "insufficient-balance")).toBe(true);
    }
  });

  it("refuses a transfer to the sender's own connected wallet", async () => {
    getBalance.mockResolvedValueOnce(10n ** 18n);
    const result = await buildTransferProposal({
      parsed: { asset: ethAsset, amount: (10n ** 16n).toString(), recipient: recipient({ address: SENDER }) },
      sender: SENDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_RECIPIENT");
  });

  it("rejects a non-positive amount", async () => {
    const result = await buildTransferProposal({
      parsed: { asset: ethAsset, amount: "0", recipient: recipient() },
      sender: SENDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("requires a valid connected wallet as sender", async () => {
    const result = await buildTransferProposal({
      parsed: { asset: ethAsset, amount: "1", recipient: recipient() },
      sender: "not-an-address" as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("WALLET_REQUIRED");
  });

  it("surfaces a provider error instead of a fabricated balance when the RPC read fails", async () => {
    getBalance.mockRejectedValueOnce(new Error("rpc down"));
    const result = await buildTransferProposal({
      parsed: { asset: ethAsset, amount: "1", recipient: recipient() },
      sender: SENDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_ERROR");
  });

  it("marks an unverified/raw-address asset with a critical risk fact", async () => {
    getBalance.mockResolvedValueOnce(10n ** 18n);
    const result = await buildTransferProposal({
      parsed: {
        asset: { ...ethAsset, verified: false },
        amount: (10n ** 16n).toString(),
        recipient: recipient(),
      },
      sender: SENDER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.risk.some((f) => f.id === "unverified-asset")).toBe(true);
  });
});
