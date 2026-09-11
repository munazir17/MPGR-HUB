import { describe, expect, it } from "vitest";
import {
  CHAIN_ID,
  MPGR_REWARD_VAULT_ADDRESS,
  MPGR_STAKING_ADDRESS,
  MPGR_TOKEN_ADDRESS,
  MPGR_TOKEN_LOCK_ADDRESS,
  explorerAddressUrl,
  explorerTxUrl,
} from "./base";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";
import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";

describe("Base chain registry", () => {
  it("is locked to Base mainnet 8453", () => {
    expect(CHAIN_ID).toBe(8453);
  });

  it("is the single source of token, staking, lock, and vault addresses", () => {
    expect(MPGR_TOKEN_CONFIG.address).toBe(MPGR_TOKEN_ADDRESS);
    expect(MPGR_TOKEN_CONFIG.chainId).toBe(CHAIN_ID);
    expect(MPGR_STAKING_CONFIG.address).toBe(MPGR_STAKING_ADDRESS);
    expect(MPGR_STAKING_CONFIG.stakingTokenAddress).toBe(MPGR_TOKEN_ADDRESS);
    expect(MPGR_TOKEN_LOCK_CONFIG.address).toBe(MPGR_TOKEN_LOCK_ADDRESS);
    expect(MPGR_TOKEN_LOCK_CONFIG.mpgrTokenAddress).toBe(MPGR_TOKEN_ADDRESS);
    expect(MPGR_REWARD_VAULT_CONFIG.address).toBe(MPGR_REWARD_VAULT_ADDRESS);
    expect(MPGR_REWARD_VAULT_CONFIG.tokenAddress).toBe(MPGR_TOKEN_ADDRESS);
  });

  it("builds BaseScan URLs from the registry explorer", () => {
    expect(explorerAddressUrl(MPGR_TOKEN_ADDRESS)).toContain("/address/");
    expect(explorerTxUrl("0xabc")).toBe("https://basescan.org/tx/0xabc");
  });
});
