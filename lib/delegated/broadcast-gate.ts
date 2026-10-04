// lib/delegated/broadcast-gate.ts
//
// THE BOUNDED HOT WALLET (audit MC-2 remediation).
//
// A mainnet delegated execution requires an OPERATOR gas-payer account: the
// user's key never reaches the server, and the deployed v1 MPGRExecutor pulls
// tokens only from msg.sender, so it cannot execute for a user. That operator
// account is a mainnet hot wallet, and an unrestricted one would be a real
// security regression. It is therefore bounded STRUCTURALLY, before signing:
//
//   this module re-decodes the exact calldata the operator key is about to
//   sign and re-verifies every signed field against the user's own witness.
//
// If any field disagrees, there is no signature and no broadcast. The operator
// key can consequently only ever pay gas for a transaction that is exactly what
// the user authorized: a single delegated swap, to the pinned executor, whose
// recipient is the user, whose intentId/deadline/minAmountOut/buyToken equal
// the witness, carrying no native value.
//
// This is defence-in-depth ON TOP OF the on-chain `_validate` (which already
// re-checks the same bindings and reverts otherwise). The difference is that
// on-chain enforcement costs gas and reveals the attempt; this gate refuses
// before anything is signed, and keeps the operator key from being usable for
// anything else at all.
//
// Pure module: no I/O, no clock reads (time is injected), fully unit-testable.

import { decodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";

import {
  DELEGATED_EXECUTOR_ABI,
  DELEGATED_EXECUTOR_FEE_BPS,
  DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR,
  DELEGATED_SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR,
  delegatedExecutorAddressFor,
  isDelegatedChainId,
  type DecodedDelegatedAuthorization,
  type DecodedDelegatedSwapParams,
  type DelegatedActionWitness,
  type DelegatedPermit,
} from "@/lib/executor/delegated-executor";

/** What the gate was asked to broadcast. `value` defaults to 0n. */
export interface GateTransaction {
  to: Address;
  data: Hex;
  chainId: number;
  value?: bigint;
}

/** The user's authorization this transaction must match exactly. */
export interface GateAuthorization {
  /** Permit2 witness payload (owner, buyToken, minAmountOut, deadline, actionId, policyHash). */
  witness: DelegatedActionWitness;
  /** The Permit2 permission the user signed. */
  permit: DelegatedPermit;
  /** The policy wallet the goal is bound to. */
  wallet: Address;
}

export type BroadcastGateVerdict =
  | { allowed: true; selector: Hex; functionName: string; params: DecodedDelegatedSwapParams }
  | { allowed: false; reason: string; detail?: string };

/** The two delegated entrypoints are the ONLY functions the operator may sign. */
const ALLOWED_FUNCTION_NAMES = new Set(["swapOnBehalfOfUniswapV3", "swapOnBehalfOfSlipstream"]);

function addr(a: string): string {
  return (isAddress(a) ? getAddress(a) : a).toLowerCase();
}

function big(v: string | number | bigint): bigint | null {
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Structurally validate a transaction against the user's authorization.
 *
 * Returns `{ allowed: false, reason }` for every disagreement — the caller MUST
 * refuse. Never throws for a rejected transaction: throwing would make a
 * refusal look like an infrastructure fault.
 */
export function validateDelegatedTransaction(tx: GateTransaction, auth: GateAuthorization, now: Date): BroadcastGateVerdict {
  const refuse = (reason: string, detail?: string): BroadcastGateVerdict => ({ allowed: false, reason, detail });

  // 1. CHAIN: must be a delegated chain.
  if (!isDelegatedChainId(tx.chainId)) return refuse("CHAIN_UNSUPPORTED", `chain ${tx.chainId}`);

  // 2. EXECUTOR: must be the pinned delegated executor for that chain. This is
  //    what stops the operator key from being pointed at an arbitrary contract.
  const expectedExecutor = delegatedExecutorAddressFor(tx.chainId);
  if (!expectedExecutor) return refuse("EXECUTOR_NOT_CONFIGURED", `chain ${tx.chainId}`);
  if (!isAddress(tx.to)) return refuse("TO_INVALID");
  if (addr(tx.to) !== addr(expectedExecutor)) return refuse("EXECUTOR_MISMATCH", `to=${tx.to} expected=${expectedExecutor}`);

  // 3. NO NATIVE VALUE: both entrypoints revert on msg.value != 0 anyway; we
  //    refuse here so the operator key never signs value-carrying calldata.
  const value = tx.value ?? 0n;
  if (typeof value !== "bigint" || value !== 0n) return refuse("NATIVE_VALUE_UNSUPPORTED", `value=${String(value)}`);

  // 4. SELECTOR: exactly one of the two delegated swap entrypoints.
  if (typeof tx.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(tx.data) || tx.data.length < 10) return refuse("DATA_INVALID");
  const selector = tx.data.slice(0, 10).toLowerCase() as Hex;
  if (selector !== DELEGATED_SWAP_ON_BEHALF_OF_UNISWAP_V3_SELECTOR && selector !== DELEGATED_SWAP_ON_BEHALF_OF_SLIPSTREAM_SELECTOR) {
    return refuse("SELECTOR_NOT_ALLOWED", selector);
  }

  // 5. DECODE: must decode cleanly against the delegated ABI.
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: DELEGATED_EXECUTOR_ABI, data: tx.data }) as { functionName: string; args: readonly unknown[] };
  } catch (error) {
    return refuse("DECODE_FAILED", error instanceof Error ? error.message : "unknown");
  }
  if (!ALLOWED_FUNCTION_NAMES.has(decoded.functionName)) return refuse("FUNCTION_NOT_ALLOWED", decoded.functionName);

  const params = decoded.args[0] as DecodedDelegatedSwapParams | undefined;
  const decodedAuth = decoded.args[2] as DecodedDelegatedAuthorization | undefined;
  if (!params || typeof params !== "object") return refuse("PARAMS_MISSING");
  if (!decodedAuth || typeof decodedAuth !== "object" || !decodedAuth.witness) return refuse("AUTH_MISSING");
  const w = decodedAuth.witness;

  // The user's signed authorization, normalized to the decoded shape.
  const wantOwner = addr(auth.witness.owner);
  const wantBuy = addr(auth.witness.buyToken);
  const wantMinOut = big(auth.witness.minAmountOut);
  const wantDeadline = big(auth.witness.deadline);
  const wantActionId = auth.witness.actionId.toLowerCase() as Hex;
  const wantPolicyHash = auth.witness.policyHash.toLowerCase() as Hex;
  if (wantMinOut === null || wantDeadline === null) return refuse("AUTHORIZATION_MALFORMED");

  // 6. WITNESS == THE USER'S AUTHORIZATION. Every signed field must match what
  //    the user actually authorized; otherwise the operator would be paying gas
  //    for a trade the user never signed.
  if (addr(w.owner) !== wantOwner) return refuse("WITNESS_OWNER_MISMATCH", `${w.owner} vs ${auth.witness.owner}`);
  if (addr(w.buyToken) !== wantBuy) return refuse("WITNESS_BUY_TOKEN_MISMATCH", `${w.buyToken} vs ${auth.witness.buyToken}`);
  if (w.minAmountOut !== wantMinOut) return refuse("WITNESS_MIN_OUT_MISMATCH", `${w.minAmountOut} vs ${wantMinOut}`);
  if (w.deadline !== wantDeadline) return refuse("WITNESS_DEADLINE_MISMATCH", `${w.deadline} vs ${wantDeadline}`);
  if (w.actionId.toLowerCase() !== wantActionId) return refuse("WITNESS_ACTION_ID_MISMATCH", `${w.actionId} vs ${wantActionId}`);
  if (w.policyHash.toLowerCase() !== wantPolicyHash) return refuse("WITNESS_POLICY_HASH_MISMATCH", `${w.policyHash} vs ${wantPolicyHash}`);

  // 7. OWNER == THE POLICY WALLET. The user can only ever be the recipient of
  //    their own authorization; the operator can never redirect funds.
  if (wantOwner !== addr(auth.wallet)) return refuse("OWNER_NOT_POLICY_WALLET", `${wantOwner} vs ${auth.wallet}`);

  // 8. PARAMS == WITNESS. The unsigned swap params must agree with the signed
  //    witness (the contract enforces the same, but we refuse pre-sign). Note
  //    the contract's field is `amountOutMinimum`, the witness's `minAmountOut`.
  if (addr(params.recipient) !== wantOwner) return refuse("RECIPIENT_NOT_OWNER", `${params.recipient} vs ${auth.witness.owner}`);
  if (params.intentId.toLowerCase() !== wantActionId) return refuse("INTENT_ID_MISMATCH", `${params.intentId} vs ${wantActionId}`);
  if (params.deadline !== wantDeadline) return refuse("PARAM_DEADLINE_MISMATCH", `${params.deadline} vs ${wantDeadline}`);
  if (params.amountOutMinimum !== wantMinOut) return refuse("PARAM_MIN_OUT_MISMATCH", `${params.amountOutMinimum} vs ${wantMinOut}`);
  // SwapParams has no `buyToken` field: `tokenOut` IS the buy token, and the
  // contract re-checks tokenOut == witness.buyToken in _validate.
  if (addr(params.tokenOut) !== wantBuy) return refuse("TOKEN_OUT_MISMATCH", `${params.tokenOut} vs ${auth.witness.buyToken}`);

  // 9. PERMIT == EXACTLY WHAT THE USER LET THE OPERATOR PULL.
  //
  //    Permit2's TokenPermissions describes the SELL side — the token and
  //    amount taken FROM the user — while the witness floors the BUY side
  //    (buyToken / minAmountOut). Together they are the two economic bounds the
  //    user actually signed: "pull at most THIS much of THIS token, and I must
  //    receive at least THAT much of THAT token."
  //
  //    So the permit must equal params.tokenIn / params.grossAmountIn (NOT the
  //    witness buyToken/minAmountOut), and the calldata's own permit tuple must
  //    equal the stored authorization's — otherwise the operator would be
  //    pulling a different token, or more of it, than the user authorized.
  const permitAmount = big(auth.permit.amount);
  const permitDeadline = big(auth.permit.deadline);
  if (permitAmount === null || permitDeadline === null) return refuse("PERMIT_MALFORMED");
  if (addr(auth.permit.token) !== addr(params.tokenIn)) {
    return refuse("PERMIT_TOKEN_MISMATCH", `${auth.permit.token} vs tokenIn ${params.tokenIn}`);
  }
  if (permitAmount !== params.grossAmountIn) {
    return refuse("PERMIT_AMOUNT_MISMATCH", `${permitAmount} vs grossAmountIn ${params.grossAmountIn}`);
  }
  if (permitDeadline !== wantDeadline) return refuse("PERMIT_DEADLINE_MISMATCH", `${permitDeadline} vs ${wantDeadline}`);
  if (addr(decodedAuth.permit.permitted.token) !== addr(params.tokenIn)) {
    return refuse("CALLDATA_PERMIT_TOKEN_MISMATCH", `${decodedAuth.permit.permitted.token} vs ${params.tokenIn}`);
  }
  if (decodedAuth.permit.permitted.amount !== params.grossAmountIn) {
    return refuse("CALLDATA_PERMIT_AMOUNT_MISMATCH", `${decodedAuth.permit.permitted.amount} vs ${params.grossAmountIn}`);
  }
  if (decodedAuth.permit.deadline !== wantDeadline) return refuse("CALLDATA_PERMIT_DEADLINE_MISMATCH");
  // The stored permit and the calldata permit must be the same permission.
  if (addr(decodedAuth.permit.permitted.token) !== addr(auth.permit.token)) return refuse("PERMIT_TOKEN_DIVERGENCE");
  if (decodedAuth.permit.permitted.amount !== permitAmount) return refuse("PERMIT_AMOUNT_DIVERGENCE");

  // 10. AMOUNT BOUNDS: never zero, never negative, and the committed fee must
  //     be exactly the canonical floor(gross * feeBps / 1e4) the contract
  //     re-derives — a mismatch would mean the calldata was rebuilt with
  //     different fee math than the quote the user's slot was validated against.
  if (params.grossAmountIn <= 0n) return refuse("GROSS_AMOUNT_IN_NON_POSITIVE", `${params.grossAmountIn}`);
  if (wantMinOut <= 0n) return refuse("MIN_AMOUNT_OUT_NON_POSITIVE", `${wantMinOut}`);
  const canonicalFee = (params.grossAmountIn * BigInt(DELEGATED_EXECUTOR_FEE_BPS)) / 10_000n;
  if (params.expectedFeeAmount !== canonicalFee) {
    return refuse("FEE_MISMATCH", `${params.expectedFeeAmount} vs canonical ${canonicalFee}`);
  }

  // 11. DEADLINE IN THE FUTURE. A lapsed authorization is refused pre-sign,
  //     never broadcast to be reverted on-chain (wasting operator gas).
  if (wantDeadline * 1000n <= BigInt(now.getTime())) return refuse("DEADLINE_PASSED", `${wantDeadline}`);

  return { allowed: true, selector, functionName: decoded.functionName, params };
}
