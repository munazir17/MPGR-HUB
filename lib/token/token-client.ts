// lib/token/token-client.ts

import { getBalance, readContract } from "wagmi/actions";
import { formatUnits, parseAbi, type Address } from "viem";
import { config } from "@/lib/wagmi";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import { erc20Abi } from "@/lib/erc20-abi";
import type { TokenBalance, TokenMetadata } from "./token-types";

// Phase 3E Part 1 — Token Client.
//
// Low-level wagmi/viem integration for reading token data directly from
// the blockchain. Never calls the refresh manager or cache layer — this
// is pure RPC communication, used by both balance-service and token-service.
// All errors are caught and returned as strings, never thrown — calling code
// decides how to handle them (log, retry, fallback, etc.).

export const tokenClient = {
  // Reads a wallet's raw MPGR balance in smallest units (wei for 18-decimal
  // tokens). Returns bigint unchanged so downstream can format or math with it.
  async getBalanceRaw(walletAddress: Address): Promise<bigint> {
    try {
      const balance = await getBalance(config, {
        address: walletAddress,
        token: MPGR_TOKEN_CONFIG.address,
      });
      return balance.value;
    } catch (err) {
      console.error("tokenClient.getBalanceRaw failed", { walletAddress, error: err });
      throw new Error(`Failed to fetch raw balance: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // Formats a raw balance (bigint) into a human-readable decimal string using
  // the token's decimals. Always returns a string, even if the number is huge.
  formatBalance(rawBalance: bigint, decimals: number): string {
    try {
      return formatUnits(rawBalance, decimals);
    } catch (err) {
      console.error("tokenClient.formatBalance failed", { rawBalance, decimals, error: err });
      return "0";
    }
  },

  // Reads token decimals (e.g., 18 for most ERC20s). Cached by the token-service
  // to avoid repeated RPC calls — this function only runs once per session
  // (unless cache expires).
  async getDecimals(): Promise<number> {
    try {
      const decimals = await readContract(config, {
        address: MPGR_TOKEN_CONFIG.address,
        abi: erc20Abi,
        functionName: "decimals",
      });
      return decimals;
    } catch (err) {
      console.error("tokenClient.getDecimals failed", { error: err });
      throw new Error(`Failed to fetch decimals: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // Reads the token symbol (e.g., "MPGR"). Also metadata — cached once per session.
  async getSymbol(): Promise<string> {
    try {
      const symbol = await readContract(config, {
        address: MPGR_TOKEN_CONFIG.address,
        abi: erc20Abi,
        functionName: "symbol",
      });
      return symbol;
    } catch (err) {
      console.error("tokenClient.getSymbol failed", { error: err });
      throw new Error(`Failed to fetch symbol: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // Reads the token name (e.g., "MPGR"). Metadata — cached once per session.
  async getName(): Promise<string> {
    try {
      const nameAbi = parseAbi(["function name() view returns (string)"]);
      const name = await readContract(config, {
        address: MPGR_TOKEN_CONFIG.address,
        abi: nameAbi,
        functionName: "name",
      });
      return name;
    } catch (err) {
      console.error("tokenClient.getName failed", { error: err });
      throw new Error(`Failed to fetch name: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // Reads total supply (all tokens ever minted, less any burned). Used for
  // market cap and "% of supply" calculations. Metadata — cached once per session.
  async getTotalSupply(decimals: number): Promise<bigint> {
    try {
      const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)"]);
      const supply = await readContract(config, {
        address: MPGR_TOKEN_CONFIG.address,
        abi: supplyAbi,
        functionName: "totalSupply",
      });
      return supply;
    } catch (err) {
      console.error("tokenClient.getTotalSupply failed", { error: err });
      throw new Error(`Failed to fetch total supply: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
} as const;
