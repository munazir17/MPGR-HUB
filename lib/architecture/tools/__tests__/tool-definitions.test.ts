import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

// --- Mocks for every RPC/provider-facing dependency the five tools call ----
//
// wagmi/actions — used directly by wallet_analyzer (getBalance),
// token_analyzer (readContract, generic-ERC20 path), and base_research
// (getBytecode, getTransactionCount).
const mockGetBalance = vi.fn();
const mockGetBytecode = vi.fn();
const mockGetTransactionCount = vi.fn();
const mockReadContract = vi.fn();
vi.mock("wagmi/actions", () => ({
  getBalance: (...args: unknown[]) => mockGetBalance(...args),
  getBytecode: (...args: unknown[]) => mockGetBytecode(...args),
  getTransactionCount: (...args: unknown[]) => mockGetTransactionCount(...args),
  readContract: (...args: unknown[]) => mockReadContract(...args),
}));

// lib/token/token-client — MPGR-specific reads used by wallet_analyzer,
// portfolio_analyzer, and token_analyzer's MPGR branch.
const mockGetBalanceRaw = vi.fn();
vi.mock("@/lib/token/token-client", () => ({
  tokenClient: {
    getBalanceRaw: (...args: unknown[]) => mockGetBalanceRaw(...args),
    formatBalance: (raw: bigint) => (Number(raw) / 1e18).toString(),
  },
}));

// lib/token/token-service — MPGR metadata (token_analyzer's MPGR branch).
const mockGetMetadata = vi.fn();
vi.mock("@/lib/token/token-service", () => ({
  tokenService: { getMetadata: (...args: unknown[]) => mockGetMetadata(...args) },
}));

// lib/token/transaction-history-service — wallet_analyzer + base_research.
const mockGetHistory = vi.fn();
vi.mock("@/lib/token/transaction-history-service", () => ({
  transactionHistoryService: { getHistory: (...args: unknown[]) => mockGetHistory(...args) },
}));

// lib/staking/staking-service — portfolio_analyzer.
const mockGetWalletState = vi.fn();
vi.mock("@/lib/staking/staking-service", () => ({
  stakingService: { getWalletState: (...args: unknown[]) => mockGetWalletState(...args) },
}));

// lib/token-lock/token-lock-client — portfolio_analyzer.
const mockGetUserLockIds = vi.fn();
const mockGetLock = vi.fn();
vi.mock("@/lib/token-lock/token-lock-client", () => ({
  tokenLockClient: {
    getUserLockIds: (...args: unknown[]) => mockGetUserLockIds(...args),
    getLock: (...args: unknown[]) => mockGetLock(...args),
  },
}));

// lib/reward-vault/reward-vault-service — portfolio_analyzer.
const mockGetWalletRewards = vi.fn();
vi.mock("@/lib/reward-vault/reward-vault-service", () => ({
  rewardVaultService: { getWalletRewards: (...args: unknown[]) => mockGetWalletRewards(...args) },
}));

// Imported AFTER the mocks above so tool-definitions.ts picks up the
// mocked modules, matching vitest's hoisting requirements for vi.mock.
const {
  walletAnalyzerTool,
  tokenAnalyzerTool,
  portfolioAnalyzerTool,
  baseResearchTool,
  marketIntelligenceTool,
} = await import("../tool-definitions");

function makeDeps() {
  const eventBus: EventBus = { on: () => () => {}, off: () => {}, emit: () => {}, use: () => () => {} };
  const logger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };
  const performanceMonitor: PerformanceMonitor = {
    time: async (_l, fn) => fn(),
    timeSync: (_l, fn) => fn(),
    getMetrics: () => [],
    clear: () => {},
  };
  return { eventBus, logger, performanceMonitor };
}

function makeRuntime() {
  const registry = new AgentToolRegistry();
  for (const tool of [walletAnalyzerTool, tokenAnalyzerTool, portfolioAnalyzerTool, baseResearchTool, marketIntelligenceTool]) {
    registry.register(tool);
  }
  const { eventBus, logger, performanceMonitor } = makeDeps();
  return new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);
}

const VALID_ADDRESS = "0x000000000000000000000000000000000000dead";
const ALL_TOOLS = [walletAnalyzerTool, tokenAnalyzerTool, portfolioAnalyzerTool, baseResearchTool, marketIntelligenceTool];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("P0.2 tool registration", () => {
  it("all five are registered as read-mode, low-risk, no-confirmation tools", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.mode).toBe("read");
      expect(tool.riskLevel).toBe("low");
      expect(tool.requiresConfirmation).toBe(false);
    }
  });

  it("registers into a fresh registry without a duplicate-id collision", () => {
    const registry = new AgentToolRegistry();
    expect(() => ALL_TOOLS.forEach((t) => registry.register(t))).not.toThrow();
    expect(registry.list().length).toBe(5);
  });

  it("none of the five import or reference a write-capable action", () => {
    // Static check on the source itself: writeContract/simulateContract/
    // sendTransaction must never appear in this file — the P0.2 spec
    // forbids any write path, and this catches a future edit that
    // accidentally reaches for one just as reliably as a runtime test
    // would, without needing a live signer to prove it.
    const source = readFileSync(join(__dirname, "../tool-definitions.ts"), "utf-8");
    expect(source).not.toMatch(/writeContract|simulateContract|sendTransaction/);
  });
});

describe("wallet_analyzer", () => {
  it("rejects an invalid address before touching any provider", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("wallet_analyzer", { address: "not-an-address" }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ADDRESS");
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it("rejects a non-Base chainId", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "wallet_analyzer",
      { address: VALID_ADDRESS, chainId: 1 },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CHAIN_UNSUPPORTED");
  });

  it("returns ok:false on an RPC failure rather than a fabricated balance", async () => {
    mockGetBalance.mockRejectedValue(new Error("RPC timeout"));
    const runtime = makeRuntime();
    const result = await runtime.executeTool("wallet_analyzer", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.data).toBeUndefined();
  });

  it("returns native + MPGR balances and history on success, capped to the history service's own result", async () => {
    mockGetBalance.mockResolvedValue({ value: 1_000_000_000_000_000_000n, formatted: "1", symbol: "ETH", decimals: 18 });
    mockGetBalanceRaw.mockResolvedValue(5_000_000_000_000_000_000n);
    mockGetHistory.mockResolvedValue([]);

    const runtime = makeRuntime();
    const result = await runtime.executeTool("wallet_analyzer", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });

    expect(result.success).toBe(true);
    expect(mockGetHistory).toHaveBeenCalledWith(VALID_ADDRESS, { limit: 20 });
    const data = result.data as { nativeBalance: { raw: string }; tokenBalances: { symbol: string }[] };
    expect(data.nativeBalance.raw).toBe("1000000000000000000");
    expect(data.tokenBalances[0].symbol).toBe("MPGR");
  });
});

describe("token_analyzer", () => {
  it("rejects an invalid address", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("token_analyzer", { address: "0xnope" }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ADDRESS");
  });

  it("does not invent totalSupply=0 as a real value on an MPGR metadata failure", async () => {
    mockGetMetadata.mockResolvedValue({ name: "MPGR", symbol: "MPGR", decimals: 18, address: VALID_ADDRESS, totalSupply: 0n });
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "token_analyzer",
      { address: "0xB2000000000000000000008d204203177a78AF01" },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
  });

  it("reports DATA_UNAVAILABLE for a non-ERC20 address rather than an all-null success", async () => {
    mockReadContract.mockRejectedValue(new Error("execution reverted"));
    const runtime = makeRuntime();
    const result = await runtime.executeTool("token_analyzer", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
  });

  it("returns real ERC20 fields for a generic token and flags whether it's a known MPGR contract", async () => {
    mockReadContract
      .mockResolvedValueOnce("TEST") // symbol
      .mockResolvedValueOnce(18) // decimals
      .mockResolvedValueOnce("Test Token") // name
      .mockResolvedValueOnce(1_000_000n); // totalSupply

    const runtime = makeRuntime();
    const result = await runtime.executeTool("token_analyzer", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });

    expect(result.success).toBe(true);
    const data = result.data as { symbol: string; isMPGR: boolean; isKnownMpgrContract: boolean };
    expect(data.symbol).toBe("TEST");
    expect(data.isMPGR).toBe(false);
    expect(data.isKnownMpgrContract).toBe(false);
  });
});

describe("portfolio_analyzer", () => {
  it("rejects an invalid address before touching any provider", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "portfolio_analyzer",
      { address: "not-an-address" },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ADDRESS");
    expect(mockGetBalanceRaw).not.toHaveBeenCalled();
  });

  it("rejects a non-Base chainId", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "portfolio_analyzer",
      { address: VALID_ADDRESS, chainId: 8453 + 1 },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CHAIN_UNSUPPORTED");
  });

  it("fails the whole call when the core liquid MPGR read fails", async () => {
    mockGetBalanceRaw.mockRejectedValue(new Error("RPC down"));
    const runtime = makeRuntime();
    const result = await runtime.executeTool("portfolio_analyzer", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
  });

  it("maps staking/lock/reward fields from the existing sync services and marks a failing one unavailable, without failing the whole call", async () => {
    mockGetBalanceRaw.mockResolvedValue(1_000_000_000_000_000_000n);
    mockGetWalletState.mockResolvedValue({
      stakedBalance: 2_000_000_000_000_000_000n,
      earnedRewards: 100_000_000_000_000_000n,
      allowance: 0n,
      userRewardPerTokenPaid: 0n,
      accruedRewards: 0n,
    });
    mockGetUserLockIds.mockRejectedValue(new Error("RPC down")); // tokenLock unavailable
    mockGetWalletRewards.mockResolvedValue([]);

    const runtime = makeRuntime();
    const result = await runtime.executeTool("portfolio_analyzer", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });

    expect(result.success).toBe(true);
    const data = result.data as {
      liquidMPGR: { formatted: string };
      staking: { stakedFormatted: string } | null;
      tokenLock: unknown;
      unavailableFields: string[];
      xp: unknown;
      holderTier: unknown;
      season: unknown;
    };
    expect(data.liquidMPGR.formatted).toBe("1");
    expect(data.staking?.stakedFormatted).toBe("2");
    expect(data.tokenLock).toBeNull();
    expect(data.unavailableFields).toContain("tokenLock");
    // Node test environment — no `window` — so the localStorage-backed
    // fields must be explicitly unavailable, never a fabricated zero.
    expect(data.xp).toBeNull();
    expect(data.holderTier).toBeNull();
    expect(data.season).toBeNull();
    expect(data.unavailableFields).toEqual(expect.arrayContaining(["xp", "holderTier", "season"]));
  });
});

describe("base_research", () => {
  it("rejects an invalid address before touching any provider", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "base_research",
      { address: "not-an-address" },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ADDRESS");
    expect(mockGetBytecode).not.toHaveBeenCalled();
  });

  it("rejects a non-Base chainId", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "base_research",
      { address: VALID_ADDRESS, chainId: 137 },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CHAIN_UNSUPPORTED");
  });

  it("returns ok:false when eth_getCode fails", async () => {
    mockGetBytecode.mockRejectedValue(new Error("RPC down"));
    const runtime = makeRuntime();
    const result = await runtime.executeTool("base_research", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
  });

  it("reports isContract from real bytecode and matches a known MPGR contract address", async () => {
    mockGetBytecode.mockResolvedValue("0x6080");
    mockGetTransactionCount.mockResolvedValue(3);
    mockGetHistory.mockResolvedValue([]);

    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "base_research",
      { address: "0xB2000000000000000000008d204203177a78AF01" },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );

    expect(result.success).toBe(true);
    const data = result.data as { isContract: boolean; nonce: number; knownContractLabel: string | null };
    expect(data.isContract).toBe(true);
    expect(data.nonce).toBe(3);
    expect(data.knownContractLabel).toBe("MPGR Token");
  });

  it("reports isContract:false for an EOA (empty bytecode)", async () => {
    mockGetBytecode.mockResolvedValue(undefined);
    mockGetTransactionCount.mockResolvedValue(0);
    mockGetHistory.mockResolvedValue([]);

    const runtime = makeRuntime();
    const result = await runtime.executeTool("base_research", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(true);
    expect((result.data as { isContract: boolean }).isContract).toBe(false);
  });
});

describe("provider errors never leak internal exception details", () => {
  // agent-tool-result.ts's own contract: AgentToolError.message must
  // never be "a raw stack trace or internal exception message". For a
  // tool.execute() that *throws*, AgentToolRuntime's catch-all already
  // guarantees this (see agent-tool-runtime.test.ts). These P0.2 tools
  // additionally build AgentToolError values themselves, inside
  // execute() (via tool-helpers.ts's readOrProviderError, and
  // token_analyzer's MPGR-metadata catch block) — that path bypasses
  // the runtime's catch-all entirely, so it has to uphold the same
  // guarantee on its own. This asserts it actually does.
  const SECRET = "some internal secret RPC exception detail";

  it("wallet_analyzer: does not leak the underlying RPC exception message", async () => {
    mockGetBalance.mockRejectedValue(new Error(SECRET));
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "wallet_analyzer",
      { address: VALID_ADDRESS },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.error?.message).not.toContain(SECRET);
  });

  it("base_research: does not leak the underlying RPC exception message", async () => {
    mockGetBytecode.mockRejectedValue(new Error(SECRET));
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "base_research",
      { address: VALID_ADDRESS },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.error?.message).not.toContain(SECRET);
  });

  it("portfolio_analyzer: does not leak the underlying RPC exception message on the core liquid-MPGR read", async () => {
    mockGetBalanceRaw.mockRejectedValue(new Error(SECRET));
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "portfolio_analyzer",
      { address: VALID_ADDRESS },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.error?.message).not.toContain(SECRET);
  });

  it("token_analyzer: does not leak the underlying exception message on an MPGR metadata failure", async () => {
    mockGetMetadata.mockRejectedValue(new Error(SECRET));
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "token_analyzer",
      { address: "0xB2000000000000000000008d204203177a78AF01" },
      { requestId: "r1", confirmationMode: "always_confirm" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.error?.message).not.toContain(SECRET);
  });
});

describe("market_intelligence", () => {
  it("never invents a price — always reports DATA_UNAVAILABLE since no provider is wired", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("market_intelligence", { address: VALID_ADDRESS }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
    expect(result.data).toBeUndefined();
  });

  it("still validates address input before reporting unavailability", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("market_intelligence", { address: "bad" }, { requestId: "r1", confirmationMode: "always_confirm" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ADDRESS");
  });
});
