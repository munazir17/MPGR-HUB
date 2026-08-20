// lib/architecture/tools/tool-definitions.ts
//
// P0.2 — the five read-only tools from the roadmap, now actually
// implemented. Every one of these is a fact tool: it reads real state
// from Base Mainnet (via the existing lib/token/, lib/staking/,
// lib/token-lock/, lib/reward-vault/ modules) or from this app's own
// compile-time config, and returns exactly that — no LLM calls, no
// scores, no "analysis" prose, no invented numbers.
//
// requiresWallet is `false` on all five: unlike P0.1's placeholder
// assumption, every tool here takes the address it analyzes as an
// explicit `{ address }` input argument rather than implicitly reading
// AgentToolContext.walletAddress — so a caller can ask about any Base
// address, not only the currently-connected one, and the runtime's
// "requires a connected wallet" gate would be the wrong check for that.
//
// No market-data provider (DexScreener, CoinGecko, etc.) exists
// anywhere in this codebase — confirmed by inspection before writing
// this file. market_intelligence is registered per the spec, but its
// execute() always returns ok:false / DATA_UNAVAILABLE rather than
// inventing a vendor integration in this session.
//
// Importing this module registers every tool below into
// getAgentToolRegistry()'s current instance as a side effect — see
// agent-tool-runtime-instance.ts, the one place that imports it.

import { getBalance, getBytecode, getTransactionCount, readContract } from "wagmi/actions";
import { formatUnits, parseAbi, type Address } from "viem";
import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";

import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import { tokenClient } from "@/lib/token/token-client";
import { tokenService } from "@/lib/token/token-service";
import { transactionHistoryService } from "@/lib/token/transaction-history-service";

import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import { stakingService } from "@/lib/staking/staking-service";

import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";
import { tokenLockClient } from "@/lib/token-lock/token-lock-client";

import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";
import { rewardVaultService } from "@/lib/reward-vault/reward-vault-service";
import { VaultRewardStatus } from "@/lib/reward-vault/reward-vault-types";

// XP / Holder Tier / Season Pass — these three engines persist their
// state in browser localStorage (see lib/xp-engine.ts's storage layer);
// there is no RPC or server-side source for them. portfolio_analyzer
// reads them directly (not through AgentContext — that snapshot is tied
// to "the currently connected wallet in this chat session", not to an
// arbitrary `{ address }` input) but only when actually running in a
// browser (see that tool's execute()).
import { getUserRecord, getLevelProgress } from "@/lib/xp-engine";
import { getHolderTierStatus } from "@/lib/holder-tier-engine";
import { getSeasonPassStatus } from "@/lib/season-engine";

import type { AgentTool, AgentToolSchema } from "./agent-tool";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { toolError, toolSuccess } from "./agent-tool-result";
import { normalizeAddressInput, readOrProviderError, rejectUnsupportedChain, TOOL_CHAIN_ID } from "./tool-helpers";

// --- Shared input schema -----------------------------------------------------
//
// All five tools take the same shape: the Base address to read, plus an
// optional chainId the caller can pass to be explicit — if given, it
// must be Base Mainnet (8453) or the tool rejects with
// CHAIN_UNSUPPORTED. This app only ever configures one chain
// (lib/wagmi.ts: `chains: [base]`), so there is no other chain any of
// these tools could legitimately read from regardless.
const addressInputSchema: AgentToolSchema = {
  type: "object",
  properties: {
    address: {
      type: "string",
      description: "0x-prefixed Base address — a wallet or a contract, depending on the tool.",
    },
    chainId: {
      type: "number",
      description: "Optional. Must be 8453 (Base Mainnet) if provided.",
    },
  },
  required: ["address"],
};

// Known MPGR-ecosystem contract addresses, sourced only from this app's
// own compile-time config — never guessed. Shared by token_analyzer
// (does this token address belong to MPGR?) and base_research (is this
// address one of MPGR's own deployed contracts?).
const KNOWN_MPGR_CONTRACTS: Record<string, string> = {
  [MPGR_TOKEN_CONFIG.address.toLowerCase()]: "MPGR Token",
  [MPGR_STAKING_CONFIG.address.toLowerCase()]: "MPGR Staking",
  [MPGR_TOKEN_LOCK_CONFIG.address.toLowerCase()]: "MPGR Token Lock",
  [MPGR_REWARD_VAULT_CONFIG.address.toLowerCase()]: "MPGR Reward Vault",
};

// =============================================================================
// 1. wallet_analyzer
// =============================================================================

export const walletAnalyzerTool: AgentTool = {
  id: "wallet_analyzer",
  name: "Wallet Analyzer",
  description:
    "Reads a Base wallet's native ETH balance, MPGR balance, and recent MPGR transfer history. Facts only — no labels, no behavior/risk narrative, no PnL story.",
  category: "wallet",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: addressInputSchema,
  async execute(input) {
    const { address: rawAddress, chainId } = (input ?? {}) as { address?: unknown; chainId?: unknown };

    const chainErr = rejectUnsupportedChain(chainId);
    if (chainErr) return toolError("wallet_analyzer", chainErr, { chainId: TOOL_CHAIN_ID });

    const addrResult = normalizeAddressInput(rawAddress);
    if (!addrResult.ok) return toolError("wallet_analyzer", addrResult.error, { chainId: TOOL_CHAIN_ID });
    const address = addrResult.address;

    const nativeRead = await readOrProviderError("native ETH balance", () =>
      getBalance(config, { address, chainId: TOOL_CHAIN_ID })
    );
    if (!nativeRead.ok) {
      return toolError("wallet_analyzer", nativeRead.error, {
        chainId: TOOL_CHAIN_ID,
        source: "wagmi/actions:getBalance",
      });
    }

    const mpgrRead = await readOrProviderError("MPGR balance", () => tokenClient.getBalanceRaw(address));
    if (!mpgrRead.ok) {
      return toolError("wallet_analyzer", mpgrRead.error, {
        chainId: TOOL_CHAIN_ID,
        source: "lib/token/token-client",
      });
    }

    // Never throws — transactionHistoryService degrades to cached/empty
    // data on an RPC blip rather than propagating an exception. Capped
    // to this service's own default page size (20).
    const recentTransfers = await transactionHistoryService.getHistory(address, { limit: 20 });

    return toolSuccess(
      "wallet_analyzer",
      {
        address,
        nativeBalance: {
          raw: nativeRead.value.value.toString(),
          formatted: nativeRead.value.formatted,
          symbol: nativeRead.value.symbol,
        },
        tokenBalances: [
          {
            symbol: MPGR_TOKEN_CONFIG.symbol,
            address: MPGR_TOKEN_CONFIG.address,
            raw: mpgrRead.value.toString(),
            formatted: tokenClient.formatBalance(mpgrRead.value, MPGR_TOKEN_CONFIG.decimals),
            decimals: MPGR_TOKEN_CONFIG.decimals,
          },
        ],
        recentTransactions: recentTransfers.map((t) => ({
          txHash: t.txHash,
          blockNumber: t.blockNumber.toString(),
          timestamp: t.timestamp,
          direction: t.direction,
          counterparty: t.direction === "in" ? t.from : t.to,
          amount: { raw: t.amount.raw.toString(), formatted: t.amount.formatted },
        })),
        recentTransactionsNote:
          "MPGR Transfer events only (lib/token/transaction-history-service.ts) — not a general Base activity feed; other-token or ETH transfers are not included.",
      },
      { chainId: TOOL_CHAIN_ID, source: "wagmi/actions:getBalance + lib/token" }
    );
  },
};

// =============================================================================
// 2. token_analyzer
// =============================================================================

export const tokenAnalyzerTool: AgentTool = {
  id: "token_analyzer",
  name: "Token Analyzer",
  description:
    "Reads a Base token contract's onchain metadata (address, symbol, name, decimals, totalSupply) and, for MPGR specifically, its known ecosystem contract addresses. No honeypot verdict, no buy/sell thesis, no tax/fee guesses.",
  category: "token",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: addressInputSchema,
  async execute(input) {
    const { address: rawAddress, chainId } = (input ?? {}) as { address?: unknown; chainId?: unknown };

    const chainErr = rejectUnsupportedChain(chainId);
    if (chainErr) return toolError("token_analyzer", chainErr, { chainId: TOOL_CHAIN_ID });

    const addrResult = normalizeAddressInput(rawAddress);
    if (!addrResult.ok) return toolError("token_analyzer", addrResult.error, { chainId: TOOL_CHAIN_ID });
    const address = addrResult.address;
    const lower = address.toLowerCase();

    const isMPGR = lower === MPGR_TOKEN_CONFIG.address.toLowerCase();

    if (isMPGR) {
      try {
        // Cached (1h TTL) — see lib/token/token-service.ts. Falls back to
        // MPGR_TOKEN_CONFIG's compile-time defaults with totalSupply 0n
        // internally on RPC failure, which would misrepresent supply as
        // zero, so that internal fallback is not trusted here — an RPC
        // failure surfaces as PROVIDER_ERROR instead of a fabricated 0n.
        const metadata = await tokenService.getMetadata();
        if (metadata.totalSupply === 0n) {
          throw new Error("token-service returned a zero total supply — treating as an unresolved read, not a real value");
        }
        return toolSuccess(
          "token_analyzer",
          {
            address: MPGR_TOKEN_CONFIG.address,
            name: metadata.name,
            symbol: metadata.symbol,
            decimals: metadata.decimals,
            totalSupply: metadata.totalSupply.toString(),
            isMPGR: true,
            isKnownMpgrContract: true,
            knownContractLabel: "MPGR Token",
            mpgrConfig: {
              stakingContractAddress: MPGR_STAKING_CONFIG.address,
              tokenLockContractAddress: MPGR_TOKEN_LOCK_CONFIG.address,
              rewardVaultContractAddress: MPGR_REWARD_VAULT_CONFIG.address,
            },
          },
          { chainId: TOOL_CHAIN_ID, source: "lib/token/token-service (cached, 1h TTL)" }
        );
      } catch (err) {
        // Logged for server-side diagnostics only — the raw exception
        // message is never put into the user-facing AgentToolError; see
        // tool-helpers.ts's readOrProviderError for why.
        console.error("token_analyzer: failed to read MPGR metadata", err);
        return toolError(
          "token_analyzer",
          {
            code: "PROVIDER_ERROR",
            message: "Failed to read MPGR metadata from Base — the RPC provider may be temporarily unavailable. This is safe to retry.",
            retryable: true,
          },
          { chainId: TOOL_CHAIN_ID }
        );
      }
    }

    // Generic ERC20 path for any other Base token contract — direct
    // reads, not routed through the MPGR-only tokenClient/tokenService.
    // Reuses the existing erc20Abi (symbol/decimals) plus the same
    // inline name()/totalSupply() ABI-fragment pattern
    // lib/token/token-client.ts already uses for MPGR — no second ABI
    // layer.
    const nameAbi = parseAbi(["function name() view returns (string)"]);
    const totalSupplyAbi = parseAbi(["function totalSupply() view returns (uint256)"]);

    const [symbolResult, decimalsResult, nameResult, totalSupplyResult] = await Promise.allSettled([
      readContract(config, { address, abi: erc20Abi, functionName: "symbol", chainId: TOOL_CHAIN_ID }),
      readContract(config, { address, abi: erc20Abi, functionName: "decimals", chainId: TOOL_CHAIN_ID }),
      readContract(config, { address, abi: nameAbi, functionName: "name", chainId: TOOL_CHAIN_ID }),
      readContract(config, { address, abi: totalSupplyAbi, functionName: "totalSupply", chainId: TOOL_CHAIN_ID }),
    ]);

    const symbol = symbolResult.status === "fulfilled" ? symbolResult.value : null;
    const decimals = decimalsResult.status === "fulfilled" ? decimalsResult.value : null;
    const name = nameResult.status === "fulfilled" ? nameResult.value : null;
    const totalSupply = totalSupplyResult.status === "fulfilled" ? totalSupplyResult.value.toString() : null;

    // If every basic field failed, this almost certainly isn't a
    // standard ERC20 contract (or the address has no code at all) —
    // report DATA_UNAVAILABLE rather than a result of all-nulls.
    if (symbol === null && decimals === null && name === null) {
      return toolError(
        "token_analyzer",
        {
          code: "DATA_UNAVAILABLE",
          message: "This address does not expose standard ERC20 symbol/decimals/name — not a readable token contract.",
        },
        { chainId: TOOL_CHAIN_ID }
      );
    }

    return toolSuccess(
      "token_analyzer",
      {
        address,
        name,
        symbol,
        decimals,
        totalSupply,
        isMPGR: false,
        isKnownMpgrContract: lower in KNOWN_MPGR_CONTRACTS,
        knownContractLabel: KNOWN_MPGR_CONTRACTS[lower] ?? null,
      },
      { chainId: TOOL_CHAIN_ID, source: "onchain ERC20 read via wagmi/actions:readContract" }
    );
  },
};

// =============================================================================
// 3. portfolio_analyzer
// =============================================================================

export const portfolioAnalyzerTool: AgentTool = {
  id: "portfolio_analyzer",
  name: "Portfolio Analyzer",
  description:
    "Reads a wallet's MPGR Hub product positions: liquid MPGR, staked balance + earned rewards, active token-lock positions, pending reward-vault allocations, and (when run in-browser) XP/Holder Tier/Season Pass status. No health/allocation commentary, no USD values (no price provider is wired).",
  category: "portfolio",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: addressInputSchema,
  async execute(input) {
    const { address: rawAddress, chainId } = (input ?? {}) as { address?: unknown; chainId?: unknown };

    const chainErr = rejectUnsupportedChain(chainId);
    if (chainErr) return toolError("portfolio_analyzer", chainErr, { chainId: TOOL_CHAIN_ID });

    const addrResult = normalizeAddressInput(rawAddress);
    if (!addrResult.ok) return toolError("portfolio_analyzer", addrResult.error, { chainId: TOOL_CHAIN_ID });
    const address = addrResult.address;

    // Liquid MPGR is the one field this tool cannot meaningfully omit —
    // a failure here fails the whole call (spec: "On RPC/provider
    // failure: ok:false"). Every field below this is additive
    // (a different contract/engine each), so a failure in one of them
    // marks just that field unavailable instead of hiding the wallet's
    // core liquid balance.
    const liquidRead = await readOrProviderError("liquid MPGR balance", () => tokenClient.getBalanceRaw(address));
    if (!liquidRead.ok) {
      return toolError("portfolio_analyzer", liquidRead.error, { chainId: TOOL_CHAIN_ID, source: "lib/token/token-client" });
    }
    const liquidMPGR = {
      raw: liquidRead.value.toString(),
      formatted: tokenClient.formatBalance(liquidRead.value, MPGR_TOKEN_CONFIG.decimals),
    };

    const unavailableFields: string[] = [];

    let staking: {
      stakedRaw: string;
      stakedFormatted: string;
      earnedRewardsRaw: string;
      earnedRewardsFormatted: string;
    } | null = null;
    try {
      const state = await stakingService.getWalletState(address as Address);
      staking = {
        stakedRaw: state.stakedBalance.toString(),
        stakedFormatted: formatUnits(state.stakedBalance, MPGR_TOKEN_CONFIG.decimals),
        earnedRewardsRaw: state.earnedRewards.toString(),
        earnedRewardsFormatted: formatUnits(state.earnedRewards, MPGR_TOKEN_CONFIG.decimals),
      };
    } catch {
      unavailableFields.push("staking");
    }

    let tokenLock: {
      lockCount: number;
      totalLockedRaw: string;
      totalLockedFormatted: string;
      locks: { id: string; amountRaw: string; amountFormatted: string; unlockTime: string; withdrawn: boolean }[];
    } | null = null;
    try {
      const lockIds = await tokenLockClient.getUserLockIds(address as Address);
      const locks = await Promise.all(lockIds.map((id) => tokenLockClient.getLock(id)));
      const activeTotal = locks.filter((l) => !l.withdrawn).reduce((sum, l) => sum + l.amount, 0n);
      tokenLock = {
        lockCount: lockIds.length,
        totalLockedRaw: activeTotal.toString(),
        totalLockedFormatted: formatUnits(activeTotal, MPGR_TOKEN_LOCK_CONFIG.decimals),
        locks: locks.map((l, i) => ({
          id: lockIds[i].toString(),
          amountRaw: l.amount.toString(),
          amountFormatted: formatUnits(l.amount, MPGR_TOKEN_LOCK_CONFIG.decimals),
          unlockTime: l.unlockTime.toString(),
          withdrawn: l.withdrawn,
        })),
      };
    } catch {
      unavailableFields.push("tokenLock");
    }

    let pendingRewards: {
      pendingCount: number;
      pendingRaw: string;
      pendingFormatted: string;
      claimableCount: number;
    } | null = null;
    try {
      const rewards = await rewardVaultService.getWalletRewards(address as Address);
      const allocated = rewards.filter((r) => r.status === VaultRewardStatus.ALLOCATED);
      const pendingRaw = allocated.reduce((sum, r) => sum + r.amount, 0n);
      pendingRewards = {
        pendingCount: allocated.length,
        pendingRaw: pendingRaw.toString(),
        pendingFormatted: formatUnits(pendingRaw, MPGR_REWARD_VAULT_CONFIG.decimals),
        claimableCount: allocated.filter((r) => r.isClaimable).length,
      };
    } catch {
      unavailableFields.push("rewardVault");
    }

    // XP / Holder Tier / Season Pass live in browser localStorage only
    // (see the header comment above) — there is no server-side source
    // for them. Reading them outside a browser session would either
    // fabricate a false zero or leak one browser's local state as if it
    // were this address's real status, so they're explicitly marked
    // unavailable rather than read at all in that case.
    let xp: { xp: number; level: number; streak: number; referralCount: number } | null = null;
    let holderTier: { tierLabel: string | null; totalScore: number; votingWeight: number } | null = null;
    let season: { seasonNumber: number; seasonPoints: number; level: number } | null = null;

    if (typeof window === "undefined") {
      unavailableFields.push("xp", "holderTier", "season");
    } else {
      try {
        const record = getUserRecord(address);
        const levelInfo = getLevelProgress(record.xp);
        xp = { xp: record.xp, level: levelInfo.level, streak: record.streak, referralCount: record.referralCount };
      } catch {
        unavailableFields.push("xp");
      }
      try {
        const status = getHolderTierStatus(address);
        holderTier = {
          tierLabel: status.currentTierDef?.label ?? null,
          totalScore: status.score.totalScore,
          votingWeight: status.votingWeight,
        };
      } catch {
        unavailableFields.push("holderTier");
      }
      try {
        const status = getSeasonPassStatus(address);
        season = { seasonNumber: status.seasonNumber, seasonPoints: status.seasonPoints, level: status.levelProgress.level };
      } catch {
        unavailableFields.push("season");
      }
    }

    return toolSuccess(
      "portfolio_analyzer",
      { address, liquidMPGR, staking, tokenLock, pendingRewards, xp, holderTier, season, unavailableFields },
      {
        chainId: TOOL_CHAIN_ID,
        source: "lib/token + lib/staking + lib/token-lock + lib/reward-vault (+ lib/xp-engine/holder-tier-engine/season-engine client-side only)",
      }
    );
  },
};

// =============================================================================
// 4. base_research
// =============================================================================

export const baseResearchTool: AgentTool = {
  id: "base_research",
  name: "Base Research",
  description:
    "Reads whether a Base address is a contract or EOA (eth_getCode), its nonce, its most recent MPGR transfer activity if any, and whether it matches a known MPGR Hub contract. No ecosystem roundups, no protocol essays, no news, no unverified explorer scraping.",
  category: "research",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: addressInputSchema,
  async execute(input) {
    const { address: rawAddress, chainId } = (input ?? {}) as { address?: unknown; chainId?: unknown };

    const chainErr = rejectUnsupportedChain(chainId);
    if (chainErr) return toolError("base_research", chainErr, { chainId: TOOL_CHAIN_ID });

    const addrResult = normalizeAddressInput(rawAddress);
    if (!addrResult.ok) return toolError("base_research", addrResult.error, { chainId: TOOL_CHAIN_ID });
    const address = addrResult.address;

    const codeRead = await readOrProviderError("bytecode", () => getBytecode(config, { address, chainId: TOOL_CHAIN_ID }));
    if (!codeRead.ok) {
      return toolError("base_research", codeRead.error, { chainId: TOOL_CHAIN_ID, source: "wagmi/actions:getBytecode" });
    }

    const nonceRead = await readOrProviderError("transaction count", () =>
      getTransactionCount(config, { address, chainId: TOOL_CHAIN_ID })
    );
    if (!nonceRead.ok) {
      return toolError("base_research", nonceRead.error, {
        chainId: TOOL_CHAIN_ID,
        source: "wagmi/actions:getTransactionCount",
      });
    }

    const isContract = !!codeRead.value && codeRead.value !== "0x";

    // Never throws — degrades to cached/empty on RPC failure. Only
    // reflects MPGR transfers (this app's only tx history source), not
    // general Base activity.
    let lastActivity: { txHash: string; blockNumber: string; timestamp: string; note: string } | null = null;
    const history = await transactionHistoryService.getHistory(address, { limit: 1 });
    if (history[0]) {
      lastActivity = {
        txHash: history[0].txHash,
        blockNumber: history[0].blockNumber.toString(),
        timestamp: history[0].timestamp,
        note: "Most recent MPGR transfer event only — not general Base activity.",
      };
    }

    const knownContractLabel = KNOWN_MPGR_CONTRACTS[address.toLowerCase()] ?? null;

    return toolSuccess(
      "base_research",
      { address, isContract, nonce: nonceRead.value, lastActivity, knownContractLabel },
      {
        chainId: TOOL_CHAIN_ID,
        source: "wagmi/actions:getBytecode + getTransactionCount + lib/token/transaction-history-service",
      }
    );
  },
};

// =============================================================================
// 5. market_intelligence
// =============================================================================

export const marketIntelligenceTool: AgentTool = {
  id: "market_intelligence",
  name: "Market Intelligence",
  description:
    "Would surface priceUsd/volume24h/liquidityUsd/priceChange24h from an existing market-data provider. No such provider (DexScreener, CoinGecko, etc.) is currently wired into this codebase, so this tool always reports the data as unavailable rather than inventing a quote.",
  category: "market",
  mode: "read",
  riskLevel: "low",
  requiresWallet: false,
  requiresConfirmation: false,
  inputSchema: addressInputSchema,
  async execute(input) {
    const { address: rawAddress, chainId } = (input ?? {}) as { address?: unknown; chainId?: unknown };

    const chainErr = rejectUnsupportedChain(chainId);
    if (chainErr) return toolError("market_intelligence", chainErr, { chainId: TOOL_CHAIN_ID });

    const addrResult = normalizeAddressInput(rawAddress);
    if (!addrResult.ok) return toolError("market_intelligence", addrResult.error, { chainId: TOOL_CHAIN_ID });

    // Confirmed by repo-wide inspection before implementing P0.2: no
    // DexScreener/CoinGecko/CoinMarketCap/GeckoTerminal (or any other
    // market-data vendor) client exists anywhere in this codebase. Per
    // the P0.2 spec, this session does not add one — so there is no
    // real priceUsd/volume24h/liquidityUsd/priceChange24h to return.
    return toolError(
      "market_intelligence",
      {
        code: "DATA_UNAVAILABLE",
        message:
          "No market-data provider is wired into this codebase — priceUsd, volume24h, liquidityUsd, and priceChange24h cannot be read without inventing a value.",
        retryable: false,
      },
      { chainId: TOOL_CHAIN_ID, source: "none — no market-data provider exists in this codebase" }
    );
  },
};

// --- Registration -------------------------------------------------------------

const registry = getAgentToolRegistry();
for (const tool of [
  walletAnalyzerTool,
  tokenAnalyzerTool,
  portfolioAnalyzerTool,
  baseResearchTool,
  marketIntelligenceTool,
]) {
  if (!registry.has(tool.id)) registry.register(tool);
      }
