// lib/x402/x402-execution.ts
//
// P3 — payment execution. This is the ONLY module in the x402 stack
// allowed to call a wallet-signing API (wagmi's signTypedData) or
// submit the paid HTTP request. It sits strictly above
// x402-confirmation.ts (LOCKED — this module takes a
// READY_FOR_CONFIRMATION state as an input, it does not re-derive it),
// mirroring agent-action-execution.ts's own relationship to
// agent-action-confirmation.ts exactly.
//
// EXECUTION MUST NOT HAPPEN AUTOMATICALLY. executeX402Payment() below is
// only ever meant to be invoked from an explicit "Confirm & Pay" click —
// see hooks/useX402Payment.ts for the one legitimate call site. Nothing
// in this module calls itself from a mount, an effect, or a promise
// continuation.
//
// STATE MACHINE:
//
//   IDLE -> READY_FOR_CONFIRMATION -> AWAITING_SIGNATURE -> SIGNED -> SUBMITTING -> SETTLED
//                                                                              \-> ERROR
//
// GATES — checked in this exact order, before signTypedData is called:
//   1. this proposal is not already executing (dedupe, module-level Set)
//   2. a connected wallet account exists
//   3. the confirmation state passed in is READY_FOR_CONFIRMATION
//   4. the current chain is the one x402 payments are configured for
// If any gate fails, signTypedData/fetch is never called.
//
// The LLM never reaches this module directly — it is not registered as
// an AgentTool at all (AgentToolRuntime unconditionally refuses
// "execute"-mode tools regardless; this module isn't even reachable
// through that path — see x402-tool-definitions.ts, which only
// registers "read"/"prepare" tools).
//
// The signed X-PAYMENT header is submitted through same-origin
// POST /api/x402/submit so the browser never issues a cross-origin
// request that requires an Access-Control-Allow-Headers: x-payment
// preflight on the resource server.

import { isAddress, type Address } from "viem";
import { signTypedData } from "wagmi/actions";

import { config } from "@/lib/wagmi";
import { X402_CHAIN_ID } from "./x402-config";
import { buildAuthorizationTypedData } from "./x402-authorization";
import { classifyX402ResourceResponse } from "./x402-verification";
import type { X402ConfirmationState } from "./x402-confirmation";
import type { X402PaymentProposal } from "./x402-proposal";
import type { X402Error, X402ErrorCode, X402PaymentPayload, X402SettlementResponse } from "./x402-types";

const X402_SUBMIT_API_PATH = "/api/x402/submit";
const X402_REGISTER_API_PATH = "/api/x402/register";

export const X402_EXECUTION_STATES = [
  "IDLE",
  "READY_FOR_CONFIRMATION",
  "AWAITING_SIGNATURE",
  "SIGNED",
  "SUBMITTING",
  "SETTLED",
  "ERROR",
] as const;
export type X402ExecutionState = (typeof X402_EXECUTION_STATES)[number];

export interface X402ExecutionSnapshot {
  state: X402ExecutionState;
  settlement: X402SettlementResponse | null;
  error: X402Error | null;
}

export function idleX402ExecutionSnapshot(): X402ExecutionSnapshot {
  return { state: "IDLE", settlement: null, error: null };
}

function errorSnapshot(code: X402ErrorCode, message: string): X402ExecutionSnapshot {
  return { state: "ERROR", settlement: null, error: { code, message } };
}

export interface ExecuteX402PaymentInput {
  proposal: X402PaymentProposal;
  confirmationState: X402ConfirmationState;
  currentAccount: Address | null | undefined;
  currentChainId: number | null | undefined;
}

type GateResult = { ok: true } | { ok: false; error: X402Error };

function checkGates(input: ExecuteX402PaymentInput): GateResult {
  if (!input.currentAccount || !isAddress(input.currentAccount)) {
    return { ok: false, error: { code: "WALLET_REQUIRED", message: "Connect your wallet to pay for this resource." } };
  }
  if (input.confirmationState !== "READY_FOR_CONFIRMATION") {
    return {
      ok: false,
      error: { code: "VERIFICATION_FAILED", message: "This payment has not been validated yet — nothing was signed or sent." },
    };
  }
  if (input.currentChainId !== X402_CHAIN_ID) {
    return {
      ok: false,
      error: { code: "UNSUPPORTED_NETWORK", message: `Switch to Base Mainnet (chainId ${X402_CHAIN_ID}) to pay this resource.` },
    };
  }
  return { ok: true };
}

function classifySignError(err: unknown): X402Error {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("user rejected") || lower.includes("user denied") || lower.includes("request rejected")) {
    return { code: "WALLET_REJECTED", message: "Payment authorization was cancelled in your wallet." };
  }
  return { code: "SIGNING_FAILED", message: "Your wallet was unable to sign this payment authorization." };
}

function looksLikeSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("x-payment") ||
    lower.includes("signature") ||
    lower.includes("private key") ||
    lower.includes("seed phrase") ||
    lower.includes("mnemonic")
  );
}

function classifySubmitRouteError(
  status: number,
  payload: { error?: unknown; code?: unknown } | null,
): X402Error {
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (code === "UNSUPPORTED_NETWORK") {
    return { code: "UNSUPPORTED_NETWORK", message: "Only Base Mainnet payments can be submitted." };
  }
  if (code === "REQUIREMENT_CHANGED") {
    return {
      code: "REQUIREMENT_CHANGED",
      message: "This payment no longer matches the confirmed requirement — nothing was submitted.",
    };
  }
  if (code === "UNSUPPORTED_ASSET") {
    return { code: "UNSUPPORTED_ASSET", message: "This payment asset is not recognized." };
  }

  const rawMessage = typeof payload?.error === "string" ? payload.error.trim() : "";
  const safeMessage =
    rawMessage.length > 0 &&
    rawMessage.length <= 200 &&
    !looksLikeSecret(rawMessage)
      ? rawMessage
      : "Could not submit this payment to the resource.";

  return {
    code: "SUBMISSION_FAILED",
    message: status > 0 ? `${safeMessage} (HTTP ${status})` : safeMessage,
  };
}

// Duplicate-execution protection, mirroring agent-action-execution.ts's
// actionsInFlight — one proposal cannot reach signTypedData/fetch twice
// concurrently, even from two separate callers/hooks.
const proposalsInFlight = new Set<string>();

/**
 * Signs and submits an already-validated, already-confirmed
 * X402PaymentProposal. This function is the only place in the x402
 * stack allowed to call signTypedData. The paid resource fetch is
 * performed by same-origin /api/x402/submit.
 */
export async function executeX402Payment(
  input: ExecuteX402PaymentInput,
  onTransition: (snapshot: X402ExecutionSnapshot) => void
): Promise<X402ExecutionSnapshot> {
  const { proposal } = input;

  if (proposalsInFlight.has(proposal.id)) {
    const snapshot = errorSnapshot("EXECUTION_IN_PROGRESS", "This payment is already being processed — please wait for it to finish.");
    onTransition(snapshot);
    return snapshot;
  }

  const gate = checkGates(input);
  if (!gate.ok) {
    const snapshot: X402ExecutionSnapshot = { state: "ERROR", settlement: null, error: gate.error };
    onTransition(snapshot);
    return snapshot;
  }

  const payerAddress = input.currentAccount as Address;
  proposalsInFlight.add(proposal.id);

  try {
    onTransition({ state: "AWAITING_SIGNATURE", settlement: null, error: null });

    let registrationId: string;
    let eip712Name: string | undefined;
    let eip712Version: string | undefined;
    try {
      const registerResponse = await fetch(X402_REGISTER_API_PATH, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          requirement: {
            resource: proposal.requirement.resource,
            scheme: proposal.requirement.scheme,
            network: proposal.requirement.network,
            asset: proposal.requirement.asset,
            maxAmountRequired: proposal.requirement.maxAmountRequired,
            payTo: proposal.requirement.payTo,
            maxTimeoutSeconds: proposal.requirement.maxTimeoutSeconds,
          },
        }),
      });
      const registerPayload = (await registerResponse.json().catch(() => null)) as
        | {
            registrationId?: unknown;
            eip712Name?: unknown;
            eip712Version?: unknown;
            error?: unknown;
            code?: unknown;
          }
        | null;
      if (!registerResponse.ok || typeof registerPayload?.registrationId !== "string") {
        const snapshot: X402ExecutionSnapshot = {
          state: "ERROR",
          settlement: null,
          error: classifySubmitRouteError(registerResponse.status, registerPayload),
        };
        onTransition(snapshot);
        return snapshot;
      }
      registrationId = registerPayload.registrationId;
      eip712Name = typeof registerPayload.eip712Name === "string" ? registerPayload.eip712Name : undefined;
      eip712Version = typeof registerPayload.eip712Version === "string" ? registerPayload.eip712Version : undefined;
    } catch {
      const snapshot: X402ExecutionSnapshot = {
        state: "ERROR",
        settlement: null,
        error: {
          code: "SUBMISSION_FAILED",
          message: "Could not register this payment before signing. Nothing was signed.",
        },
      };
      onTransition(snapshot);
      return snapshot;
    }

    const proposalForSigning =
      eip712Name && eip712Version
        ? {
            ...proposal,
            eip712Domain: {
              domain: { name: eip712Name, version: eip712Version },
              source: "known-asset-registry" as const,
            },
          }
        : proposal;

    const typedData = buildAuthorizationTypedData(proposalForSigning, {
      payerAddress,
      chainId: X402_CHAIN_ID,
    });

    let signature: `0x${string}`;
    try {
      signature = await signTypedData(config, {
        account: payerAddress,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
    } catch (err) {
      const classified = classifySignError(err);
      const snapshot: X402ExecutionSnapshot = { state: "ERROR", settlement: null, error: classified };
      onTransition(snapshot);
      return snapshot;
    }

    onTransition({ state: "SIGNED", settlement: null, error: null });

    const payload: X402PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: proposal.requirement.network,
      payload: {
        signature,
        authorization: {
          from: typedData.message.from,
          to: typedData.message.to,
          value: typedData.message.value.toString(),
          validAfter: typedData.message.validAfter.toString(),
          validBefore: typedData.message.validBefore.toString(),
          nonce: typedData.message.nonce,
        },
      },
    };

    const xPaymentHeader = base64EncodeJson(payload);

    onTransition({ state: "SUBMITTING", settlement: null, error: null });

    let response: Response;
    try {
      response = await fetch(X402_SUBMIT_API_PATH, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          registrationId,
          xPayment: xPaymentHeader,
        }),
      });
    } catch {
      const snapshot: X402ExecutionSnapshot = {
        state: "ERROR",
        settlement: null,
        error: {
          code: "SUBMISSION_FAILED",
          message: "Could not reach the payment submission endpoint. This may be temporary.",
        },
      };
      onTransition(snapshot);
      return snapshot;
    }

    const routePayload = (await response.json().catch(() => null)) as
      | {
          status?: unknown;
          paymentResponse?: unknown;
          error?: unknown;
          code?: unknown;
        }
      | null;

    if (!response.ok) {
      const snapshot: X402ExecutionSnapshot = {
        state: "ERROR",
        settlement: null,
        error: classifySubmitRouteError(response.status, routePayload),
      };
      onTransition(snapshot);
      return snapshot;
    }

    const upstreamStatus =
      typeof routePayload?.status === "number" ? routePayload.status : 0;
    const paymentResponse =
      typeof routePayload?.paymentResponse === "string"
        ? routePayload.paymentResponse
        : null;

    const outcome = classifyX402ResourceResponse(upstreamStatus, paymentResponse);
    if (!outcome.ok) {
      const snapshot: X402ExecutionSnapshot = { state: "ERROR", settlement: null, error: outcome.error };
      onTransition(snapshot);
      return snapshot;
    }

    const settledSnapshot: X402ExecutionSnapshot = { state: "SETTLED", settlement: outcome.settlement, error: null };
    onTransition(settledSnapshot);
    return settledSnapshot;
  } finally {
    proposalsInFlight.delete(proposal.id);
  }
}

function base64EncodeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof btoa === "function") return btoa(json);
  return Buffer.from(json, "utf-8").toString("base64");
}
