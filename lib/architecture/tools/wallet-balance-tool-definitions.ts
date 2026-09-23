// lib/architecture/tools/wallet-balance-tool-definitions.ts
//
// Live, session-bound wallet balances for the MPGR Agent.
//
//   wallet_balances  (read) — native ETH + every asset in this app's
//                             supported catalog, read straight off Base
//                             with on-chain balanceOf/decimals calls
//
// Why a tool instead of a new API route: the agent's read tools already
// run in the browser and already receive the connected address through
// AgentToolContext.walletAddress (see lib/architecture/tools/
// agent-tool-context.ts). The wallet is ALWAYS taken from that context —
// never from the prompt or a tool argument — so a model cannot ask for
// somebody else's balances, and no new authenticated HTTP surface is
// introduced. The catalog (lib/trade/trade-tokens.ts) is the same closed
// list the swap routes use, so this tool can never read an invented
// contract.
//
// Facts only: raw + formatted amounts, decimals read on-chain (B20
// decimals are issuer-configurable, so guessing them is a real-funds unit
// error — a failed decimals read returns human:null instead of a guess).
// No prices, no portfolio math, no staking/lock figures — those live
// elsewhere and are never mixed into a wallet-held balance.

import { getBalance, readContracts } from "wagmi/actions";
import { formatUnits, isAddress } from "viem";

import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { KNOWN_TRADE_TOKENS, resolveTradeToken } from "@/lib/trade/trade-tokens";
import type { TradeTokenKind } from "@/lib/trade/trade-types";

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";

const CHAIN_ID = 8453;

export interface WalletBalanceAsset {
  symbol: string;
  name: string;
  address: string;
  kind: TradeTokenKind;
  /** On-chain decimals, or null when that read failed (never guessed). */
  decimals: number | null;
  /** Raw balance in atomic units (decimal string; "0" when unreadable). */
  balanceRaw: string;
  /** formatUnits(balanceRaw, decimals), or null — never a guessed unit. */
  human: string | null;
  /** True when the balance was actually read and is > 0. */
  nonzero: boolean;
  /** True for catalog entries (verified) vs. an unverified user address. */
  verified: boolean;
}

export interface WalletBalancesResult {
  wallet: string;
  chainId: number;
  asOf: string;
  /** Native ETH — read with eth_getBalance, not a token call. */
  native: { symbol: "ETH"; decimals: 18; balanceRaw: string; human: string | null };
  assets: WalletBalanceAsset[];
  source: string;
}

/** Every distinct catalog token that has a real Base contract address. */
function catalogTokens(): { symbol: string; name: string; address: string; kind: TradeTokenKind }[] {
  const seen = new Set<string>();
  const tokens: { symbol: string; name: string; address: string; kind: TradeTokenKind }[] = [];
  for (const token of KNOWN_TRADE_TOKENS) {
    const address = String(token.address);
    if (!isAddress(address) || isNativeEthSentinel(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ symbol: token.symbol, name: token.name, address, kind: token.kind });
  }
  return tokens;
}

const walletBalancesSchema: AgentToolSchema = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      description:
        'Optional. One asset only, e.g. "MSTRc", "ETH", "USDC", "MPGR", or a 0x address. Omit to read the whole wallet.',
    },
  },
} satisfies AgentToolSchema;

export const walletBalancesTool: AgentTool = {
  id: "wallet_balances",
  name: "My Wallet Balances",
  description:
    "Reads the CONNECTED session wallet's live Base balances from chain: native ETH plus USDC, WETH, MPGR, the Coinbase wrapped assets and the official Coinbase Tokenized Stock (B20) tickers this app supports. Pass {symbol} for a single asset, {} for the whole wallet. Amounts are on-chain balanceOf reads — never estimated. Read-only.",
  category: "wallet",
  mode: "read",
  riskLevel: "low",
  requiresWallet: true,
  requiresConfirmation: false,
  inputSchema: walletBalancesSchema,

  async execute(input, context) {
    const rawAddress = context?.walletAddress;
    if (!rawAddress || !isAddress(rawAddress)) {
      return toolError("wallet_balances", {
        code: "WALLET_NOT_CONNECTED",
        message: "Connect your wallet so I can read your Base balances.",
      });
    }
    const wallet = rawAddress as `0x${string}`;

    const requested = (input ?? {}) as { symbol?: unknown };
    let tokens = catalogTokens();
    let resolvedSymbol: string | null = null;

    if (typeof requested.symbol === "string" && requested.symbol.trim()) {
      const resolved = resolveTradeToken(requested.symbol);
      if (!resolved.ok) {
        return toolError(
          "wallet_balances",
          { code: "INVALID_INPUT", message: resolved.message },
          { chainId: CHAIN_ID },
        );
      }
      resolvedSymbol = resolved.token.symbol;
      const wanted = resolved.token.address.toLowerCase();
      tokens = tokens.filter((token) => token.address.toLowerCase() === wanted);
      if (
        tokens.length === 0 &&
        !isNativeEthSentinel(resolved.token.address) &&
        !resolved.token.verified
      ) {
        // An unverified 0x address: read exactly that contract, nothing more.
        tokens = [
          {
            symbol: resolved.token.symbol,
            name: resolved.token.name,
            address: resolved.token.address,
            kind: resolved.token.kind,
          },
        ];
      }
    }

    const wantsNative = resolvedSymbol === null || resolvedSymbol === "ETH";

    try {
      const [nativeRead, tokenReads] = await Promise.all([
        wantsNative
          ? getBalance(config, { address: wallet, chainId: CHAIN_ID }).catch(() => null)
          : Promise.resolve(null),
        tokens.length === 0
          ? Promise.resolve([])
          : readContracts(config, {
              allowFailure: true,
              contracts: tokens.flatMap((token) => [
                {
                  address: token.address as `0x${string}`,
                  abi: erc20Abi,
                  functionName: "balanceOf" as const,
                  args: [wallet] as const,
                },
                {
                  address: token.address as `0x${string}`,
                  abi: erc20Abi,
                  functionName: "decimals" as const,
                },
              ]),
            }).catch(() => null),
      ]);

      const assets: WalletBalanceAsset[] = tokens.map((token, index) => {
        const balanceRead = tokenReads?.[index * 2];
        const decimalsRead = tokenReads?.[index * 2 + 1];
        const balanceRaw =
          balanceRead?.status === "success" && typeof balanceRead.result === "bigint"
            ? balanceRead.result
            : null;
        const decimals =
          decimalsRead?.status === "success" && typeof decimalsRead.result === "number"
            ? decimalsRead.result
            : null;
        const human =
          balanceRaw !== null && decimals !== null ? formatUnits(balanceRaw, decimals) : null;
        return {
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          kind: token.kind,
          decimals,
          balanceRaw: balanceRaw !== null ? balanceRaw.toString() : "0",
          human,
          nonzero: balanceRaw !== null && balanceRaw > 0n,
          verified: true,
        };
      });

      const native = {
        symbol: "ETH" as const,
        decimals: 18 as const,
        balanceRaw: nativeRead ? nativeRead.value.toString() : "0",
        human: nativeRead ? formatUnits(nativeRead.value, 18) : null,
      };

      const data: WalletBalancesResult = {
        wallet,
        chainId: CHAIN_ID,
        asOf: new Date().toISOString(),
        native,
        assets,
        source: "Base RPC (balanceOf / eth_getBalance, session wallet)",
      };

      return toolSuccess("wallet_balances", data, {
        chainId: CHAIN_ID,
        source: data.source,
      });
    } catch {
      return toolError("wallet_balances", {
        code: "PROVIDER_ERROR",
        message: "Could not read your Base balances — the RPC provider may be busy. Safe to retry.",
        retryable: true,
      });
    }
  },
};

// --- registration -----------------------------------------------------------

const registry = getAgentToolRegistry();
if (!registry.has(walletBalancesTool.id)) {
  registry.register(walletBalancesTool);
}
