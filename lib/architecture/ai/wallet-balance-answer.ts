// lib/architecture/ai/wallet-balance-answer.ts
//
// Strict wallet-balance answers for the MPGR Agent.
//
// The deterministic layer owns these questions end to end (see
// lib/agent-intelligence/wallet-balance-intent.ts for the parsing rules):
//
//   "What is my MSTRc balance?"          → MSTRc wallet balance, only
//   "How much ETH do I have?"            → ETH wallet balance, only
//   "How much MPGR do I have?"           → MPGR wallet balance, only
//   "How much MPGR do I have staked?"    → staked MPGR, only
//   "How much MPGR do I have locked?"    → locked MPGR, only
//   "What's my total MPGR exposure?"     → wallet + staked + locked, labeled
//   "What's in my wallet?"               → every wallet-held asset
//   "How much is my wallet worth?"       → wallet value, wallet-held only
//
// Every number comes from a live read:
//   - wallet-held amounts: wallet_balances (on-chain balanceOf /
//     eth_getBalance for the CONNECTED session wallet)
//   - staked / locked: the app's existing live staking + token-lock state
//     (AgentContext, already built from useStaking/useTokenLock) — MPGR-only,
//     by contract
//   - prices: the app's existing market sources (get_tape for the Coinbase
//     wrapped assets + tokenized stocks, market_intelligence for $MPGR, a
//     live ETH→USDC swap price for ETH). Anything without an in-app source
//     is reported as unpriced and excluded from the total — never guessed.
//
// A single-token question never returns a portfolio summary, never mixes in
// staking/locked/XP/tier/rewards/referral data, and an unresolvable asset
// asks for a symbol or address instead of dumping the wallet.

import { formatCompactNumber } from "@/lib/format";
import {
  parseWalletBalanceRequest,
  type WalletBalanceRequest,
  type WalletBalanceScope,
} from "@/lib/agent-intelligence";

import type { AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { runRegisteredTool } from "./tool-execution-service";
import type { AgentToolResult } from "../tools/agent-tool-result";

interface BalanceAsset {
  symbol: string;
  name: string;
  address: string;
  kind: string;
  decimals: number | null;
  balanceRaw: string;
  human: string | null;
  nonzero: boolean;
}

interface BalancesSnapshot {
  asOf: string;
  native: { symbol: string; human: string | null; balanceRaw: string };
  assets: BalanceAsset[];
}

interface PriceHit {
  usd: number;
  source: string;
}

export function isWalletBalancePrompt(rawPrompt: string): boolean {
  return parseWalletBalanceRequest(rawPrompt) !== null;
}

/** Number formatting that never invents precision the chain didn't give. */
function formatBalance(human: string | null): string | null {
  if (human === null) return null;
  const value = Number(human);
  if (!Number.isFinite(value)) return human;
  if (value === 0) return "0";
  if (value >= 1) return human;
  return formatCompactNumber(value);
}

function formatUsd(value: number): string {
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

async function readBalances(
  request: AIProviderRequest,
  symbol?: string,
): Promise<BalancesSnapshot | null> {
  const result: AgentToolResult = await runRegisteredTool(
    "wallet_balances",
    symbol ? { symbol } : {},
    request,
  );
  if (!result.success) return null;
  const data = result.data as Partial<BalancesSnapshot> | undefined;
  if (!data || !data.native || !Array.isArray(data.assets)) return null;
  return {
    asOf: typeof data.asOf === "string" ? data.asOf : new Date().toISOString(),
    native: data.native,
    assets: data.assets,
  };
}

/**
 * Wallet-held assets with a definite balance, ETH first. Assets whose read
 * failed are kept (human: null) so the answer can say "unavailable" instead
 * of printing a zero nobody measured.
 */
function heldAssets(snapshot: BalancesSnapshot): BalanceAsset[] {
  const native: BalanceAsset = {
    symbol: snapshot.native.symbol,
    name: "Ether",
    address: "native",
    kind: "native",
    decimals: 18,
    balanceRaw: snapshot.native.balanceRaw,
    human: snapshot.native.human,
    nonzero: Number(snapshot.native.balanceRaw) > 0,
  };
  return [native, ...snapshot.assets];
}

function findAsset(snapshot: BalancesSnapshot, symbol: string): BalanceAsset | null {
  if (symbol === "ETH") return heldAssets(snapshot)[0] ?? null;
  const wanted = symbol.toLowerCase();
  return (
    heldAssets(snapshot).find((asset) => asset.symbol.toLowerCase() === wanted) ?? null
  );
}

async function loadPrices(request: AIProviderRequest): Promise<Map<string, PriceHit>> {
  const prices = new Map<string, PriceHit>();

  // USDC is the app's dollar unit (its own peg, not a market guess).
  prices.set("USDC", { usd: 1, source: "USDC peg (USD Coin on Base)" });

  const [tape, market, eth] = await Promise.all([
    runRegisteredTool("get_tape", {}, request),
    request.address
      ? runRegisteredTool("market_intelligence", { address: request.address }, request)
      : Promise.resolve(null),
    // Live ETH→USDC swap price: the only in-app ETH price source. WETH
    // tracks it 1:1.
    runRegisteredTool(
      "trade_get_price",
      { fromToken: "ETH", toToken: "USDC", amount: "1" },
      request,
    ),
  ]);

  if (tape.success) {
    const data = tape.data as
      | {
          tape?: {
            wrapped?: { symbol?: string; usd?: number | null }[];
            stocks?: { symbol?: string; usdFeed?: number | null; usdDex?: number | null }[];
          };
        }
      | undefined;
    for (const entry of data?.tape?.wrapped ?? []) {
      if (typeof entry.symbol !== "string") continue;
      if (typeof entry.usd !== "number" || entry.usd <= 0) continue;
      prices.set(entry.symbol.toUpperCase(), { usd: entry.usd, source: "live tape (DEX price)" });
    }
    for (const entry of data?.tape?.stocks ?? []) {
      if (typeof entry.symbol !== "string") continue;
      const usd =
        typeof entry.usdFeed === "number" && entry.usdFeed > 0
          ? entry.usdFeed
          : typeof entry.usdDex === "number" && entry.usdDex > 0
            ? entry.usdDex
            : null;
      if (usd === null) continue;
      prices.set(entry.symbol.toUpperCase(), {
        usd,
        source: "live tape (Chainlink Coinbase equity feed)",
      });
    }
  }

  if (market && market.success) {
    const mpgr = (market.data as { mpgr?: { priceUsd?: number } } | undefined)?.mpgr;
    if (typeof mpgr?.priceUsd === "number" && mpgr.priceUsd > 0) {
      prices.set("MPGR", { usd: mpgr.priceUsd, source: "live $MPGR market price" });
    }
  }

  if (eth.success) {
    const quoted = (eth.data as {
      price?: { toAmount?: string; liquidityAvailable?: boolean };
    } | undefined)?.price;
    // 1 ETH → USDC: the quote's toAmount is USDC atomic units (6 dp).
    const usd =
      quoted?.toAmount && quoted.liquidityAvailable !== false
        ? Number(quoted.toAmount) / 1_000_000
        : Number.NaN;
    if (Number.isFinite(usd) && usd > 0) {
      prices.set("ETH", { usd, source: "live ETH→USDC swap price" });
      prices.set("WETH", { usd, source: "live ETH→USDC swap price" });
    }
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Formatting (pure — unit tested)
// ---------------------------------------------------------------------------

function addressOf(asset: BalanceAsset): string {
  return asset.kind === "native" ? "native ETH on Base" : asset.address;
}

export function formatSingleBalanceReply(
  asset: BalanceAsset,
  scope: WalletBalanceScope,
  context: { asOf: string; stakedMpgr: number | null; lockedMpgr: number | null },
): string {
  const amount = formatBalance(asset.human);
  const label = asset.name && asset.name !== asset.symbol ? ` (${asset.name})` : "";

  if (asset.human === null) {
    return (
      `I could not read your ${asset.symbol} balance right now — the on-chain read failed, so I will not guess a number. Nothing else was changed. Try again in a moment.`
    );
  }

  if (scope === "staked") {
    if (asset.symbol !== "MPGR") {
      return (
        `${asset.symbol} has no staked balance — staking in this app is $MPGR-only. ` +
        `Your wallet holds ${amount} ${asset.symbol}${label}, and that wallet balance is not staked.`
      );
    }
    const staked = context.stakedMpgr;
    return (
      `Staked: ${staked === null ? "unavailable" : formatCompactNumber(staked) + " MPGR"} in the MPGR staking contract (live from your connected wallet). ` +
      `Your wallet balance is ${amount} MPGR — wallet-held, and not staked (read as of ${context.asOf}).`
    );
  }

  if (scope === "locked") {
    if (asset.symbol !== "MPGR") {
      return (
        `${asset.symbol} has no locked balance — token locks in this app are $MPGR-only. ` +
        `Your wallet holds ${amount} ${asset.symbol}${label}, and that wallet balance is not locked.`
      );
    }
    const locked = context.lockedMpgr;
    return (
      `Locked: ${locked === null ? "unavailable" : formatCompactNumber(locked) + " MPGR"} in MPGR token locks (live from your connected wallet). ` +
      `Your wallet balance is ${amount} MPGR — wallet-held, and not locked (read as of ${context.asOf}).`
    );
  }

  if (scope === "exposure") {
    if (asset.symbol !== "MPGR") {
      return (
        `Total ${asset.symbol} exposure: ${amount} ${asset.symbol} — wallet-held. ` +
        `${asset.symbol} cannot be staked or locked in this app (both are $MPGR-only), so there is no other bucket to add. ` +
        `(Live on-chain read, ${context.asOf}.)`
      );
    }
    const staked = context.stakedMpgr;
    const locked = context.lockedMpgr;
    const total =
      staked === null || locked === null ? null : Number(asset.human) + staked + locked;
    return (
      `Total MPGR exposure — wallet: ${amount} MPGR · staked: ${
        staked === null ? "unavailable" : formatCompactNumber(staked) + " MPGR"
      } · locked: ${
        locked === null ? "unavailable" : formatCompactNumber(locked) + " MPGR"
      }` +
      (total === null ? "." : ` · combined: ${formatCompactNumber(total)} MPGR.`) +
      ` Wallet reads as of ${context.asOf}; staking and lock state live from your connected wallet.`
    );
  }

  return (
    `Your ${asset.symbol} wallet balance: ${amount} ${asset.symbol}${label}. ` +
    `Wallet-held on Base (${addressOf(asset)}), live on-chain read as of ${context.asOf}. ` +
    `Nothing else is reported here — ask about another asset by name if you want its balance.`
  );
}

export function formatAllBalancesReply(
  snapshot: BalancesSnapshot,
  context: { stakedMpgr: number | null; lockedMpgr: number | null },
): string {
  const held = heldAssets(snapshot).filter(
    (asset) => (asset.human !== null && Number(asset.human) > 0) || asset.human === null,
  );
  const lines = held.map((asset) => {
    const amount = formatBalance(asset.human);
    if (amount === null) return `${asset.symbol}: unavailable (on-chain read failed)`;
    return `${asset.symbol}: ${amount}`;
  });

  const unreadable = held.some((asset) => asset.human === null);
  const body =
    lines.length === 0
      ? "No balances above zero in the assets this app supports on Base."
      : lines.join(" · ");

  const notInWallet: string[] = [];
  if (context.stakedMpgr !== null && context.stakedMpgr > 0) {
    notInWallet.push(`${formatCompactNumber(context.stakedMpgr)} MPGR staked`);
  }
  if (context.lockedMpgr !== null && context.lockedMpgr > 0) {
    notInWallet.push(`${formatCompactNumber(context.lockedMpgr)} MPGR locked`);
  }

  return (
    `Wallet-held on Base (live on-chain reads as of ${snapshot.asOf}): ${body}. ` +
    `This is your wallet only — nothing staked or locked is included.` +
    (notInWallet.length
      ? ` Not in your wallet: ${notInWallet.join(" and ")} (MPGR-only staking/token lock).`
      : "") +
    (unreadable ? " A token marked unavailable could not be read on-chain — no number was guessed." : "")
  );
}

export interface WalletValueRow {
  symbol: string;
  amount: string;
  usd: number;
  source: string;
}

export function formatTotalValueReply(
  snapshot: BalancesSnapshot,
  rows: WalletValueRow[],
  unpriced: { symbol: string; amount: string }[],
  context: { stakedMpgr: number | null; lockedMpgr: number | null },
): string {
  if (rows.length === 0) {
    return (
      `I could not price any of your wallet holdings from an in-app source right now, so I will not invent a total. ` +
      `Your wallet reads (${snapshot.asOf}): ${
        heldAssets(snapshot)
          .filter((asset) => asset.human !== null && Number(asset.human) > 0)
          .map((asset) => `${asset.symbol}: ${formatBalance(asset.human)}`)
          .join(" · ") || "no balances above zero in supported assets"
      }.`
    );
  }

  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  const breakdown = rows
    .map((row) => `${row.symbol} ${row.amount} = ${formatUsd(row.usd)} (${row.source})`)
    .join(" · ");

  const staked = context.stakedMpgr;
  const locked = context.lockedMpgr;
  const outside: string[] = [];
  if (staked !== null && staked > 0) outside.push(`${formatCompactNumber(staked)} MPGR staked`);
  if (locked !== null && locked > 0) outside.push(`${formatCompactNumber(locked)} MPGR locked`);
  const stakedNote = outside.length
    ? ` Separately — NOT in the total: ${outside.join(" and ")} (MPGR-only staking and token lock; not wallet-held).`
    : "";

  return (
    `Your wallet is worth about ${formatUsd(total)} USD — wallet-held assets only. ` +
    `Breakdown: ${breakdown}. ` +
    (unpriced.length
      ? `Not priced by an in-app source (excluded from the total): ${unpriced
          .map((entry) => `${entry.symbol} ${entry.amount}`)
          .join(", ")}. `
      : "") +
    `(Live on-chain balances as of ${snapshot.asOf}.)` +
    stakedNote
  );
}

function unavailableReply(kind: "balance" | "wallet" | "value"): string {
  if (kind === "balance") {
    return "I could not read that balance from Base right now — the RPC provider may be busy. No number was guessed; try again in a moment.";
  }
  if (kind === "value") {
    return "I could not read your wallet balances from Base right now, so there is no value to report. Nothing was guessed; try again in a moment.";
  }
  return "I could not read your wallet balances from Base right now — the RPC provider may be busy. Nothing was guessed; try again in a moment.";
}

function emptyResponse(reply: string): AIProviderResponse {
  return {
    intent: "portfolio_summary",
    reply,
    actions: [],
    highlights: [],
    followUps: [],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Answers a wallet-balance question from live data. Returns null when the
 * prompt is not a balance question (callers keep their existing routing),
 * or when there is no connected wallet (the existing not-connected reply
 * already covers that).
 */
export async function answerWalletBalance(
  request: AIProviderRequest,
): Promise<AIProviderResponse | null> {
  const parsed: WalletBalanceRequest | null = parseWalletBalanceRequest(request.prompt);
  if (!parsed) return null;

  // A balance question without a wallet gets a straight answer, not the
  // generic portfolio help text.
  if (!request.agentContext?.isConnected) {
    return emptyResponse(
      "Connect your wallet first so I can read your Base balances on-chain — I only report amounts I actually read, never an estimate.",
    );
  }

  const stakedMpgr = liveNumber(request.agentContext.staking?.totalStaked);
  const lockedMpgr = liveNumber(request.agentContext.tokenLock?.totalLocked);

  if (parsed.kind === "single") {
    if (!parsed.resolved) {
      return emptyResponse(
        `I cannot safely resolve "${parsed.mention}" as an asset on Base in this app, so I will not guess a contract or dump your whole wallet. ` +
          `Send the exact symbol (for example ETH, USDC, MPGR, cbADA, AAPLc) or the 0x contract address and I will read that one balance.`,
      );
    }

    const snapshot = await readBalances(request, parsed.token);
    if (!snapshot) return emptyResponse(unavailableReply("balance"));

    const asset = findAsset(snapshot, parsed.token);
    if (!asset) {
      return emptyResponse(
        `That asset is not in the set this app can read (ETH, USDC, WETH, MPGR, the Coinbase wrapped assets, and the official Coinbase Tokenized Stocks). ` +
          `Give me the 0x contract address if it is a different Base token and I will read it directly.`,
      );
    }

    return emptyResponse(
      formatSingleBalanceReply(asset, parsed.scope, {
        asOf: snapshot.asOf,
        stakedMpgr,
        lockedMpgr,
      }),
    );
  }

  const snapshot = await readBalances(request);
  if (!snapshot) {
    return emptyResponse(unavailableReply(parsed.kind === "total" ? "value" : "wallet"));
  }

  if (parsed.kind === "all") {
    return emptyResponse(
      formatAllBalancesReply(snapshot, { stakedMpgr, lockedMpgr }),
    );
  }

  const prices = await loadPrices(request);
  const rows: WalletValueRow[] = [];
  const unpriced: { symbol: string; amount: string }[] = [];

  for (const asset of heldAssets(snapshot)) {
    if (asset.human === null) continue;
    const balance = Number(asset.human);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    const price = prices.get(asset.symbol.toUpperCase());
    if (!price) {
      // No in-app price source for this asset — reported, never guessed.
      unpriced.push({ symbol: asset.symbol, amount: formatBalance(asset.human) ?? asset.human });
      continue;
    }
    rows.push({
      symbol: asset.symbol,
      amount: formatBalance(asset.human) ?? asset.human,
      usd: balance * price.usd,
      source: price.source,
    });
  }

  rows.sort((a, b) => b.usd - a.usd);
  return emptyResponse(
    formatTotalValueReply(snapshot, rows, unpriced, { stakedMpgr, lockedMpgr }),
  );
}

/** Live AgentContext numbers only — never a fabricated fallback. */
function liveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
