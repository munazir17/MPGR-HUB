// lib/trade/transfer-risk.ts
//
// Deterministic risk facts for the send/transfer confirmation UI. Built
// only from known request/on-chain facts — never a guessed balance or a
// fabricated recipient identity.

import type { TradeRiskFact, TradeTokenRef } from "./trade-types";
import type { ResolvedRecipient } from "./transfer-types";

export function buildTransferRiskFacts(input: {
  asset: TradeTokenRef;
  recipient: ResolvedRecipient;
  sufficientBalance: boolean;
}): TradeRiskFact[] {
  const facts: TradeRiskFact[] = [];

  if (!input.asset.verified) {
    facts.push({
      id: "unverified-asset",
      severity: "critical",
      title: "Unverified token",
      detail:
        "This token is not in MPGR's Base catalog. The address was supplied as a raw 0x value. Confirm it on a block explorer before signing.",
    });
  }

  if (!input.sufficientBalance) {
    facts.push({
      id: "insufficient-balance",
      severity: "critical",
      title: "Insufficient balance",
      detail: "Your wallet's on-chain balance is below this amount as of the last check. Nothing will be signed.",
    });
  }

  if (input.recipient.inputKind === "basename") {
    facts.push({
      id: "basename-resolved",
      severity: "info",
      title: `Basename resolved: ${input.recipient.basename}`,
      detail: `${input.recipient.basename} resolved to ${input.recipient.address}. Verify this matches who you intend to pay — Basename resolution cannot be undone once you sign.`,
    });
  } else {
    facts.push({
      id: "raw-address",
      severity: "warning",
      title: "Sending to a raw address",
      detail: "No Basename was used. Double-check every character of the recipient address before confirming.",
    });
  }

  facts.push({
    id: "irreversible",
    severity: "warning",
    title: "Base transfers cannot be reversed",
    detail: "Once signed and confirmed on-chain, this transfer cannot be cancelled or recalled by MPGR or anyone else.",
  });

  facts.push({
    id: "network",
    severity: "info",
    title: "Base Mainnet only",
    detail: "MPGR will not prepare or execute this transfer on any network other than Base.",
  });

  return facts;
}

export function riskToWarnings(facts: readonly TradeRiskFact[]): string[] {
  return facts.filter((fact) => fact.severity !== "info").map((fact) => `${fact.title}: ${fact.detail}`);
}
