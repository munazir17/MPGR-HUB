// V2 settlement verification.
//
// This is the receipt half of the V2 journey. The client supplies ONLY a
// transaction hash; the server re-fetches the transaction and receipt from Base
// itself, so a forged or stale receipt can never be promoted to "verified".
//
// The intent is re-derived from the MINED calldata (not from anything the client
// asserts), fee terms are read live from the executor at the mined block, and the
// receipt's own events are then checked against that intent. Read-only: nothing
// here signs, sends or mutates state, and a failure never triggers a resubmit.
//
// DORMANT while `V2_DEPLOYMENT` is null: returns V2_NOT_ACTIVATED and verifies
// nothing, because no V2 transaction can exist to verify.
import { NextResponse } from "next/server";
import { decodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { SWAP_V2_ABI } from "@/lib/swap/v2/abi";
import { swapV2Executor, SWAP_V2_CHAIN_ID, SWAP_V2_WETH } from "@/lib/swap/v2/deployment";
import { inspectV2SwapTransaction } from "@/lib/swap/v2/intent";
import { verifyV2Posture, V2PreflightError } from "@/lib/swap/v2/preflight";
import { verifyV2Receipt } from "@/lib/swap/v2/settlement";
import { accountCallsFromTransaction, isEntryPointAddress, stripAttributionSuffixes } from "@/lib/swap/swap-mined-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH = /^0x[0-9a-f]{64}$/i;

export async function POST(request: Request) {
  const reply = (value: unknown, status = 200) =>
    NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const origin = verifyTrustedOrigin(request); if (origin) return origin;
  const session = await authenticateRequest(request); if (!session) return reply({ code: "AUTH_REQUIRED" }, 401);
  for (const key of [`${session.wallet.toLowerCase()}:trade-settle`, `${clientIpFromRequest(request)}:trade-settle:ip`]) {
    if (!(await checkRateLimit(key, 30, 60_000)).allowed) return reply({ code: "RATE_LIMITED" }, 429);
  }
  const read = await readJsonBody(request); if (!read.ok) return read.response;
  const body = (read.value ?? {}) as Record<string, unknown>;
  const hash = typeof body.transactionHash === "string" ? body.transactionHash : "";
  if (!HASH.test(hash)) return reply({ code: "INVALID_INPUT", error: "A 32-byte transaction hash is required." }, 400);

  // The gate. Dormant means no V2 transaction exists to verify — say so plainly
  // rather than returning an unverified result that could be read as a failure.
  const deployment = swapV2Executor();
  if (!deployment) {
    return reply({
      code: "V2_NOT_ACTIVATED",
      verified: false,
      error: "MPGR Swap V2 routing is not activated, so no V2 settlement can be verified.",
    }, 409);
  }

  const wallet = session.wallet.toLowerCase();
  try {
    const client = getTradePublicClient();
    if (await client.getChainId() !== SWAP_V2_CHAIN_ID) return reply({ code: "PROVIDER_ERROR" }, 503);

    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: hash as Hex }),
      client.getTransactionReceipt({ hash: hash as Hex }),
    ]);

    // Attribute strictly. A direct send is one call from tx.from. A Coinbase
    // Smart Wallet bundle is a bundler calling EntryPoint; the taker is the
    // userOp sender and the ETH value is the inner call value, not tx.value.
    // Exactly one call from the signed-in wallet is accepted. A builder-code
    // suffix is stripped only after the wrapper ABI has been decoded.
    const calls = accountCallsFromTransaction({ from: tx.from, to: tx.to, input: tx.input, value: tx.value });
    if (isEntryPointAddress(tx.to) && calls.length === 0) {
      return reply({ code: "UNDECODABLE_CALLDATA", verified: false, error: "The mined calldata is not V2 executor calldata." }, 422);
    }
    const mine = calls.filter((call) => call.from.toLowerCase() === wallet);
    if (mine.length === 0) {
      return reply({ code: "NOT_YOUR_TRANSACTION", verified: false, error: "That transaction was not sent by the signed-in wallet." }, 403);
    }
    if (mine.length !== 1) {
      return reply({ code: "NOT_SINGLE_SWAP", verified: false, error: "That transaction is not a single swap from the signed-in wallet." }, 422);
    }
    const call = mine[0];
    if (call.to.toLowerCase() !== deployment.executor.toLowerCase()) {
      return reply({ code: "NOT_V2_EXECUTOR", verified: false, error: "That transaction does not target the MPGR V2 executor." }, 422);
    }
    if (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) {
      return reply({ code: "PROVIDER_ERROR", verified: false, error: "The receipt does not match the submitted transaction." }, 503);
    }
    if (receipt.blockNumber === null || !receipt.blockHash) {
      return reply({ code: "PROVIDER_ERROR", verified: false, error: "The receipt is not anchored to a mined block yet." }, 503);
    }

    const minedData = stripAttributionSuffixes(call.data);
    // Decode the MINED account-call calldata to learn what was actually executed.
    // Native-in is the inner call value: a userOp's outer transaction value is
    // often zero even when the swap sends ETH.
    let decoded: { functionName: string; args: unknown };
    try {
      decoded = decodeFunctionData({ abi: SWAP_V2_ABI, data: minedData }) as { functionName: string; args: unknown };
    } catch {
      return reply({ code: "UNDECODABLE_CALLDATA", verified: false, error: "The mined calldata is not V2 executor calldata." }, 422);
    }
    const params = (Array.isArray(decoded.args) ? decoded.args[0] : undefined) as
      | { tokenIn?: Address; tokenOut?: Address; unwrapNativeOut?: boolean }
      | undefined;
    const minedIn = params?.tokenIn;
    const minedOut = params?.tokenOut;
    if (!minedIn || !minedOut || !isAddress(minedIn) || !isAddress(minedOut)) {
      return reply({ code: "UNDECODABLE_CALLDATA", verified: false, error: "The mined calldata carries no readable V2 swap parameters." }, 422);
    }

    const nativeIn = call.value > 0n;
    const nativeOut = params.unwrapNativeOut === true;

    // Read the fee terms LIVE at the mined block. Settlement must be judged
    // against the fee the executor actually governed then, not a hardcoded 25.
    let feeBps: number; let feeRecipient: Address;
    try {
      const posture = await verifyV2Posture(client as never, deployment, receipt.blockNumber);
      feeBps = posture.feeBps; feeRecipient = posture.feeRecipient;
    } catch (error) {
      if (error instanceof V2PreflightError) return reply({ code: error.code, verified: false, error: error.message }, error.status);
      return reply({ code: "ROUTE_VERIFICATION_UNAVAILABLE", verified: false, error: "Executor posture could not be read at the mined block." }, 503);
    }

    const inspected = inspectV2SwapTransaction(
      { to: call.to, data: minedData, value: call.value },
      {
        deployment, taker: call.from, feeBps, feeRecipient,
        // The mined calldata is the source of truth for the executed pair.
        fromAddress: nativeIn ? SWAP_V2_WETH : minedIn,
        toAddress: nativeOut ? SWAP_V2_WETH : minedOut,
        nativeIn, nativeOut,
      },
    );
    if (!inspected.ok) {
      return reply({ code: "INTENT_MISMATCH", verified: false, error: `The mined V2 calldata failed independent inspection: ${inspected.reason}` }, 422);
    }
    // The output must have gone to the wallet that sent it.
    if (inspected.value.recipient.toLowerCase() !== wallet) {
      return reply({ code: "RECIPIENT_MISMATCH", verified: false, error: "The swap output was not addressed to the signed-in wallet." }, 422);
    }

    const proof = verifyV2Receipt(inspected.value, {
      status: receipt.status,
      logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data })),
      transactionHash: receipt.transactionHash,
    }, deployment);

    if (!proof.verified) {
      return reply({
        code: receipt.status === "success" ? "SETTLEMENT_UNVERIFIED" : "TRANSACTION_REVERTED",
        verified: false,
        error: proof.reason ?? "Settlement could not be verified. Do not resubmit; inspect the transaction on BaseScan.",
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
      }, 422);
    }

    return reply({
      code: "SETTLED",
      verified: true,
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      intentId: inspected.value.intentId,
      entry: proof.entry,
      hops: proof.hops,
      amountIn: proof.amountIn,
      amountOut: proof.amountOut,
      feeAmount: proof.feeAmount,
      feeBps: proof.feeBps,
      feeRecipient: proof.feeRecipient,
      // Honest scope: this proves the mined swap and its fee event. It is not a
      // balance-custody audit and not proof about any other transaction.
      note: "Verified from the mined receipt against the committed minimum and the actual fee event. Simulation was never a settlement proof; this is.",
    });
  } catch {
    return reply({ code: "PROVIDER_ERROR", verified: false, error: "Base could not confirm that transaction yet. Check status; do not resubmit." }, 503);
  }
}
