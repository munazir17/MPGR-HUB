import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import type { AgentToolResult } from "@/lib/architecture/tools/agent-tool-result";

import type { AIProviderRequest } from "../ai-provider";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import { runToolCallingLoop } from "../agent-tool-calling";

// Partial mock: the loop still needs the module's other exports.
vi.mock("../tool-execution-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tool-execution-service")>();
  return { ...actual, runRegisteredTool: vi.fn() };
});

import { runRegisteredTool } from "../tool-execution-service";

const runTool = vi.mocked(runRegisteredTool);

// ---------------------------------------------------------------------------
// Fixtures — live-shaped tool payloads (no hardcoded balances in the code
// under test; these are per-test inputs)
// ---------------------------------------------------------------------------

const WALLET = "0x00000000000000000000000000000000000000aa";

function balances(data: {
  eth?: string;
  assets?: { symbol: string; human: string | null; name?: string; nonzero?: boolean }[];
}): AgentToolResult {
  return toolSuccess("wallet_balances", {
    wallet: WALLET,
    chainId: 8453,
    asOf: "2026-01-01T00:00:00.000Z",
    native: {
      symbol: "ETH",
      decimals: 18,
      balanceRaw: "10000000000000000",
      human: data.eth ?? "0.01",
    },
    assets: (data.assets ?? []).map((asset) => ({
      symbol: asset.symbol,
      name: asset.name ?? asset.symbol,
      address: "0x" + asset.symbol.toLowerCase().padEnd(40, "0"),
      kind: "erc20",
      decimals: 18,
      balanceRaw: asset.human ? "1000000000000000000" : "0",
      human: asset.human,
      nonzero: asset.nonzero ?? Boolean(asset.human && Number(asset.human) > 0),
      verified: true,
    })),
    source: "Base RPC (balanceOf / eth_getBalance, session wallet)",
  });
}

function tape(): AgentToolResult {
  return toolSuccess("get_tape", {
    tape: {
      wrapped: [
        { symbol: "cbBTC", usd: 65000 },
        { symbol: "USDC", usd: 1 },
        { symbol: "cbADA", usd: null },
      ],
      stocks: [
        { symbol: "AAPLc", usdFeed: 280, usdDex: 281 },
        { symbol: "MSTRc", usdFeed: null, usdDex: null },
      ],
    },
  });
}

function makeRequest(prompt: string, overrides: Partial<AIProviderRequest> = {}): AIProviderRequest {
  return {
    prompt,
    agentContext: {
      isConnected: true,
      staking: { totalStaked: 50, earnedRewards: 2, currentAPRPercent: 8 },
      tokenLock: { totalLocked: 25, activeLocksCount: 1, upcomingUnlockAt: null },
      portfolio: { walletBalance: 100, stakedBalance: 50, lockedBalance: 25, totalHoldings: 175 },
      xp: { xp: 1200, level: 3, nextLevel: 4 },
      holderTier: { tierLabel: "Bronze" },
    } as unknown as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    } as unknown as AIProviderRequest["memoryContext"],
    address: WALLET,
    ...overrides,
  };
}

function answerFor(
  prompt: string,
  handlers: Record<string, () => AgentToolResult>,
): Promise<string> {
  runTool.mockImplementation(async (toolId: string) => {
    const handler = handlers[toolId];
    if (!handler) return toolError(toolId, { code: "TOOL_NOT_FOUND", message: "no handler" });
    return handler();
  });
  return new DeterministicAIProvider()
    .generateReply(makeRequest(prompt))
    .then((response) => response.reply);
}

beforeEach(() => {
  runTool.mockReset();
});

afterEach(() => {
  runTool.mockReset();
});

describe("strict single-token wallet balance", () => {
  it("answers only the requested token, with no portfolio/staking/XP noise", async () => {
    const reply = await answerFor("What is my MSTRc balance?", {
      wallet_balances: () => balances({ assets: [{ symbol: "MSTRc", human: "12.5" }] }),
    });

    expect(reply).toContain("MSTRc");
    expect(reply).toContain("12.5");
    expect(reply.toLowerCase()).toContain("wallet");
    // The whole point: nothing else is reported.
    for (const forbidden of [
      "staked",
      "locked",
      "XP",
      "Holder",
      "rewards",
      "Season",
      "referral",
      "Premium",
      "USDC",
      "ETH",
    ]) {
      expect(reply, forbidden).not.toContain(forbidden);
    }
    // Exactly one live read, for that one asset.
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0]).toBe("wallet_balances");
    expect(runTool.mock.calls[0][1]).toEqual({ symbol: "MSTRc" });
  });

  it("answers the single token for '<token> in my wallet', not a research card", async () => {
    // Reported in the app: "How much AAPLc in my wallet" returned the
    // tokenized-stock research card (oracle price / multiplier / DEX
    // liquidity) instead of this wallet's AAPLc balance.
    const reply = await answerFor("How much AAPLc in my wallet", {
      wallet_balances: () => balances({ assets: [{ symbol: "AAPLc", human: "0.0421" }] }),
    });

    expect(reply).toContain("AAPLc");
    expect(reply).toContain("0.0421");
    expect(reply.toLowerCase()).toContain("wallet");
    for (const forbidden of ["Oracle", "Multiplier", "liquidity", "staked", "locked", "XP"]) {
      expect(reply, forbidden).not.toContain(forbidden);
    }
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0]).toBe("wallet_balances");
    expect(runTool.mock.calls[0][1]).toEqual({ symbol: "AAPLc" });
  });

  it("answers ETH only for 'How much ETH do I have?'", async () => {
    const reply = await answerFor("How much ETH do I have?", {
      wallet_balances: () => balances({ eth: "0.25", assets: [{ symbol: "USDC", human: "120" }] }),
    });

    expect(reply).toContain("0.25 ETH");
    expect(reply).not.toContain("USDC");
    expect(reply).not.toContain("staked");
    expect(runTool.mock.calls[0][1]).toEqual({ symbol: "ETH" });
  });

  it("answers MPGR wallet balance without folding in staked or locked", async () => {
    const reply = await answerFor("How much MPGR do I have?", {
      wallet_balances: () => balances({ assets: [{ symbol: "MPGR", human: "100" }] }),
    });

    expect(reply).toContain("100 MPGR");
    expect(reply.toLowerCase()).not.toContain("staked");
    expect(reply.toLowerCase()).not.toContain("locked");
    // 50 staked / 25 locked live in the context — they must not appear.
    expect(reply).not.toContain("50 MPGR");
    expect(reply).not.toContain("25 MPGR");
  });

  it("answers USDC only for 'How much USDC do I have?'", async () => {
    const reply = await answerFor("How much USDC do I have?", {
      wallet_balances: () => balances({ assets: [{ symbol: "USDC", human: "42.5" }] }),
    });
    expect(reply).toContain("42.5 USDC");
    expect(reply).not.toContain("ETH");
  });

  it("reports a small B20 balance at on-chain precision, not rounded to 2dp", async () => {
    // 0.0421 AAPLc is ~$14 — compact 2dp rounding said "0.04".
    const reply = await answerFor("How much AAPLc in my wallet", {
      wallet_balances: () => balances({ assets: [{ symbol: "AAPLc", human: "0.0421" }] }),
    });
    expect(reply).toContain("0.0421");

    // Dust below readable precision still never becomes a bare "0".
    const dusty = await answerFor("How much AAPLc in my wallet", {
      wallet_balances: () => balances({ assets: [{ symbol: "AAPLc", human: "0.000000123456789" }] }),
    });
    expect(dusty).not.toContain("0 AAPLc");
    expect(dusty).toContain("0.000000123456789");

    // Whole-token amounts keep the chain's own string.
    const whole = await answerFor("How much AAPLc in my wallet", {
      wallet_balances: () => balances({ assets: [{ symbol: "AAPLc", human: "12.5" }] }),
    });
    expect(whole).toContain("12.5");
  });

  it("says so when the on-chain read failed instead of printing a zero", async () => {
    const reply = await answerFor("What is my cbADA balance?", {
      wallet_balances: () =>
        balances({ assets: [{ symbol: "cbADA", human: null }] }),
    });
    expect(reply.toLowerCase()).toContain("could not read");
    expect(reply).not.toContain("0 cbADA");
  });

  it("asks for a symbol/address when the asset cannot be resolved", async () => {
    const reply = await answerFor("what is my foo balance?", {
      wallet_balances: () => balances({ assets: [{ symbol: "USDC", human: "5" }] }),
    });

    expect(reply).toContain("foo");
    expect(reply).toContain("0x");
    expect(reply.toLowerCase()).toContain("symbol");
    // No wallet dump and no invented contract: nothing was read at all.
    expect(runTool).not.toHaveBeenCalled();
    expect(reply).not.toContain("wallet-held");
    expect(reply).not.toContain(": 5");
  });

  it("never falls back to the portfolio summary for a single token", async () => {
    const provider = new DeterministicAIProvider();
    runTool.mockResolvedValue(balances({ assets: [{ symbol: "MSTRc", human: "3" }] }));
    const response = await provider.generateReply(makeRequest("What is my MSTRc balance?"));

    expect(response.actions).toEqual([]);
    expect(response.highlights).toEqual([]);
    expect(response.followUps).toEqual([]);
    expect(response.reply).not.toContain("Total $MPGR exposure");
    expect(response.reply).not.toContain("Holder Score");
  });
});

describe("wallet vs staked vs locked", () => {
  it("answers staked MPGR only, and labels the wallet bucket separately", async () => {
    const reply = await answerFor("how much MPGR do I have staked?", {
      wallet_balances: () => balances({ assets: [{ symbol: "MPGR", human: "100" }] }),
    });

    expect(reply).toContain("Staked: 50 MPGR");
    expect(reply).toContain("wallet balance is 100 MPGR");
    expect(reply).not.toContain("locked");
  });

  it("answers locked MPGR only, and labels the wallet bucket separately", async () => {
    const reply = await answerFor("how much MPGR do I have locked?", {
      wallet_balances: () => balances({ assets: [{ symbol: "MPGR", human: "100" }] }),
    });

    expect(reply).toContain("Locked: 25 MPGR");
    expect(reply).toContain("wallet balance is 100 MPGR");
    expect(reply).not.toContain("Staked:");
  });

  it("states the total exposure as three labeled buckets", async () => {
    const reply = await answerFor("what is my total MPGR exposure?", {
      wallet_balances: () => balances({ assets: [{ symbol: "MPGR", human: "100" }] }),
    });

    expect(reply).toContain("wallet: 100 MPGR");
    expect(reply).toContain("staked: 50 MPGR");
    expect(reply).toContain("locked: 25 MPGR");
    expect(reply).toContain("combined: 175 MPGR");
  });

  it("says a non-MPGR asset has no staked balance", async () => {
    const reply = await answerFor("what is my AAPLc staked balance?", {
      wallet_balances: () => balances({ assets: [{ symbol: "AAPLc", human: "2" }] }),
    });
    expect(reply).toContain("MPGR-only");
    expect(reply).toContain("2 AAPLc");
  });
});

describe("whole wallet", () => {
  it("lists wallet-held assets and separates staked/locked MPGR", async () => {
    const reply = await answerFor("What's in my wallet?", {
      wallet_balances: () =>
        balances({
          eth: "0.05",
          assets: [
            { symbol: "USDC", human: "120.5" },
            { symbol: "cbADA", human: "0" },
            { symbol: "AAPLc", human: "2" },
          ],
        }),
    });

    expect(reply).toContain("ETH: 0.05");
    expect(reply).toContain("USDC: 120.5");
    expect(reply).toContain("AAPLc: 2");
    // Zero balances are not listed; buckets stay separate.
    expect(reply).not.toContain("cbADA: 0");
    expect(reply).toContain("wallet only");
    expect(reply).toContain("Not in your wallet: 50 MPGR staked and 25 MPGR locked");
  });
});

describe("total wallet value", () => {
  it("sums only assets an in-app source can price, and says what it excluded", async () => {
    const reply = await answerFor("How much is my wallet worth?", {
      wallet_balances: () =>
        balances({
          eth: "0.05",
          assets: [
            { symbol: "USDC", human: "100" },
            { symbol: "cbBTC", human: "0.01" },
            { symbol: "AAPLc", human: "1" },
          ],
        }),
      get_tape: tape,
      market_intelligence: () =>
        toolSuccess("market_intelligence", { mpgr: { priceUsd: 0.02 } }),
      trade_get_price: () =>
        toolError("trade_get_price", { code: "DATA_UNAVAILABLE", message: "no quote" }),
    });

    // 100 USDC ($1) + 0.01 cbBTC ($650) + 1 AAPLc (feed $280) = $1,030
    expect(reply).toContain("$1,030");
    expect(reply).toContain("USDC 100 = $100");
    expect(reply).toContain("cbBTC 0.01 = $650");
    expect(reply).toContain("AAPLc 1 = $280");
    // ETH has no price in this run — reported, never guessed.
    expect(reply).toContain("Not priced by an in-app source");
    expect(reply).toContain("ETH 0.05");
    // Staked/locked are explicitly outside the total.
    expect(reply).toContain("NOT in the total");
  });

  it("prices ETH from the live ETH→USDC swap quote when one is available", async () => {
    const reply = await answerFor("how much is my wallet worth", {
      wallet_balances: () => balances({ eth: "2", assets: [] }),
      get_tape: tape,
      market_intelligence: () =>
        toolSuccess("market_intelligence", { mpgr: { priceUsd: 0.02 } }),
      trade_get_price: () =>
        toolSuccess("trade_get_price", {
          price: { liquidityAvailable: true, fromAmount: "1000000000000000000", toAmount: "3000000000" },
        }),
    });

    // 2 ETH × $3,000
    expect(reply).toContain("$6,000");
    expect(reply).toContain("live ETH→USDC swap price");
  });

  it("never invents a total when nothing can be priced", async () => {
    const reply = await answerFor("How much is my wallet worth?", {
      wallet_balances: () => balances({ eth: "0.05", assets: [{ symbol: "MPGR", human: "10" }] }),
      get_tape: () => toolError("get_tape", { code: "DATA_UNAVAILABLE", message: "down" }),
      market_intelligence: () =>
        toolError("market_intelligence", { code: "DATA_UNAVAILABLE", message: "down" }),
      trade_get_price: () =>
        toolError("trade_get_price", { code: "DATA_UNAVAILABLE", message: "down" }),
    });

    expect(reply.toLowerCase()).toContain("will not invent a total");
    expect(reply).toContain("ETH: 0.05");
    expect(reply).toContain("MPGR: 10");
  });
});

describe("failures stay honest", () => {
  it("reports an unreadable wallet instead of guessing balances", async () => {
    const reply = await answerFor("What's in my wallet?", {
      wallet_balances: () =>
        toolError("wallet_balances", { code: "PROVIDER_ERROR", message: "rpc down" }),
    });
    expect(reply.toLowerCase()).toContain("could not read");
    expect(reply).not.toContain("0 ETH");
  });

  it("asks for a wallet connection instead of guessing when none is connected", async () => {
    runTool.mockResolvedValue(balances({}));
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("How much USDC do I have?", {
        agentContext: { isConnected: false } as unknown as AIProviderRequest["agentContext"],
      }),
    );
    // No balance read without a wallet, and no invented numbers.
    expect(runTool).not.toHaveBeenCalled();
    expect(response.reply.toLowerCase()).toContain("connect");
  });
});

describe("network-model path (tool-calling loop)", () => {
  it("answers a balance question itself, without calling the model", async () => {
    runTool.mockResolvedValue(balances({ assets: [{ symbol: "MSTRc", human: "7" }] }));
    const sendCompletion = vi.fn().mockResolvedValue(JSON.stringify({ intent: "general_help", reply: "hi" }));

    const response = await runToolCallingLoop(
      makeRequest("What is my MSTRc balance?"),
      "base prompt",
      sendCompletion,
    );

    expect(sendCompletion).not.toHaveBeenCalled();
    expect(response.reply).toContain("7 MSTRc");
    expect(response.reply.toLowerCase()).not.toContain("staked");
  });

  it("still routes every other prompt through the model", async () => {
    const sendCompletion = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ intent: "general_help", reply: "hello there" }));

    const response = await runToolCallingLoop(makeRequest("hi"), "base prompt", sendCompletion);

    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(response.reply).toContain("hello there");
  });
});
