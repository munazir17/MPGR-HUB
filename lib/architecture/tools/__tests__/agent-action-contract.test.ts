import { describe, expect, it } from "vitest";
import {
  buildAgentActionContract,
  type AgentActionContractInput,
} from "../agent-action-contract";
import { MPGR_TOKEN_LOCK_CONFIG } from "@/lib/token-lock/token-lock-config";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import { MPGR_REWARD_VAULT_CONFIG } from "@/lib/reward-vault/reward-vault-config";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";

const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // +30 days

describe("buildAgentActionContract — valid actions", () => {
  it("accepts a valid tokenLock createLock action and resolves `to` to the Token Lock contract", () => {
    const result = buildAgentActionContract({
      domain: "tokenLock",
      actionType: "createLock",
      params: { amount: "1000000000000000000", unlockTime: String(future) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.to.toLowerCase()).toBe(MPGR_TOKEN_LOCK_CONFIG.address.toLowerCase());
    expect(result.action.value).toBe(0n);
    expect(result.action.requiresConfirmation).toBe(true);
    expect(result.action.phase).toBe("idle");
    expect(result.action.verified).toBe(false);
    expect(result.action.data.startsWith("0x")).toBe(true);
  });

  it("accepts a valid staking stake action and resolves `to` to the Staking contract", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      params: { amount: 500 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.to.toLowerCase()).toBe(MPGR_STAKING_CONFIG.address.toLowerCase());
  });

  it("accepts a valid staking approve action and resolves `to` to the MPGR token contract (not the staking contract)", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "approve",
      params: { amount: 500 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.to.toLowerCase()).toBe(MPGR_TOKEN_CONFIG.address.toLowerCase());
  });

  it("accepts a valid rewardVault claim action and resolves `to` to the Reward Vault contract", () => {
    const result = buildAgentActionContract({
      domain: "rewardVault",
      actionType: "claim",
      params: { rewardId: 3 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.to.toLowerCase()).toBe(MPGR_REWARD_VAULT_CONFIG.address.toLowerCase());
  });

  it("accepts claimMultiple with a batch of rewardIds", () => {
    const result = buildAgentActionContract({
      domain: "rewardVault",
      actionType: "claimMultiple",
      params: { rewardIds: [1, 2, 3] },
    });
    expect(result.ok).toBe(true);
  });
});

describe("buildAgentActionContract — rejects unknown/unsupported action shapes", () => {
  it("rejects an unknown domain", () => {
    const result = buildAgentActionContract({
      domain: "dex", // not implemented — DEX is explicitly frozen
      actionType: "swap",
      params: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_DOMAIN");
  });

  it("rejects a read-tool-shaped domain, so a read action can never become an executable action", () => {
    const result = buildAgentActionContract({
      domain: "wallet", // this is an AgentToolCategory, not an AgentActionDomain
      actionType: "wallet_analyzer",
      params: { address: "0x0000000000000000000000000000000000dEaD" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_DOMAIN");
  });

  it("rejects an unsupported actionType for a known domain", () => {
    const result = buildAgentActionContract({
      domain: "tokenLock",
      actionType: "selfDestruct",
      params: { lockId: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ACTION_TYPE");
  });

  it("rejects an admin-only staking action (setAPR is not a StakingActionKind)", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "setAPR",
      params: { newAPRBps: 999999 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ACTION_TYPE");
  });
});

describe("buildAgentActionContract — chain validation", () => {
  it("rejects an unsupported chainId", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      chainId: 1, // Ethereum mainnet — this app is Base-only
      params: { amount: 100 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_CHAIN");
  });

  it("accepts an explicit, correct chainId", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      chainId: MPGR_STAKING_CONFIG.chainId,
      params: { amount: 100 },
    });
    expect(result.ok).toBe(true);
  });
});

describe("buildAgentActionContract — value is never taken from input", () => {
  it("ignores a caller-supplied value field and always produces value: 0n", () => {
    // `value` is intentionally not part of AgentActionContractInput — cast
    // through `unknown` to simulate a caller (e.g. an LLM) sending it anyway.
    const input = {
      domain: "staking",
      actionType: "stake",
      params: { amount: 100 },
      value: "1000000000000000000000",
    } as unknown as AgentActionContractInput;
    const result = buildAgentActionContract(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.value).toBe(0n);
  });
});

describe("buildAgentActionContract — malformed / missing params rejected", () => {
  it("rejects a missing required field (createLock without unlockTime)", () => {
    const result = buildAgentActionContract({
      domain: "tokenLock",
      actionType: "createLock",
      params: { amount: "1000000000000000000" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects a negative amount", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      params: { amount: -1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects a non-integer amount", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      params: { amount: 1.5 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unsafe integer numbers at the transaction boundary", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      params: { amount: Number.MAX_SAFE_INTEGER + 1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects a malformed/non-numeric amount string (would otherwise reach calldata encoding)", () => {
    const result = buildAgentActionContract({
      domain: "tokenLock",
      actionType: "createLock",
      params: { amount: "not-a-number", unlockTime: String(future) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects createLock when unlockTime is in the past", () => {
    const result = buildAgentActionContract({
      domain: "tokenLock",
      actionType: "createLock",
      params: { amount: "1000000000000000000", unlockTime: "1" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects claimMultiple with an empty rewardIds array", () => {
    const result = buildAgentActionContract({
      domain: "rewardVault",
      actionType: "claimMultiple",
      params: { rewardIds: [] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects claimMultiple with a non-array rewardIds", () => {
    const result = buildAgentActionContract({
      domain: "rewardVault",
      actionType: "claimMultiple",
      params: { rewardIds: "1,2,3" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects params that are not an object at all", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "stake",
      params: "amount=100" as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_REQUIRED_FIELD");
  });
});

describe("buildAgentActionContract — LLM-like arbitrary/extra fields cannot bypass validation", () => {
  it("ignores an attacker-supplied `to`/`spender` override and still resolves the real contract address", () => {
    const result = buildAgentActionContract({
      domain: "staking",
      actionType: "approve",
      params: {
        amount: 100,
        // None of these are read by buildStakingAction's approve branch —
        // `to` is always resolved to MPGR_TOKEN_CONFIG.address, and the
        // spender is always MPGR_STAKING_CONFIG.address, regardless of
        // what extra fields are present here.
        to: "0x000000000000000000000000000000BADBEEF0",
        spender: "0x000000000000000000000000000000BADBEEF0",
        recipient: "0x000000000000000000000000000000BADBEEF0",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.to.toLowerCase()).toBe(MPGR_TOKEN_CONFIG.address.toLowerCase());
    // The real spender actually encoded into calldata is the staking
    // contract — confirm the attacker-supplied address never appears.
    expect(result.action.data.toLowerCase()).not.toContain("badbeef0");
  });

  it("does not let an execute-mode-shaped payload (requiresConfirmation: false) weaken the contract", () => {
    // requiresConfirmation is not a real params field; simulates a
    // malicious/careless caller trying to smuggle it in to disable
    // confirmation downstream. It must be silently ignored.
    const result = buildAgentActionContract({
      domain: "tokenLock",
      actionType: "withdraw",
      params: {
        lockId: 1,
        requiresConfirmation: false,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.requiresConfirmation).toBe(true);
  });
});

describe("buildAgentActionContract — deterministic / consistent representation", () => {
  it("produces the same id for the same (domain, actionType, params)", () => {
    const input: AgentActionContractInput = {
      domain: "rewardVault",
      actionType: "claim",
      params: { rewardId: 7 },
    };
    const first = buildAgentActionContract(input);
    const second = buildAgentActionContract({ ...input, params: { rewardId: 7 } });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.action.id).toBe(second.action.id);
    expect(first.action.data).toBe(second.action.data);
  });

  it("produces different ids for different actionTypes on the same domain", () => {
    const a = buildAgentActionContract({ domain: "staking", actionType: "stake", params: { amount: 1 } });
    const b = buildAgentActionContract({ domain: "staking", actionType: "unstake", params: { amount: 1 } });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.action.id).not.toBe(b.action.id);
  });
});
