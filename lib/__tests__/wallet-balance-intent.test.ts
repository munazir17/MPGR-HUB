import { describe, expect, it } from "vitest";

import {
  isWalletBalancePrompt,
  parseWalletBalanceRequest,
} from "@/lib/agent-intelligence";

/**
 * Strict wallet-balance intent. The whole point of this layer is that a
 * single-token balance question is answered for THAT token only — so these
 * tests pin both the accepted shapes AND everything that must keep its
 * existing routing (actions, how-to, research, XP/staking intents).
 */
describe("wallet-balance intent parsing", () => {
  it("reads a single-token balance request", () => {
    expect(parseWalletBalanceRequest("What is my MSTRc balance?")).toEqual({
      kind: "single",
      token: "MSTRc",
      resolved: true,
      mention: "MSTRc",
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("How much ETH do I have?")).toMatchObject({
      kind: "single",
      token: "ETH",
      resolved: true,
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("How much MPGR do I have?")).toMatchObject({
      kind: "single",
      token: "MPGR",
      resolved: true,
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("How much USDC do I have?")).toMatchObject({
      kind: "single",
      token: "USDC",
      resolved: true,
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("what's my cbADA balance")).toMatchObject({
      kind: "single",
      token: "cbADA",
      resolved: true,
    });
  });

  it("reads the '<token> in my wallet' shape as a single-token balance", () => {
    // Reported bug: this phrasing fell through to the tokenized-stock
    // research path, so a balance question was answered with an oracle
    // price card.
    expect(parseWalletBalanceRequest("How much AAPLc in my wallet")).toEqual({
      kind: "single",
      token: "AAPLc",
      resolved: true,
      mention: "AAPLc",
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("how much eth in my wallet")).toMatchObject({
      kind: "single",
      token: "ETH",
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("how much USDC do I have in my wallet")).toMatchObject({
      kind: "single",
      token: "USDC",
    });
    expect(parseWalletBalanceRequest("how many cbBTC in my wallet")).toMatchObject({
      kind: "single",
      token: "cbBTC",
    });
  });

  it("asks for a symbol when a wallet question names an unresolvable asset", () => {
    const request = parseWalletBalanceRequest("How much FAKECOIN in my wallet");
    expect(request).toMatchObject({ kind: "single", token: "FAKECOIN", resolved: false });
  });

  it("keeps a bare price question out of the balance path", () => {
    // Only the explicit wallet location counts — no wallet, no balance read.
    expect(parseWalletBalanceRequest("how much is AAPLc")).toBeNull();
    expect(parseWalletBalanceRequest("what is the AAPLc price")).toBeNull();
    expect(parseWalletBalanceRequest("how much is my AAPLc worth")).toBeNull();
  });

  it("resolves B20 tickers, underlying names and the core catalog", () => {
    expect(parseWalletBalanceRequest("what is my AAPLc balance")).toMatchObject({
      token: "AAPLc",
    });
    expect(parseWalletBalanceRequest("balance of microstrategy")).toMatchObject({
      token: "MSTRc",
    });
    expect(parseWalletBalanceRequest("how much weth do i have")).toMatchObject({
      token: "WETH",
    });
  });

  it("never infers a single-token balance from a whole-wallet question", () => {
    expect(parseWalletBalanceRequest("What's in my wallet?")).toEqual({ kind: "all" });
    expect(parseWalletBalanceRequest("show me my wallet balances")).toEqual({ kind: "all" });
    expect(parseWalletBalanceRequest("what tokens do i have")).toEqual({ kind: "all" });
    expect(parseWalletBalanceRequest("list my assets")).toEqual({ kind: "all" });
  });

  it("reads a wallet-value question as a total, not as a token balance", () => {
    expect(parseWalletBalanceRequest("How much is my wallet worth?")).toEqual({ kind: "total" });
    expect(parseWalletBalanceRequest("what's my portfolio value")).toEqual({ kind: "total" });
    expect(parseWalletBalanceRequest("total wallet value")).toEqual({ kind: "total" });
  });

  it("keeps wallet / staked / locked / exposure in separate scopes", () => {
    expect(parseWalletBalanceRequest("how much MPGR do I have staked?")).toMatchObject({
      kind: "single",
      token: "MPGR",
      scope: "staked",
    });
    expect(parseWalletBalanceRequest("how much MPGR do I have locked?")).toMatchObject({
      kind: "single",
      token: "MPGR",
      scope: "locked",
    });
    expect(parseWalletBalanceRequest("what is my total MPGR exposure?")).toMatchObject({
      kind: "single",
      token: "MPGR",
      scope: "exposure",
    });
  });

  it("flags an asset this app cannot resolve instead of dumping the wallet", () => {
    expect(parseWalletBalanceRequest("what is my foo balance")).toEqual({
      kind: "single",
      token: "foo",
      resolved: false,
      mention: "foo",
      scope: "wallet",
    });
    expect(parseWalletBalanceRequest("balance of FAKECOIN")).toMatchObject({
      kind: "single",
      resolved: false,
    });
  });

  it("leaves every non-balance question alone", () => {
    for (const prompt of [
      "How much XP do I have?",
      "what's my holder tier?",
      "how do I check my balance?",
      "where can I see my balance?",
      "explain wallet balance vs staked balance",
      "what is the difference between staked and locked",
      "should I buy MSTRc?",
      "Check MSTRc price and oracle",
      "stake 100 MPGR",
      "lock my MPGR",
      "swap 10 USDC to cbADA",
      "Sell my 5 USDC worth of MSTRc",
      "send 1 eth to jesse.base.eth",
      "how much is my MSTRc worth?",
      "what's moving in the market?",
      "hi",
      "my balance",
    ]) {
      expect(parseWalletBalanceRequest(prompt), prompt).toBeNull();
      expect(isWalletBalancePrompt(prompt), prompt).toBe(false);
    }
  });

  it("exposes a boolean form for routing layers", () => {
    expect(isWalletBalancePrompt("What is my MSTRc balance?")).toBe(true);
    expect(isWalletBalancePrompt("How much ETH do I have?")).toBe(true);
    expect(isWalletBalancePrompt("What's in my wallet?")).toBe(true);
    expect(isWalletBalancePrompt("How much is my wallet worth?")).toBe(true);
  });
});
