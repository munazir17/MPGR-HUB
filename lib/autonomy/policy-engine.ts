// lib/autonomy/policy-engine.ts
//
// DETERMINISTIC policy engine (spec §5). The LLM is never the authority:
// every value arrives as untrusted input and is re-parsed, normalized and
// range-checked here, server-side. Pure module — no I/O, no clock reads
// (time is always injected), fully unit-testable.

import { getAddress, isAddress, type Address } from "viem";

import {
  AUTONOMY_SLIPPAGE_BOUNDS,
  AUTONOMY_LIMITS,
} from "./config";
import {
  AUTONOMY_ACTION_TYPES,
  AUTONOMY_CHAIN_ID,
  AUTONOMY_THRESHOLD_SCALE,
  isSupportedPolicyChainId,
  type AgentGoal,
  type AutonomyActionType,
  type AutonomyChainId,
  type AutonomyPolicy,
  type GoalCondition,
  type GoalTradeSpec,
  type PolicyDecision,
  type PolicyRejection,
  type SpendContext,
  type SupportedPolicyChainId,
  isPolicyRevoked,
} from "./types";

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Human-readable list of chains an autonomous policy may target. */
const SUPPORTED_POLICY_CHAIN_IDS_LABEL = "8453 (Base) or 84532 (Base Sepolia)";

const DECIMAL_RE = /^\d{1,40}(\.\d{1,18})?$/;
const INT_RE = /^\d{1,12}$/;

export function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && INT_RE.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export function parseBaseUnits(raw: unknown, decimals: number): string | null {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) return null;
  try {
    const [int, frac = ""] = raw.split(".");
    if (frac.length > decimals) return null;
    const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
    const value = BigInt(int + fracPadded);
    return value > 0n ? value.toString() : null;
  } catch {
    return null;
  }
}

/** Scaled (1e18) bigint from a decimal string; null on any malformed input. */
export function parseScaledDecimal(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !DECIMAL_RE.test(raw)) return null;
  try {
    const [int, frac = ""] = raw.split(".");
    const fracPadded = frac.padEnd(18, "0").slice(0, 18);
    return BigInt(int + fracPadded);
  } catch {
    return null;
  }
}

function ltOrEq(a: string, b: string): boolean {
  return BigInt(a) <= BigInt(b);
}

// ---------------------------------------------------------------------------
// Condition normalization
// ---------------------------------------------------------------------------

export function normalizeCondition(input: unknown): NormalizeResult<GoalCondition> {
  const errors: string[] = [];
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const kind = raw.kind;
  if (kind !== "price_below" && kind !== "price_above") {
    errors.push("condition.kind must be \"price_below\" or \"price_above\".");
  }
  const threshold = parseScaledDecimal(raw.threshold);
  if (threshold === null || threshold <= 0n) {
    errors.push("condition.threshold must be a positive decimal string.");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { kind: kind as GoalCondition["kind"], threshold: (raw.threshold as string).trim() } };
}

// ---------------------------------------------------------------------------
// Policy normalization (server-side — never trusts LLM/client values)
// ---------------------------------------------------------------------------

export interface NormalizePolicyArgs {
  wallet: unknown;
  /**
   * The chain this authorization targets. OPTIONAL — omitted means Base
   * mainnet (8453), preserving the pre-remediation behaviour exactly. Any
   * supplied value is validated against SUPPORTED_POLICY_CHAIN_IDS; an
   * unsupported chain is a hard normalization error, never a silent default.
   * The chosen chain is then bound into the signed `policyHash`, so the user's
   * authorization is cryptographically chain-specific.
   */
  chainId?: unknown;
  /** Token resolver injected by the caller (MCP/discovery-backed). */
  resolveToken: (raw: unknown) => { ok: true; address: Address; decimals: number } | { ok: false; message: string };
  sellToken: unknown;
  buyToken: unknown;
  maxPerTrade: unknown; // human decimal string, sell-token units
  maxDaily: unknown; // human decimal string, sell-token units
  maxSlippageBps: unknown;
  maxActionsPerDay: unknown;
  ttlDays: unknown;
  now: Date;
  authorizationRef: string;
}

export function normalizePolicyInput(args: NormalizePolicyArgs): NormalizeResult<AutonomyPolicy> {
  const errors: string[] = [];
  if (!isAddress(typeof args.wallet === "string" ? args.wallet : "")) errors.push("wallet must be a valid address.");
  if (typeof args.authorizationRef !== "string" || args.authorizationRef.length === 0 || args.authorizationRef.length > 128) {
    errors.push("authorizationRef is required.");
  }

  // CHAIN (audit MC-1 remediation). Explicit, validated, never inferred from
  // the token pair. Omitted => Base mainnet, exactly as before.
  const rawChain = args.chainId;
  const chainProvided = rawChain !== undefined && rawChain !== null && rawChain !== "";
  const parsedChain = chainProvided
    ? typeof rawChain === "number"
      ? rawChain
      : typeof rawChain === "string" && /^\d+$/.test(rawChain.trim())
        ? Number(rawChain.trim())
        : NaN
    : AUTONOMY_CHAIN_ID;
  if (!Number.isFinite(parsedChain) || !isSupportedPolicyChainId(parsedChain)) {
    errors.push(`chainId must be one of ${SUPPORTED_POLICY_CHAIN_IDS_LABEL}.`);
  }
  const chainId = (Number.isFinite(parsedChain) ? parsedChain : AUTONOMY_CHAIN_ID) as SupportedPolicyChainId;

  if (args.sellToken !== null && typeof args.sellToken === "string" && getAddressSafe(args.sellToken) && String(args.sellToken).toLowerCase() === String(args.buyToken ?? "").toLowerCase()) {
    errors.push("sellToken and buyToken must differ.");
  }

  const sell = args.resolveToken(args.sellToken);
  if (!sell.ok) errors.push(`sellToken: ${sell.message}`);
  const buy = args.resolveToken(args.buyToken);
  if (!buy.ok) errors.push(`buyToken: ${buy.message}`);
  if (sell.ok && buy.ok && sell.address.toLowerCase() === buy.address.toLowerCase()) {
    errors.push("sellToken and buyToken must differ.");
  }

  const sellDecimals = sell.ok ? sell.decimals : 18;
  const maxPerTradeRaw = parseBaseUnits(args.maxPerTrade, sellDecimals);
  if (maxPerTradeRaw === null) errors.push("maxPerTrade must be a positive decimal string.");
  const maxDailyRaw = parseBaseUnits(args.maxDaily, sellDecimals);
  if (maxDailyRaw === null) errors.push("maxDaily must be a positive decimal string.");

  let maxPerTradeCeiling = parseBaseUnits(AUTONOMY_LIMITS.maxPerTradeHuman, sellDecimals);
  let maxDailyCeiling = parseBaseUnits(AUTONOMY_LIMITS.maxDailyHuman, sellDecimals);
  if (maxPerTradeRaw && maxPerTradeCeiling && !ltOrEq(maxPerTradeRaw, maxPerTradeCeiling)) {
    errors.push(`maxPerTrade exceeds the runtime ceiling (${AUTONOMY_LIMITS.maxPerTradeHuman}).`);
  }
  if (maxDailyRaw && maxDailyCeiling && !ltOrEq(maxDailyRaw, maxDailyCeiling)) {
    errors.push(`maxDaily exceeds the runtime ceiling (${AUTONOMY_LIMITS.maxDailyHuman}).`);
  }
  if (maxPerTradeRaw && maxDailyRaw && BigInt(maxPerTradeRaw) > BigInt(maxDailyRaw)) {
    errors.push("maxDaily must be >= maxPerTrade.");
  }

  const maxSlippageBps = parsePositiveInt(args.maxSlippageBps);
  if (
    maxSlippageBps === null ||
    maxSlippageBps < AUTONOMY_SLIPPAGE_BOUNDS.minBps ||
    maxSlippageBps > AUTONOMY_SLIPPAGE_BOUNDS.maxBps
  ) {
    errors.push(`maxSlippageBps must be an integer between ${AUTONOMY_SLIPPAGE_BOUNDS.minBps} and ${AUTONOMY_SLIPPAGE_BOUNDS.maxBps}.`);
  }

  const maxActionsPerDay = parsePositiveInt(args.maxActionsPerDay);
  if (maxActionsPerDay === null || maxActionsPerDay > 50) {
    errors.push("maxActionsPerDay must be an integer between 1 and 50.");
  }

  const ttlDays = parsePositiveInt(args.ttlDays);
  if (ttlDays === null || ttlDays > AUTONOMY_LIMITS.maxPolicyTtlDays) {
    errors.push(`ttlDays must be an integer between 1 and ${AUTONOMY_LIMITS.maxPolicyTtlDays}.`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const nowMs = args.now.getTime();
  const expiresAt = new Date(Math.min(nowMs + (ttlDays as number) * 86_400_000, nowMs + AUTONOMY_LIMITS.maxPolicyTtlDays * 86_400_000));

  return {
    ok: true,
    value: {
      id: "", // assigned by the store on persist
      wallet: getAddress(String(args.wallet).toLowerCase()) as Address,
      chainId,
      actions: AUTONOMY_ACTION_TYPES,
      sellToken: (sell as { address: Address }).address,
      buyToken: (buy as { address: Address }).address,
      maxPerTradeRaw: maxPerTradeRaw as string,
      maxDailyRaw: maxDailyRaw as string,
      maxSlippageBps: maxSlippageBps as number,
      maxActionsPerDay: maxActionsPerDay as number,
      enabled: true,
      createdAt: args.now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      authorizedAt: args.now.toISOString(),
      authorizationRef: args.authorizationRef,
    },
  };
}

function getAddressSafe(value: unknown): boolean {
  return typeof value === "string" && isAddress(value);
}

// ---------------------------------------------------------------------------
// Deterministic action evaluation — the gate before EVERY autonomous action.
// ---------------------------------------------------------------------------

export interface ProposedAction {
  action: AutonomyActionType;
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmountRaw: string;
  slippageBps: number;
}

export function evaluatePolicyAgainstAction(
  policy: AutonomyPolicy | null,
  goal: Pick<AgentGoal, "expiresAt">,
  proposed: ProposedAction,
  spend: SpendContext,
  now: Date,
): PolicyDecision {
  const reject = (rule: PolicyRejection["rule"], message: string, code: PolicyRejection["code"] = "POLICY_REJECTED"): PolicyDecision => ({
    allowed: false,
    rejection: { code, rule, message },
  });

  if (!policy) return reject("POLICY_NOT_FOUND", "No autonomous policy exists for this goal.");
  if (isPolicyRevoked(policy)) return reject("POLICY_REVOKED", "The autonomous authorization was revoked.");
  if (!policy.enabled) return reject("POLICY_DISABLED", "The autonomous authorization is disabled.");
  if (new Date(policy.expiresAt).getTime() <= now.getTime()) return reject("POLICY_EXPIRED", "The autonomous authorization has expired.");
  if (new Date(goal.expiresAt).getTime() <= now.getTime()) return reject("GOAL_EXPIRED", "The goal has expired.");

  if (proposed.chainId !== policy.chainId) {
    return reject("CHAIN_MISMATCH", `Autonomous actions are restricted to Base (chain ${policy.chainId}).`);
  }
  if (!policy.actions.includes(proposed.action)) {
    return reject("ACTION_NOT_PERMITTED", `Action "${proposed.action}" is not permitted by this policy.`);
  }
  if (proposed.sellToken.toLowerCase() !== policy.sellToken.toLowerCase()) {
    return reject("SELL_TOKEN_MISMATCH", "Sell token is outside the authorized policy.", "TOKEN_NOT_ALLOWED");
  }
  if (proposed.buyToken.toLowerCase() !== policy.buyToken.toLowerCase()) {
    return reject("BUY_TOKEN_MISMATCH", "Buy token is outside the authorized policy.", "TOKEN_NOT_ALLOWED");
  }
  if (proposed.sellAmountRaw.length === 0 || !/^\d+$/.test(proposed.sellAmountRaw) || BigInt(proposed.sellAmountRaw) <= 0n) {
    return reject("OVER_PER_TRADE_LIMIT", "Sell amount must be a positive base-unit integer.");
  }
  if (BigInt(proposed.sellAmountRaw) > BigInt(policy.maxPerTradeRaw)) {
    return reject("OVER_PER_TRADE_LIMIT", "Sell amount exceeds the per-trade limit authorized by the policy.");
  }
  const totalAfter = BigInt(spend.dailySpendRaw) + BigInt(proposed.sellAmountRaw);
  if (totalAfter > BigInt(policy.maxDailyRaw)) {
    return reject("OVER_DAILY_LIMIT", "This trade would exceed the daily spend limit authorized by the policy.");
  }
  if (proposed.slippageBps > policy.maxSlippageBps) {
    return reject("OVER_SLIPPAGE_LIMIT", "Requested slippage exceeds the policy limit.");
  }
  if (spend.actionsToday + 1 > policy.maxActionsPerDay) {
    return reject("OVER_ACTION_RATE", "The daily action limit authorized by the policy has been reached.");
  }
  return { allowed: true, policy };
}

// ---------------------------------------------------------------------------
// Deterministic condition evaluation (spec §9) — bigint only, no floats.
//
// Human price of 1 buy token, denominated in the sell token:
//   price = (sellAmountRaw / 10^sellDecimals) / (buyAmountRaw / 10^buyDecimals)
//
//   price <= T  ⟺  sellAmountRaw * 10^buyDecimals  <=  T * buyAmountRaw * 10^sellDecimals
// (with T scaled by 1e18). Decimals come from the goal's registry snapshot.
// ---------------------------------------------------------------------------

export function evaluateCondition(
  condition: GoalCondition,
  sellAmountRaw: string,
  buyAmountRaw: string,
  sellDecimals: number,
  buyDecimals: number,
): { met: boolean; price: string } | { met: false; error: "INVALID_CONDITION" } {
  let sell: bigint;
  let buy: bigint;
  let threshold: bigint;
  try {
    sell = BigInt(sellAmountRaw);
    buy = BigInt(buyAmountRaw);
    threshold = parseScaledDecimal(condition.threshold) ?? 0n;
  } catch {
    return { met: false, error: "INVALID_CONDITION" };
  }
  if (sell <= 0n || buy <= 0n || threshold <= 0n) return { met: false, error: "INVALID_CONDITION" };
  if (!Number.isInteger(sellDecimals) || !Number.isInteger(buyDecimals) || sellDecimals < 0 || buyDecimals < 0) {
    return { met: false, error: "INVALID_CONDITION" };
  }
  const humanize = 10n ** BigInt(buyDecimals);
  const denominate = 10n ** BigInt(sellDecimals);
  // price (human) = (sell / buy) * 10^(buyDecimals - sellDecimals); compare scaled.
  const lhs = sell * humanize * AUTONOMY_THRESHOLD_SCALE;
  const rhs = threshold * buy * denominate;
  const priceScaled = (sell * humanize * AUTONOMY_THRESHOLD_SCALE) / (buy * denominate);
  const met = condition.kind === "price_below" ? lhs <= rhs : lhs >= rhs;
  return { met, price: formatScaled(priceScaled) };
}

function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const int = abs / AUTONOMY_THRESHOLD_SCALE;
  const frac = (abs % AUTONOMY_THRESHOLD_SCALE).toString().padStart(18, "0").slice(0, 6);
  return `${negative ? "-" : ""}${int}.${frac}`;
}

/** Guard used by goal creation: a goal's trade must sit inside its policy. */
export function goalTradeMatchesPolicy(policy: AutonomyPolicy, trade: GoalTradeSpec): boolean {
  return (
    trade.sellToken.toLowerCase() === policy.sellToken.toLowerCase() &&
    trade.buyToken.toLowerCase() === policy.buyToken.toLowerCase() &&
    BigInt(trade.sellAmountRaw) <= BigInt(policy.maxPerTradeRaw)
  );
}
