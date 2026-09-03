// lib/trade/trade-types.ts
//
// P4 — shared types for CDP Trade API quotes and tokenized-stock research.
// Amounts are always atomic-unit decimal strings (never invented floats).

import type { Address, Hex } from "viem";

export const TRADE_PROPOSAL_PHASES = [
  "idle",
  "validating",
  "awaiting_approval",
  "awaiting_signature",
  "submitting",
  "success",
  "error",
] as const;
export type TradeProposalPhase = (typeof TRADE_PROPOSAL_PHASES)[number];

export const TRADE_KINDS = ["swap", "tokenized-stock-swap"] as const;
export type TradeKind = (typeof TRADE_KINDS)[number];

export const TRADE_TOKEN_KINDS = [
  "native",
  "erc20",
  "b20-tokenized-stock",
] as const;
export type TradeTokenKind = (typeof TRADE_TOKEN_KINDS)[number];

export interface TradeTokenRef {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: TradeTokenKind;
  /** True only when the address is in this app's compile-time catalog. */
  verified: boolean;
}

export interface CdpSwapFee {
  amount: string;
  token: string;
}

export interface CdpSwapFees {
  gasFee?: CdpSwapFee;
  protocolFee?: CdpSwapFee;
}

export interface CdpAllowanceIssue {
  currentAllowance: string;
  spender: string;
}

export interface CdpBalanceIssue {
  token: string;
  currentBalance: string;
  requiredBalance: string;
}

export interface CdpSwapIssues {
  allowance: CdpAllowanceIssue | null;
  balance: CdpBalanceIssue | null;
  simulationIncomplete: boolean;
}

export interface CdpSwapTransaction {
  to: Address;
  data: Hex;
  gas?: string;
  gasPrice?: string;
  value: string;
}

export interface CdpPermit2Eip712 {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface CdpPermit2 {
  hash?: Hex;
  eip712: CdpPermit2Eip712;
}

export interface CdpSwapPrice {
  liquidityAvailable: boolean;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  minToAmount: string;
  fees?: CdpSwapFees;
  issues?: CdpSwapIssues;
}

export interface CdpSwapQuote extends CdpSwapPrice {
  blockNumber?: string;
  transaction: CdpSwapTransaction | null;
  permit2: CdpPermit2 | null;
}

export type TradeRiskSeverity = "info" | "warning" | "critical";

export interface TradeRiskFact {
  id: string;
  severity: TradeRiskSeverity;
  title: string;
  detail: string;
}

export interface TradeProposal {
  id: string;
  kind: TradeKind;
  network: "base";
  chainId: 8453;
  provider: "cdp-trade-api";
  providerLabel: string;
  from: TradeTokenRef;
  to: TradeTokenRef;
  fromAmount: string;
  toAmount: string;
  minToAmount: string;
  slippageBps: number;
  taker: Address;
  liquidityAvailable: boolean;
  executionAvailable: boolean;
  quotedAt: string;
  expiresAt: string;
  fees: CdpSwapFees;
  issues: CdpSwapIssues;
  transaction: CdpSwapTransaction | null;
  permit2: CdpPermit2 | null;
  needsPermit2Approval: boolean;
  permit2Spender: Address | null;
  risk: readonly TradeRiskFact[];
  warnings: readonly string[];
  displayFromAmount: string;
  displayToAmount: string;
  displayMinToAmount: string;
  description: string;
  postConfirmationSteps: readonly string[];
  requiresConfirmation: true;
  phase: TradeProposalPhase;
}

export interface TradeError {
  code:
    | "INVALID_INPUT"
    | "UNSUPPORTED_NETWORK"
    | "UNSUPPORTED_ASSET"
    | "WALLET_REQUIRED"
    | "CREDENTIALS_MISSING"
    | "LIQUIDITY_UNAVAILABLE"
    | "QUOTE_EXPIRED"
    | "QUOTE_CHANGED"
    | "PROVIDER_ERROR"
    | "WALLET_REJECTED"
    | "SIGNING_FAILED"
    | "SEND_FAILED"
    | "APPROVAL_FAILED"
    | "EXECUTION_UNAVAILABLE";
  message: string;
}

export interface TokenizedStockCatalogEntry {
  ticker: string;
  symbol: string;
  name: string;
  underlyingTicker: string;
  address: Address;
  chainId: 8453;
  network: "base";
  standard: "B20";
  issuer: "Coinbase";
  chainlinkFeed: Address;
  /** Holding / secondary-market trading is permissionless per Base docs. */
  secondaryMarket: "permissionless";
  /**
   * Primary mint/redeem is Authorized Participant only.
   * There is no public Coinbase retail mint/redeem API.
   */
  primaryMintRedeem: "authorized-participant-only";
}

export interface TokenizedStockOnchainState {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: string | null;
  multiplierWad: string | null;
  multiplier: string | null;
  paused: boolean | null;
  chainlinkPriceUsd: string | null;
  chainlinkUpdatedAt: number | null;
  impliedTokenPriceUsd: string | null;
}

export interface TokenizedStockResearch {
  catalog: TokenizedStockCatalogEntry;
  onchain: TokenizedStockOnchainState;
  liquidity: {
    checked: boolean;
    quoteAsset: "USDC";
    liquidityAvailable: boolean | null;
    reason: string;
  };
  execution: {
    available: boolean;
    method: "cdp-trade-api-swap" | "none";
    reason: string;
  };
  risk: readonly TradeRiskFact[];
  sources: readonly string[];
}

export type TokenizedStockReport =
  | {
      kind: "catalog";
      network: "base";
      standard: "B20";
      issuer: "Coinbase";
      registry: Address;
      assets: TokenizedStockCatalogEntry[];
      notes: readonly string[];
    }
  | {
      kind: "research";
      report: TokenizedStockResearch;
    };
