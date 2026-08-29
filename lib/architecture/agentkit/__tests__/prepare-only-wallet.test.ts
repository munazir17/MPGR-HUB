import { describe, expect, it } from "vitest";

import { PREPARE_ONLY_ERROR } from "../config";
import {
  createPrepareOnlyWallet,
  isPrepareOnlyError,
} from "../prepare-only-wallet";

describe("PrepareOnlyEvmWalletProvider", () => {
  it("identifies as Base mainnet 8453 without holding a private key", () => {
    const wallet = createPrepareOnlyWallet(
      "0x1111111111111111111111111111111111111111",
    );
    const network = wallet.getNetwork();

    expect(wallet.getName()).toBe("mpgr-prepare-only");
    expect(wallet.getAddress()).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(network.networkId).toBe("base-mainnet");
    expect(network.chainId).toBe("8453");
    expect(network.protocolFamily).toBe("evm");
    expect(JSON.stringify(wallet)).not.toMatch(/private/i);
  });

  it("throws the prepare-only error on every sign/send/transfer/signer path", async () => {
    const wallet = createPrepareOnlyWallet();
    const hash =
      "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

    await expect(wallet.nativeTransfer("0x1", "1")).rejects.toThrow(
      PREPARE_ONLY_ERROR,
    );
    await expect(wallet.sign(hash)).rejects.toThrow(PREPARE_ONLY_ERROR);
    await expect(wallet.signMessage("hi")).rejects.toThrow(PREPARE_ONLY_ERROR);
    await expect(wallet.signTypedData({ domain: {} })).rejects.toThrow(
      PREPARE_ONLY_ERROR,
    );
    await expect(wallet.signTransaction({ to: "0x1" })).rejects.toThrow(
      PREPARE_ONLY_ERROR,
    );
    await expect(wallet.sendTransaction({ to: "0x1" })).rejects.toThrow(
      PREPARE_ONLY_ERROR,
    );
    await expect(wallet.waitForTransactionReceipt(hash)).rejects.toThrow(
      PREPARE_ONLY_ERROR,
    );
    expect(() => wallet.toSigner()).toThrow(PREPARE_ONLY_ERROR);
  });

  it("recognizes the prepare-only error", async () => {
    const wallet = createPrepareOnlyWallet();
    try {
      await wallet.sendTransaction({ to: "0x1" });
    } catch (error) {
      expect(isPrepareOnlyError(error)).toBe(true);
    }
  });
});
