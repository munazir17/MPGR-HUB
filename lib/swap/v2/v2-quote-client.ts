// lib/swap/v2/v2-quote-client.ts
// Client-side V2 quote dispatch.
//
// While `V2_DEPLOYMENT` is null the status probe reports `activated:false` and
// `requestSwapQuoteWithV2` is exactly today's V1 call — one extra tiny cached GET
// per TTL, no change to any quote outcome. Once the gate is flipped server-side,
// V2 becomes the primary engine automatically and V1 remains the fallback, with
// no further client change.
//
// Honest failure rules:
//  - A dormant or non-executable V2 response is NOT an error; it yields null and
//    the caller falls back to V1.
//  - An EXECUTABLE response that this client refuses to validate IS an error. The
//    server produced a transaction our own checks reject, and silently serving a
//    different engine's route instead would substitute a route the user never
//    reviewed.
import type { Address } from "viem";
import { ManualSwapQuoteError, manualQuoteFresh, MANUAL_SWAP_TOKENS, type ManualSwapInput } from "@/lib/trade/manual-swap";
import { revalidateTradeProposal } from "@/lib/trade/trade-confirmation";
import { parseHumanTokenAmount } from "@/lib/trade/trade-format";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { swapQuoteFresh, swapQuoteExpiry } from "@/lib/swap/swap-lifecycle";
import { swapQuotePolicyError } from "@/lib/swap/swap-policy";
import { swapInputError } from "@/lib/swap/swap-capability";
import { requestSwapQuote } from "@/lib/swap/swap-quote";
import { isExecutableSwapV2Response, swapV2ProposalFromResponse, type SwapV2QuoteResponse } from "./v2-proposal";
import { swapV2RoutingEvidence, swapV2RoutingEvidenceValid } from "./v2-evidence";

export class SwapV2QuoteError extends ManualSwapQuoteError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "SwapV2QuoteError";
    this.message = message;
  }
}

/** Activation is public, non-secret information: it says only whether the app is
 * currently allowed to return an executable V2 transaction. */
export interface SwapV2Status { activated: boolean; chainId: number }

const STATUS_TTL_MS = 60_000;
let statusCache: { at: number; value: SwapV2Status } | null = null;

/** Reads the activation gate. Any failure is treated as NOT activated, so a
 * broken probe can never switch the live surface onto an unverified engine. */
export async function fetchSwapV2Status(signal?: AbortSignal, force = false): Promise<SwapV2Status> {
  const now = Date.now();
  if (!force && statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const dormant: SwapV2Status = { activated: false, chainId: 8453 };
  try {
    const response = await fetch("/api/swap/v2/status", {
      method: "GET", credentials: "include", cache: "no-store", signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return dormant;
    const payload = (await response.json()) as Partial<SwapV2Status>;
    const value: SwapV2Status = { activated: payload.activated === true, chainId: payload.chainId === 8453 ? 8453 : 0 };
    if (value.chainId !== 8453) return dormant;
    statusCache = { at: now, value };
    return value;
  } catch {
    return dormant;
  }
}

/** Test hook: clears the cached activation status. */
export function __resetSwapV2StatusCacheForTests(): void { statusCache = null; }

const HONEST_ERRORS: Record<string, string> = {
  LIQUIDITY_UNAVAILABLE: "No liquid V2 route quotes for this Base pair. Nothing was prepared.",
  DISCOVERY_UNAVAILABLE: "V2 liquidity discovery is unavailable right now. No route was substituted.",
  INVALID_PAIR: "This V2 pair is invalid. ETH and WETH are the same asset; choose two distinct assets.",
  INVALID_AMOUNT: "This amount is too small for the mandatory 0.25% MPGR fee.",
  FEE_POLICY_INVALID: "The V2 fee policy does not match the required 0.25% MPGR fee. Nothing was prepared.",
  EXECUTOR_PAUSED: "The MPGR V2 executor is paused on-chain. No swap was prepared.",
  FEE_RECIPIENT_CHANGED: "The V2 executor's fee recipient no longer matches the pinned treasury. No swap was prepared.",
  OWNER_CHANGED: "The V2 executor is not owned by the governance Safe. No swap was prepared.",
  PENDING_FEE_CHANGE: "A governance fee change has passed its timelock and could apply at any moment. No swap was prepared.",
  VENUE_NOT_REGISTERED: "A required V2 venue is no longer registered on-chain. No swap was prepared.",
  UNSUPPORTED_NETWORK: "The V2 executor could not be verified on Base Mainnet. No swap was prepared.",
  EXECUTOR_NOT_DEPLOYED: "The V2 executor has no runtime code at the quoted block. No swap was prepared.",
  ROUTE_VERIFICATION_UNAVAILABLE: "The V2 executor's live state could not be read. This is a provider problem, not missing liquidity.",
  EXECUTION_UNAVAILABLE: "The V2 executor could not verify this route. No swap was prepared.",
  QUOTE_CHANGED: "The block this quote was pinned to moved. Request a fresh quote.",
  PROVIDER_ERROR: "Base provider unavailable. No swap was prepared.",
};

/** Requests an executable V2 quote, or null when V2 cannot serve this pair.
 * Throws only on a genuine failure (auth, rate limit, provider, or an executable
 * response that fails this client's own validation). */
export async function requestSwapV2Quote(
  input: ManualSwapInput,
  account: Address,
  signal?: AbortSignal,
  tokens: readonly TradeTokenRef[] = MANUAL_SWAP_TOKENS,
): Promise<TradeProposal | null> {
  const inputError = swapInputError(input, tokens);
  if (inputError) throw new Error(inputError);
  const response = await fetch("/api/swap/v2/quote", {
    method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...input, requireMPGRFee: true }),
  });
  const payload = (await response.json().catch(() => null)) as
    | (Partial<SwapV2QuoteResponse> & { proposal?: unknown; code?: string; error?: string })
    | null;

  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "INVALID_RESPONSE";
    const message = typeof payload?.error === "string" && payload.error.length > 0
      ? payload.error
      : HONEST_ERRORS[code] ?? "No executable V2 quote returned. Please retry.";
    throw new SwapV2QuoteError(response.status, code, message);
  }
  // Dormant gate, or V2 has no route for this pair: not an error, fall back to V1.
  if (!payload || !isExecutableSwapV2Response(payload)) return null;

  const from = tokens.find(t => t.address.toLowerCase() === input.fromToken.toLowerCase());
  const to = tokens.find(t => t.address.toLowerCase() === input.toToken.toLowerCase());
  if (!from || !to) throw new Error("Unknown token for the V2 quote. Re-import it and retry.");

  const quotedAt = Date.now();
  const proposal = swapV2ProposalFromResponse(payload as SwapV2QuoteResponse, {
    from, to, taker: account, slippageBps: input.slippageBps, quotedAt,
  });
  // An executable response we cannot validate is a real inconsistency. Do NOT
  // silently fall back to V1: that would hand the user a different route.
  if (!proposal) {
    throw new SwapV2QuoteError(500, "V2_QUOTE_REJECTED",
      "The V2 quote did not pass this client's own fee, minimum and route checks. Nothing was signed; request a fresh quote.");
  }

  const validation = revalidateTradeProposal(proposal, account);
  if (validation.state !== "VALIDATED") throw new Error(validation.error?.message ?? "Invalid V2 swap quote.");
  if (proposal.from.address.toLowerCase() !== input.fromToken.toLowerCase() ||
      proposal.to.address.toLowerCase() !== input.toToken.toLowerCase() ||
      parseHumanTokenAmount(input.amount, proposal.from.decimals)?.toString() !== proposal.fromAmount ||
      proposal.slippageBps !== input.slippageBps || !manualQuoteFresh(proposal, quotedAt)) {
    throw new Error("The V2 quote does not match the requested tokens, amount, slippage or expiry. Refresh the quote.");
  }
  const evidence = swapV2RoutingEvidence(proposal);
  if (!evidence || !swapV2RoutingEvidenceValid(proposal, evidence)) {
    throw new Error("The V2 route evidence does not bind this transaction. Request a fresh quote.");
  }
  const policyError = swapQuotePolicyError(proposal);
  if (policyError) throw new Error(policyError);
  if (!swapQuoteFresh(proposal, quotedAt)) throw new Error("The V2 route expired. Request a new quote.");
  return proposal;
}

/** The single quote entry point the swap UI should use.
 * V2 first when (and only when) the server says routing is activated; otherwise
 * V1, unchanged. A V2 "no route" result falls back to V1 so the user still gets
 * a quote from whichever engine can actually serve the pair. */
export async function requestSwapQuoteWithV2(
  input: ManualSwapInput,
  account: Address,
  signal?: AbortSignal,
  tokens: readonly TradeTokenRef[] = MANUAL_SWAP_TOKENS,
  options?: { fresh?: boolean },
): Promise<TradeProposal> {
  const status = await fetchSwapV2Status(signal);
  if (status.activated) {
    try {
      const v2 = await requestSwapV2Quote(input, account, signal, tokens);
      if (v2) return v2;
    } catch (error) {
      // An auth/rate-limit/provider failure on V2 is not a reason to pretend V1
      // has liquidity: surface it. Session expiry (401) must reach the caller so
      // the UI can re-authenticate rather than silently re-quoting.
      if (error instanceof ManualSwapQuoteError) throw error;
      if (error instanceof Error && /No liquid V2 route|does not pass this client/i.test(error.message)) throw error;
      // Anything else (e.g. an unexpected shape) still falls through to V1, which
      // performs its own independent validation.
    }
  }
  return requestSwapQuote(input, account, signal, tokens, options);
}

/** Exposed for tests and diagnostics: the remaining lifetime of a V2 quote. */
export const swapV2QuoteLifetimeMs = (p: TradeProposal, now = Date.now()): number =>
  Math.max(0, swapQuoteExpiry(p) - now);
