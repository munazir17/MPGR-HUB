// lib/swap/token-risk.ts
// Honest, signal-based risk assessment for the Swap review step.
// Signals used are only ones the app actually has: protocol price impact from
// the verified quote, an operator-reviewed flagged-address manifest (pinned by
// exact Base address), and import/verification provenance. Nothing here ever
// claims a token is SAFE; passing all checks only means no listed signal fired.
import flags from "./token-risk-flags.json";

export interface SwapRiskWarning { code: string; message: string; ackRequired: boolean }
export interface SwapRiskInput {
  chainId: number;
  receiveAddress: string;
  receiveVerified: boolean;
  receiveImported: boolean;
  priceImpactBps: number | null;
  sellSideQuoted: boolean | null;
}
export const RISK_DISCLAIMER = "These checks can never prove a token is safe. They only report the signals below.";

const flagged: Readonly<Record<string, string>> = (flags as { flagged: Record<string, string> }).flagged;

export function assessSwapRisk(input: SwapRiskInput): SwapRiskWarning[] {
  const out: SwapRiskWarning[] = [];
  const key = input.chainId === 8453 ? input.receiveAddress.toLowerCase() : "";
  const flag = key ? flagged[key] : undefined;
  if (flag) out.push({ code: "FLAGGED_TOKEN", message: `Community/operator risk flag on this contract: ${flag}`, ackRequired: true });
  if (input.priceImpactBps !== null && input.priceImpactBps >= 5000) {
    out.push({ code: "EXTREME_PRICE_IMPACT", message: `This size would lose about ${(input.priceImpactBps / 100).toFixed(1)}% versus the pool price. Reduce the amount — the swap stays blocked so you are not filled at a wrecked rate.`, ackRequired: true });
  } else if (input.priceImpactBps !== null && input.priceImpactBps >= 1000) {
    out.push({ code: "THIN_LIQUIDITY", message: `This trade moves the pool price by ~${(input.priceImpactBps / 100).toFixed(1)}%. Liquidity is thin for this size; you may receive far less than quoted.`, ackRequired: true });
  } else if (input.priceImpactBps !== null && input.priceImpactBps >= 500) {
    out.push({ code: "HIGH_PRICE_IMPACT", message: `High price impact (~${(input.priceImpactBps / 100).toFixed(1)}%). A smaller trade would get a better rate.`, ackRequired: true });
  }
  if (input.sellSideQuoted === false) {
    out.push({ code: "SELL_SIDE_UNQUOTED", message: "No reverse-direction quote could be found. Selling this token again may fail even if this buy succeeds.", ackRequired: true });
  }
  if (input.receiveImported && !input.receiveVerified) {
    out.push({ code: "IMPORTED_UNVERIFIED", message: "Imported token: on-chain details were validated, but no list vouches for it. Check the contract yourself.", ackRequired: false });
  }
  return out;
}
export const riskAckRequired = (warnings: readonly SwapRiskWarning[]): boolean => warnings.some(w => w.ackRequired);
