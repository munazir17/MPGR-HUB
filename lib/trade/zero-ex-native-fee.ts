import "server-only";

// lib/trade/zero-ex-native-fee.ts
//
// 0x Swap API v2 (AllowanceHolder) with the NATIVE integrator fee, for the
// MCP / agent path on Base mainnet. Kept separate from trade-0x-client.ts so
// existing UI swap flows are untouched.
//
// Docs (monetize-your-app-using-swap):
//   swapFeeRecipient, swapFeeBps (0..1000), swapFeeToken (must be sell or buy
//   token). If swapFeeToken is omitted 0x MAY take the fee in the BUY token,
//   so we ALWAYS pin it to the SELL token.
//   Response: fees.integratorFee = { amount, token, type } in sell-token base units.
//
// Safety: the quote is REJECTED unless the integrator fee is EXACTLY
// floor(sellAmount * 25 / 10000) of the sell token, the echoed sellAmount
// equals the request, and both the allowance spender and the transaction
// target are the 0x AllowanceHolder (never Settler). One tx: fee + swap.

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { ZERO_EX_API_HOST, ZERO_EX_QUOTE_PATH, ZERO_EX_REQUEST_TIMEOUT_MS } from "./trade-config";

/** 0x AllowanceHolder on Cancun-hardfork chains incl. Base (0x cheat sheet). */
export const ZERO_EX_ALLOWANCE_HOLDER_BASE: Address = "0x0000000000001fF3684f28c67538d4D072C22734";
export const ZERO_EX_NATIVE_FEE_BPS = 25;
export const ZERO_EX_BASE_CHAIN_ID = 8453;

export interface ZeroExNativeFeeRequest {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps: number;
  feeRecipient: Address;
}

export interface ZeroExNativeFeeQuote {
  provider: "0x-allowance-holder-native-fee";
  chainId: 8453;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  feeBps: number;
  feeAmount: string;
  feeToken: Address;
  feeRecipient: Address;
  spender: Address;
  currentAllowance: string | null;
  transaction: { to: Address; data: Hex; value: string; gas?: string };
  route: { source: string; proportionBps: string }[];
}

export type ZeroExNativeFeeResult =
  | { ok: true; value: ZeroExNativeFeeQuote }
  | { ok: false; error: { code: string; message: string } };

type Fetcher = typeof fetch;

function readKey(): string | null {
  const key = process.env.ZERO_EX_API_KEY?.trim() || process.env.ZEROX_API_KEY?.trim() || null;
  return key && key.length > 0 ? key : null;
}

export function expectedIntegratorFee(sellAmount: bigint, feeBps = ZERO_EX_NATIVE_FEE_BPS): bigint {
  return (sellAmount * BigInt(feeBps)) / 10_000n;
}

export function buildZeroExNativeFeeParams(req: ZeroExNativeFeeRequest): URLSearchParams {
  return new URLSearchParams({
    chainId: String(ZERO_EX_BASE_CHAIN_ID),
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    sellAmount: req.sellAmount.toString(),
    taker: req.taker,
    slippageBps: String(req.slippageBps),
    swapFeeRecipient: req.feeRecipient,
    swapFeeBps: String(ZERO_EX_NATIVE_FEE_BPS),
    swapFeeToken: req.sellToken,
  });
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const eqAddr = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/** Pure: validates a raw 0x quote body against the request. Exported for tests. */
export function validateZeroExNativeFeeQuote(req: ZeroExNativeFeeRequest, body: unknown): ZeroExNativeFeeResult {
  const reject = (code: string, message: string): ZeroExNativeFeeResult => ({ ok: false, error: { code, message } });
  if (!obj(body)) return reject("PROVIDER_ERROR", "0x returned an unreadable quote.");
  if (body.liquidityAvailable === false) return reject("NO_LIQUIDITY", "0x reports no liquidity for this pair.");

  if (str(body.sellAmount) !== req.sellAmount.toString()) {
    return reject("AMOUNT_MISMATCH", "0x quote sellAmount does not equal the requested amount.");
  }
  if (!eqAddr(str(body.sellToken), req.sellToken) || !eqAddr(str(body.buyToken), req.buyToken)) {
    return reject("TOKEN_MISMATCH", "0x quote tokens do not match the request.");
  }
  const buyAmount = str(body.buyAmount);
  const minBuyAmount = str(body.minBuyAmount);
  if (!buyAmount || !minBuyAmount || !/^\d+$/.test(buyAmount) || !/^\d+$/.test(minBuyAmount) || BigInt(minBuyAmount) <= 0n) {
    return reject("PROVIDER_ERROR", "0x quote is missing buy/minBuy amounts.");
  }

  // --- exact integrator fee ---
  const fees = obj(body.fees) ? body.fees : null;
  const integrator = fees && obj(fees.integratorFee) ? fees.integratorFee : null;
  if (!integrator) return reject("INTEGRATOR_FEE_MISSING", "0x quote did not include the MPGR integrator fee; refusing.");
  const expected = expectedIntegratorFee(req.sellAmount);
  const amount = str(integrator.amount);
  if (!eqAddr(str(integrator.token), req.sellToken)) {
    return reject("INTEGRATOR_FEE_TOKEN_MISMATCH", "0x integrator fee is not denominated in the sell token; refusing.");
  }
  if (amount === null || !/^\d+$/.test(amount) || BigInt(amount) !== expected) {
    return reject("INTEGRATOR_FEE_MISMATCH", `0x integrator fee ${amount ?? "?"} != exact ${expected.toString()}; refusing.`);
  }
  if (Array.isArray(body.integratorFees) && body.integratorFees.length > 1) {
    return reject("INTEGRATOR_FEE_MISMATCH", "0x returned multiple integrator fees; refusing (double fee).");
  }

  // --- spender + target must be AllowanceHolder, never Settler ---
  const issues = obj(body.issues) ? body.issues : null;
  const allowance = issues && obj(issues.allowance) ? issues.allowance : null;
  const spender = str(allowance?.spender) ?? str(body.allowanceTarget) ?? ZERO_EX_ALLOWANCE_HOLDER_BASE;
  if (!eqAddr(spender, ZERO_EX_ALLOWANCE_HOLDER_BASE)) {
    return reject("UNEXPECTED_SPENDER", "0x allowance spender is not the AllowanceHolder; refusing.");
  }
  const tx = obj(body.transaction) ? body.transaction : null;
  const to = str(tx?.to);
  const data = str(tx?.data);
  if (!tx || !to || !data || !isAddress(to) || !/^0x[0-9a-fA-F]*$/.test(data)) {
    return reject("PROVIDER_ERROR", "0x quote has no transaction.");
  }
  if (!eqAddr(to, ZERO_EX_ALLOWANCE_HOLDER_BASE)) {
    return reject("UNEXPECTED_TARGET", "0x transaction target is not the AllowanceHolder; refusing.");
  }
  const value = str(tx.value) ?? "0";
  if (value !== "0") return reject("UNEXPECTED_VALUE", "ERC-20 sells must not send ETH.");

  const fills = obj(body.route) && Array.isArray(body.route.fills) ? body.route.fills : [];
  return {
    ok: true,
    value: {
      provider: "0x-allowance-holder-native-fee",
      chainId: 8453,
      sellToken: getAddress(req.sellToken),
      buyToken: getAddress(req.buyToken),
      sellAmount: req.sellAmount.toString(),
      buyAmount,
      minBuyAmount,
      feeBps: ZERO_EX_NATIVE_FEE_BPS,
      feeAmount: expected.toString(),
      feeToken: getAddress(req.sellToken),
      feeRecipient: getAddress(req.feeRecipient),
      spender: ZERO_EX_ALLOWANCE_HOLDER_BASE,
      currentAllowance: str(allowance?.actual),
      transaction: { to: getAddress(to), data: data as Hex, value, gas: str(tx.gas) ?? undefined },
      route: fills
        .filter(obj)
        .map((f) => ({ source: str(f.source) ?? "unknown", proportionBps: str(f.proportionBps) ?? "0" })),
    },
  };
}

export async function getZeroExNativeFeeQuote(
  req: ZeroExNativeFeeRequest,
  fetcher: Fetcher = fetch,
): Promise<ZeroExNativeFeeResult> {
  const key = readKey();
  if (!key) return { ok: false, error: { code: "CREDENTIALS_MISSING", message: "ZERO_EX_API_KEY is not configured." } };
  if (req.sellAmount <= 0n) return { ok: false, error: { code: "ZERO_AMOUNT", message: "Sell amount must be > 0." } };
  if (expectedIntegratorFee(req.sellAmount) === 0n) {
    return { ok: false, error: { code: "FEE_ROUNDS_TO_ZERO", message: "Amount too small for an exact 0.25% fee." } };
  }
  if (req.taker.toLowerCase() === req.feeRecipient.toLowerCase()) {
    return { ok: false, error: { code: "TAKER_IS_FEE_RECIPIENT", message: "Fee recipient cannot be the taker." } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZERO_EX_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher(`https://${ZERO_EX_API_HOST}${ZERO_EX_QUOTE_PATH}?${buildZeroExNativeFeeParams(req)}`, {
      method: "GET",
      headers: { Accept: "application/json", "0x-api-key": key, "0x-version": "v2" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: { code: "PROVIDER_ERROR", message: `0x Swap API returned HTTP ${res.status}.` } };
    }
    return validateZeroExNativeFeeQuote(req, body);
  } catch {
    return { ok: false, error: { code: "PROVIDER_ERROR", message: "Could not reach the 0x Swap API." } };
  } finally {
    clearTimeout(timer);
  }
}
