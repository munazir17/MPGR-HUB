import type { Address } from "viem";
import type { RunResult } from "./run-score";
import type { RunInputTrace } from "./input-trace";

export interface AuthoritativeVerificationResult {
  verified: boolean;
  proofId?: string;
  reason?: string;
}

const VERIFIER_TIMEOUT_MS = 5_000;

function getVerifierUrl(): string | null {
  const value = process.env.GAME_RUN_VERIFIER_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The competitive game is client-rendered, so the application server cannot
 * independently reconstruct every frame/input. Real-value rewards therefore
 * require an independent verifier to attest to the submitted run.
 *
 * Fail-closed: missing verifier configuration, verifier errors, malformed
 * responses, or a negative attestation never become a valid run.
 */
export async function verifyAuthoritativeRun(input: {
  sessionId: string;
  wallet: Address;
  result: RunResult;
    inputTrace: RunInputTrace;
    seed: string;
    protocolVersion: number;
  sessionCreatedAt: string;
  sessionExpiresAt: string;
}): Promise<AuthoritativeVerificationResult> {
  const url = getVerifierUrl();
  const secret = process.env.GAME_RUN_VERIFIER_SECRET?.trim();
  if (!url || !secret) {
    return { verified: false, reason: "Authoritative game verifier is not configured." };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(VERIFIER_TIMEOUT_MS),
      body: JSON.stringify({
        version: 1,
        sessionId: input.sessionId,
        wallet: input.wallet,
        sessionCreatedAt: input.sessionCreatedAt,
        sessionExpiresAt: input.sessionExpiresAt,
          seed: input.seed,
          protocolVersion: input.protocolVersion,
          inputTrace: input.inputTrace,
        result: input.result,
      }),
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      return { verified: false, reason: "Authoritative verifier rejected the request." };
    }

    const body: unknown = await response.json();
    if (!body || typeof body !== "object") {
      return { verified: false, reason: "Authoritative verifier returned an invalid response." };
    }

    const record = body as Record<string, unknown>;
    if (record.verified !== true) {
      return { verified: false, reason: "Run was not authoritatively verified." };
    }

    if (typeof record.proofId !== "string" || record.proofId.length < 8 || record.proofId.length > 256) {
      return { verified: false, reason: "Authoritative verifier returned no valid proof identifier." };
    }

    return { verified: true, proofId: record.proofId };
  } catch {
    return { verified: false, reason: "Authoritative verifier is unavailable." };
  }
}
