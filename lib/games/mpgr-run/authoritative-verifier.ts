import { createHash } from "node:crypto";
import type { Address } from "viem";
import type { RunResult } from "./run-score";
import type { RunInputTrace } from "./input-trace";
import {
  replayAuthoritativeRun,
} from "./authoritative-replay";

export interface AuthoritativeVerificationResult {
  verified: boolean;
  proofId?: string;
  reason?: string;
}

export function verifyAuthoritativeRun(input: {
  sessionId: string;
  wallet: Address;
  result: RunResult;
  inputTrace: RunInputTrace;
  seed: string;
  protocolVersion: number;
  sessionCreatedAt: string;
  sessionExpiresAt: string;
}): AuthoritativeVerificationResult {
  if (input.protocolVersion !== 1) {
    return { verified: false, reason: "Unsupported game protocol version." };
  }

  const replay = replayAuthoritativeRun({
    seed: input.seed,
    inputTrace: input.inputTrace,
    result: input.result,
  });

  if (!replay.verified) return replay;

  const proofMaterial = JSON.stringify({
    version: 1,
    sessionId: input.sessionId,
    wallet: input.wallet.toLowerCase(),
    seed: input.seed.toLowerCase(),
    protocolVersion: input.protocolVersion,
    sessionCreatedAt: input.sessionCreatedAt,
    sessionExpiresAt: input.sessionExpiresAt,
    inputTrace: input.inputTrace,
    result: input.result,
  });

  const proofId = createHash("sha256")
    .update(proofMaterial)
    .digest("hex");

  return {
    verified: true,
    proofId,
  };
}
