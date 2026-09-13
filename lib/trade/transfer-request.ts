// lib/trade/transfer-request.ts
//
// Shared request parsing for /api/transfer/quote and the transfer_prepare_send
// agent tool. Mirrors lib/trade/trade-request.ts's shape and safety rules:
// resolve token from the closed catalog or a raw 0x address (never invent a
// contract), verify on-chain decimals for anything not catalog-known before
// doing amount math, and never accept `sender`/`from` from the request body —
// the caller (the API route) always supplies it from the authenticated
// session wallet.

import { isAddress } from "viem";

import { parseAtomicAmount, parseHumanTokenAmount } from "./trade-format";
import { resolveTradeToken } from "./trade-tokens";
import { readB20Decimals } from "./tokenized-stocks-onchain";
import { resolveRecipient } from "./transfer-basename";
import type { TransferError } from "./transfer-types";
import type { TradeTokenRef } from "./trade-types";
import type { ResolvedRecipient } from "./transfer-types";

export interface ParsedTransferRequest {
  asset: TradeTokenRef;
  amount: string;
  recipient: ResolvedRecipient;
}

export type ParseTransferResult =
  | { ok: true; value: ParsedTransferRequest }
  | { ok: false; error: TransferError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withVerifiedDecimals(
  token: TradeTokenRef,
): Promise<{ ok: true; token: TradeTokenRef } | { ok: false; error: TransferError }> {
  const needsVerification = token.kind === "b20-tokenized-stock" || (token.kind === "erc20" && token.verified === false);
  if (!needsVerification) return { ok: true, token };
  const decimals = await readB20Decimals(token.address as `0x${string}`);
  if (decimals === null) {
    return {
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: `Could not verify ${token.symbol}'s on-chain decimals — refusing to guess for a real-funds transfer. Try again shortly.`,
      },
    };
  }
  return { ok: true, token: { ...token, decimals } };
}

function resolveAmount(raw: Record<string, unknown>, decimals: number): bigint | null {
  if (raw.amount != null && String(raw.amount).trim() !== "") {
    return parseHumanTokenAmount(raw.amount, decimals);
  }
  const atomic = raw.atomicAmount ?? raw.fromAmount;
  if (atomic == null) return null;
  return parseAtomicAmount(atomic);
}

/**
 * Parses a transfer request body. `options.sender` MUST be the
 * authenticated session wallet — never a client-supplied field. It is
 * accepted here only so callers can pass it through for a future
 * self-send check; it is not otherwise used for token/recipient/amount
 * resolution.
 */
export async function parseTransferRequest(raw: unknown): Promise<ParseTransferResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Request body must be a JSON object." } };
  }

  const tokenInput = raw.token ?? raw.asset;
  const resolvedToken = resolveTradeToken(tokenInput);
  if (!resolvedToken.ok) {
    return { ok: false, error: { code: "UNSUPPORTED_ASSET", message: resolvedToken.message } };
  }

  const verified = await withVerifiedDecimals(resolvedToken.token);
  if (!verified.ok) return { ok: false, error: verified.error };

  const amount = resolveAmount(raw, verified.token.decimals);
  if (amount === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Provide amount in token units (e.g. \"0.01\") or atomicAmount as an atomic integer string.",
      },
    };
  }

  const recipientInput = raw.recipient ?? raw.to ?? raw.destination;
  if (typeof recipientInput !== "string" || recipientInput.trim().length === 0) {
    return {
      ok: false,
      error: { code: "INVALID_RECIPIENT", message: "recipient must be a Base address (0x...) or a Basename." },
    };
  }

  const resolvedRecipient = await resolveRecipient(recipientInput);
  if (!resolvedRecipient.ok) {
    return { ok: false, error: { code: "RECIPIENT_UNRESOLVED", message: resolvedRecipient.message } };
  }

  return {
    ok: true,
    value: {
      asset: verified.token,
      amount: amount.toString(),
      recipient: {
        input: recipientInput.trim(),
        inputKind: resolvedRecipient.inputKind,
        address: resolvedRecipient.address,
        basename: resolvedRecipient.basename,
      },
    },
  };
}

export function isAddressLike(value: unknown): value is string {
  return typeof value === "string" && isAddress(value.trim());
}
