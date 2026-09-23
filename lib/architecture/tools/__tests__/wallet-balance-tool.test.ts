import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the wagmi action layer only — the tool's own contract (wallet from
// context, catalog-only tokens, on-chain decimals, never a guessed number)
// is what these tests pin.
vi.mock("wagmi/actions", () => ({
  getBalance: vi.fn(),
  readContracts: vi.fn(),
}));

import { getBalance, readContracts } from "wagmi/actions";

import { walletBalancesTool } from "../wallet-balance-tool-definitions";
import type { AgentToolContext } from "../agent-tool-context";

const WALLET = "0x00000000000000000000000000000000000000aa";

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    walletAddress: WALLET,
    chainId: 8453,
    requestId: "test-request",
    ...overrides,
  } as AgentToolContext;
}

const getBalanceMock = vi.mocked(getBalance);
const readContractsMock = vi.mocked(readContracts);

beforeEach(() => {
  getBalanceMock.mockReset();
  readContractsMock.mockReset();
  getBalanceMock.mockResolvedValue({
    value: 10_000_000_000_000_000n,
    decimals: 18,
    formatted: "0.01",
    symbol: "ETH",
  } as never);
});

describe("wallet_balances tool", () => {
  it("is a read-only, wallet-required tool", () => {
    expect(walletBalancesTool.mode).toBe("read");
    expect(walletBalancesTool.requiresWallet).toBe(true);
    expect(walletBalancesTool.requiresConfirmation).toBe(false);
    expect(walletBalancesTool.mode).not.toBe("execute");
    expect(walletBalancesTool.id).not.toMatch(/execute|submit|broadcast|sign/i);
  });

  it("refuses to run without a connected wallet", async () => {
    const result = await walletBalancesTool.execute({}, context({ walletAddress: undefined }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WALLET_NOT_CONNECTED");
    expect(readContractsMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown symbol instead of reading an invented contract", async () => {
    const result = await walletBalancesTool.execute({ symbol: "FAKECOIN" }, context());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(result.error?.message).toContain("FAKECOIN");
    expect(readContractsMock).not.toHaveBeenCalled();
  });

  it("reads every catalog token plus native ETH for the whole wallet", async () => {
    readContractsMock.mockResolvedValue(
      Array.from({ length: 80 }, (_, index) =>
        index % 2 === 0
          ? ({ status: "success", result: index === 0 ? 120_500_000n : 0n } as never)
          : ({ status: "success", result: 6 } as never),
      ),
    );

    const result = await walletBalancesTool.execute({}, context());
    expect(result.success).toBe(true);
    const data = result.data as {
      native: { human: string };
      assets: { symbol: string; human: string | null; nonzero: boolean }[];
    };
    expect(data.native.human).toBe("0.01");
    expect(data.assets.length).toBeGreaterThan(5);
    expect(data.assets.some((asset) => asset.symbol === "USDC")).toBe(true);
    expect(data.assets.some((asset) => asset.symbol === "cbADA")).toBe(true);
    // Every amount is either a real read or explicitly unreadable.
    for (const asset of data.assets) {
      expect(asset.human === null || typeof asset.human === "string").toBe(true);
    }
  });

  it("reads exactly one asset when a symbol is given", async () => {
    readContractsMock.mockResolvedValue([
      { status: "success", result: 2_000_000_000_000_000_000n } as never,
      { status: "success", result: 18 } as never,
    ]);

    const result = await walletBalancesTool.execute({ symbol: "MSTRc" }, context());
    expect(result.success).toBe(true);
    const data = result.data as { assets: { symbol: string; human: string }[] };
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0].symbol).toBe("MSTRc");
    expect(data.assets[0].human).toBe("2");
    // One token => exactly one balanceOf + one decimals call.
    const calls = readContractsMock.mock.calls[0][1] as unknown as { contracts: unknown[] };
    expect(calls.contracts).toHaveLength(2);
  });

  it("never guesses decimals — a failed read returns human:null", async () => {
    readContractsMock.mockResolvedValue([
      { status: "success", result: 500_000_000n } as never,
      { status: "failure", error: new Error("decimals reverted") } as never,
    ]);

    const result = await walletBalancesTool.execute({ symbol: "USDC" }, context());
    const data = result.data as { assets: { decimals: number | null; human: string | null }[] };
    expect(data.assets[0].decimals).toBeNull();
    expect(data.assets[0].human).toBeNull();
    expect(readContractsMock).toHaveBeenCalledTimes(1);
  });

  it("takes the wallet from the tool context, never from the input", async () => {
    readContractsMock.mockResolvedValue([
      { status: "success", result: 0n } as never,
      { status: "success", result: 6 } as never,
    ]);

    await walletBalancesTool.execute(
      { symbol: "USDC", address: "0x1111111111111111111111111111111111111111" },
      context(),
    );

    const calls = readContractsMock.mock.calls[0][1] as unknown as {
      contracts: { args?: readonly unknown[] }[];
    };
    expect(calls.contracts[0].args?.[0]).toBe(WALLET);
  });
});
