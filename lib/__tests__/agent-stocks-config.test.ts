import { describe, expect, it } from "vitest";
import {
  MPGR_AGENT_TITLE,
  STOCKS_AGENT_CHIPS,
  STOCKS_AGENT_DISCLAIMER,
  STOCKS_AGENT_EMPTY_STATE,
} from "@/lib/agent-stocks-config";
import { X402_TAPE_PATH } from "@/lib/x402/x402-tape-info";

// Home is the MPGR AGENT, and the Base Stocks terminal lives inside it.
// These tests lock the two product rules of the Home chat integration:
//
//   1. the agent is always named "MPGR AGENT" — folding the stocks
//      tooling into Home must never rename it to "Base Stocks Agent";
//   2. there is ONE canonical set of suggested prompts (the stocks
//      chips), rendered inside the composer card — no second chip set.

describe("Home MPGR AGENT stocks config", () => {
  it("the agent name is exactly MPGR AGENT, never Base Stocks Agent", () => {
    expect(MPGR_AGENT_TITLE).toBe("MPGR AGENT");
    expect(MPGR_AGENT_TITLE).not.toBe("Base Stocks Agent");
  });

  it("the eligibility disclaimer is always part of the config", () => {
    // Coinbase Tokenized Stocks are for eligible non-US persons — the
    // hero must keep surfacing this, so the copy is asserted verbatim
    // in lib/markets/__tests__/base-pairs.test.ts; here just presence.
    expect(STOCKS_AGENT_DISCLAIMER.length).toBeGreaterThan(0);
    expect(STOCKS_AGENT_DISCLAIMER).toMatch(/non-US/i);
  });

  it("has one canonical chip set with unique ids covering the stocks tools", () => {
    const ids = STOCKS_AGENT_CHIPS.map((chip) => chip.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The latest Base Stocks prompts: pair/premium info, prepare-only
    // USDC → stock swaps, 0xb200 contract verification, holdings, and
    // the $0.02 x402 live tape.
    expect(ids).toEqual(
      expect.arrayContaining(["premium", "quote", "holdings", "verify", "tape-x402", "prepare-swap"]),
    );
  });

  it("chips carry real agent prompts, not empty labels", () => {
    for (const chip of STOCKS_AGENT_CHIPS) {
      expect(chip.label.trim().length).toBeGreaterThan(0);
      expect(chip.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("the x402 tape chip builds its prompt from the deployment origin at click time", () => {
    const tapeChip = STOCKS_AGENT_CHIPS.find((chip) => chip.id === "tape-x402");
    expect(tapeChip).toBeDefined();
    expect(tapeChip!.buildPrompt).toBeTypeOf("function");

    const built = tapeChip!.buildPrompt!("https://mpgr-hub.example");
    expect(built).toContain("$0.02 x402");
    expect(built).toContain("https://mpgr-hub.example" + X402_TAPE_PATH);

    // Without an origin (e.g. non-browser caller) it still produces the
    // plain $0.02 tape prompt rather than throwing.
    const fallback = tapeChip!.buildPrompt!("");
    expect(fallback).toContain("$0.02 x402");
    expect(fallback).not.toContain("undefined");
  });

  it("the 0xb200 verify chip targets the official Coinbase stock contract", () => {
    const verifyChip = STOCKS_AGENT_CHIPS.find((chip) => chip.id === "verify");
    expect(verifyChip!.prompt.toLowerCase()).toContain("0xb200");
  });

  it("the empty-state copy points at the stocks tools", () => {
    expect(STOCKS_AGENT_EMPTY_STATE.length).toBeGreaterThan(0);
    expect(STOCKS_AGENT_EMPTY_STATE).toMatch(/swap/i);
  });
});
