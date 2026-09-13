import { describe, expect, it } from "vitest";

import { revalidateTransferProposal } from "../transfer-confirmation";
import type { TransferProposal } from "../transfer-types";

const SENDER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function baseProposal(overrides: Partial<TransferProposal> = {}): TransferProposal {
  return {
    id: "transfer-1",
    kind: "native-transfer",
    network: "base",
    chainId: 8453,
    asset: { address: "0x0000000000000000000000000000000000dEaD" as `0x${string}`, symbol: "ETH", name: "Ether", decimals: 18, kind: "native", verified: true },
    amount: (10n ** 16n).toString(),
    sender: SENDER as `0x${string}`,
    recipient: { input: RECIPIENT, inputKind: "address", address: RECIPIENT as `0x${string}`, basename: null },
    senderBalance: (10n ** 18n).toString(),
    sufficientBalance: true,
    transaction: { to: RECIPIENT as `0x${string}`, data: "0x", value: (10n ** 16n).toString() },
    quotedAt: new Date().toISOString(),
    risk: [],
    warnings: [],
    displayAmount: "0.01 ETH",
    description: "Send 0.01 ETH on Base to 0x3333...3333.",
    requiresConfirmation: true,
    phase: "idle",
    ...overrides,
  };
}

describe("revalidateTransferProposal", () => {
  it("accepts a well-formed, sufficiently-funded proposal for the connected account", () => {
    const result = revalidateTransferProposal(baseProposal(), SENDER as `0x${string}`);
    expect(result.state).toBe("VALIDATED");
  });

  it("rejects a proposal not marked as requiring confirmation", () => {
    const result = revalidateTransferProposal(baseProposal({ requiresConfirmation: false as unknown as true }));
    expect(result.state).toBe("VALIDATION_FAILED");
  });

  it("rejects a non-Base network/chain", () => {
    const result = revalidateTransferProposal(baseProposal({ network: "ethereum" as unknown as "base" }));
    expect(result.state).toBe("VALIDATION_FAILED");
    expect(result.error?.code).toBe("UNSUPPORTED_NETWORK");
  });

  it("rejects when balance is insufficient", () => {
    const result = revalidateTransferProposal(baseProposal({ sufficientBalance: false }));
    expect(result.error?.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects a self-send even if it slipped through proposal building", () => {
    const result = revalidateTransferProposal(baseProposal({ recipient: { input: SENDER, inputKind: "address", address: SENDER as `0x${string}`, basename: null } }));
    expect(result.error?.code).toBe("INVALID_RECIPIENT");
  });

  it("rejects a zero/invalid amount", () => {
    const result = revalidateTransferProposal(baseProposal({ amount: "0" }));
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("rejects when the connected wallet does not match the proposal's sender", () => {
    const result = revalidateTransferProposal(baseProposal(), "0x9999999999999999999999999999999999999999" as `0x${string}`);
    expect(result.error?.code).toBe("WALLET_REQUIRED");
  });
});
