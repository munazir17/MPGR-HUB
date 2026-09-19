import { describe, expect, it } from "vitest";
import {
  AGENT_AUTH_USER_ERROR,
  AGENT_GENERIC_USER_ERROR,
  AGENT_NETWORK_USER_ERROR,
  AGENT_PROVIDER_USER_ERROR,
  AGENT_REQUEST_TOO_LARGE_USER_ERROR,
  presentAgentUserError,
  sanitizeAgentUserError,
  serializeAgentFailure,
} from "./sanitize-agent-user-error";

const TRADE_PROMPT = "buy $5 USDC of AAPLc";

describe("sanitizeAgentUserError", () => {
  it("hides raw NVIDIA provider errors from the frontend banner", () => {
    expect(sanitizeAgentUserError("[nvidia] Request body too large")).toBe(
      AGENT_REQUEST_TOO_LARGE_USER_ERROR,
    );
    expect(sanitizeAgentUserError("[nvidia] Request body too large")).not.toMatch(/nvidia/i);
  });

  it("hides Gemini failure / fallback copy from users", () => {
    const raw =
      "MPGR Agent's gemini connection is currently failing — replies are falling back to the on-device engine.";
    expect(sanitizeAgentUserError(raw)).toBe(AGENT_GENERIC_USER_ERROR);
    expect(sanitizeAgentUserError(raw)).not.toMatch(/gemini|on-device|429|502/i);
  });

  it("does not rewrite a successful Agent-style user message", () => {
    const reply = "Prepared a Coinbase B20 tokenized-stock swap preview for AAPLc.";
    expect(sanitizeAgentUserError(reply)).toBe(reply);
  });

  it("maps explicit 401 / AUTH_REQUIRED to a wallet reconnect message", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("401 AUTH_REQUIRED Authentication required", ctx)).toBe(
      AGENT_AUTH_USER_ERROR,
    );
    expect(sanitizeAgentUserError("AUTH_REQUIRED", ctx)).toBe(AGENT_AUTH_USER_ERROR);
    expect(presentAgentUserError("401 AUTH_REQUIRED", ctx).retryable).toBe(false);
    expect(sanitizeAgentUserError("401 AUTH_REQUIRED", ctx)).not.toMatch(/nvidia|request id|AUTH_REQUIRED/i);
  });

  it("does not infer 401 from auth-like prose without status or AUTH_REQUIRED", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("Authentication required", ctx)).toBe(AGENT_GENERIC_USER_ERROR);
    expect(sanitizeAgentUserError("[nvidia] Authentication required", ctx)).toBe(AGENT_GENERIC_USER_ERROR);
  });

  it("maps explicit quote / liquidity codes to a ticker-aware unavailable message", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("LIQUIDITY_UNAVAILABLE No executable Base route", ctx)).toBe(
      "AAPLc quote is currently unavailable. Please try again.",
    );
    expect(
      sanitizeAgentUserError("LIQUIDITY_UNAVAILABLE", { lastUserMessage: "sell $10 of TSLAc" }),
    ).toBe("TSLAc quote is currently unavailable. Please try again.");
    expect(presentAgentUserError("LIQUIDITY_UNAVAILABLE", ctx).retryable).toBe(true);
  });

  it("does not infer a quote failure from generic prepare prose", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("Could not prepare a tokenized-stock Base swap.", ctx)).toBe(
      AGENT_GENERIC_USER_ERROR,
    );
  });

  it("maps explicit 502/503 to a temporary trading-service message", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("502 PROVIDER_UNREACHABLE NVIDIA NIM is temporarily unavailable.", ctx)).toBe(
      AGENT_PROVIDER_USER_ERROR,
    );
    expect(sanitizeAgentUserError("503 CREDENTIALS_MISSING", ctx)).toBe(AGENT_PROVIDER_USER_ERROR);
    expect(presentAgentUserError("502", ctx).retryable).toBe(true);
    expect(sanitizeAgentUserError("502", ctx)).not.toMatch(/nvidia|502|request id/i);
  });

  it("does not infer 502/503 from provider prose without an explicit status", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("NVIDIA NIM is temporarily unavailable. Please retry shortly.", ctx)).toBe(
      AGENT_GENERIC_USER_ERROR,
    );
    expect(sanitizeAgentUserError("PROVIDER_UNREACHABLE", ctx)).toBe(AGENT_GENERIC_USER_ERROR);
  });

  it("maps browser network failures to a reachability message", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("Failed to fetch", ctx)).toBe(AGENT_NETWORK_USER_ERROR);
    expect(sanitizeAgentUserError("network error", ctx)).toBe(AGENT_NETWORK_USER_ERROR);
    expect(presentAgentUserError("Failed to fetch", ctx).retryable).toBe(true);
  });

  it("preserves the generic fallback when status cannot be determined", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    expect(sanitizeAgentUserError("", ctx)).toBe(AGENT_GENERIC_USER_ERROR);
    expect(sanitizeAgentUserError("[nvidia] unexpected provider failure", ctx)).toBe(
      AGENT_GENERIC_USER_ERROR,
    );
  });

  it("never surfaces stack traces, request IDs, or provider names", () => {
    const ctx = { lastUserMessage: TRADE_PROMPT };
    const raw =
      "[nvidia] boom request id 7f3c stack at prepareTokenizedStockSwap (lib/trade/tokenized-stock-swap.ts:174)";
    const presented = sanitizeAgentUserError(raw, ctx);
    expect(presented).toBe(AGENT_GENERIC_USER_ERROR);
    expect(presented).not.toMatch(/nvidia|request id|stack|tokenized-stock-swap|7f3c/i);
  });
});

describe("serializeAgentFailure", () => {
  it("copies status and code only when they already exist on the error", () => {
    const err = new Error("Authentication required") as Error & { status?: number; code?: string };
    err.status = 401;
    err.code = "AUTH_REQUIRED";
    expect(serializeAgentFailure(err)).toContain("401");
    expect(serializeAgentFailure(err)).toContain("AUTH_REQUIRED");
    expect(sanitizeAgentUserError(serializeAgentFailure(err), { lastUserMessage: TRADE_PROMPT })).toBe(
      AGENT_AUTH_USER_ERROR,
    );
  });

  it("does not invent an HTTP status when the error has none", () => {
    const err = new Error("Authentication required");
    expect(serializeAgentFailure(err)).toBe("Authentication required");
    expect(serializeAgentFailure(err)).not.toMatch(/\b401\b|\b502\b|\b503\b/);
    expect(sanitizeAgentUserError(serializeAgentFailure(err))).toBe(AGENT_GENERIC_USER_ERROR);
  });
});
