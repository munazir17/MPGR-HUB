import { kvAllocationStore } from "./kv-allocation-store";
import { rewardVaultAdminClient } from "@/lib/reward-vault/reward-vault-admin-client";
import type { Address } from "viem";

/** Reconciles a durable `allocating` settlement against confirmed vault state. */
export async function reconcileSettlement(weekKey: string) {
  const settlement = await kvAllocationStore.getWeeklySettlement(weekKey);
  if (!settlement || settlement.status !== "allocating") return { status: settlement?.status ?? "missing", reconciled: false };
  const players = await kvAllocationStore.listEligiblePlayersForWeek(weekKey);
  const payable = players.filter((p) => (p.allocatedAmountRaw ?? 0n) > 0n);
  let confirmed = 0;
  for (const player of payable) {
    if (player.allocationStatus === "allocated" && player.rewardId !== null) { confirmed++; continue; }
    // The vault exposes reward IDs per user; inspect only the expected user and amount.
    const ids = await getUserRewardIds(player.wallet as Address);
    let match: bigint | null = null;
    for (const id of ids) {
      const reward = await rewardVaultAdminClient.getReward(id);
      if (reward.seasonId === player.seasonId && reward.user.toLowerCase() === player.wallet.toLowerCase() && reward.amount === player.allocatedAmountRaw && reward.rewardType === 0) { match = id; break; }
    }
    if (match !== null) {
      const txHash = await rewardVaultAdminClient.findRewardAllocationTxHash(match);
      if (!txHash) continue;
      await kvAllocationStore.upsertPlayerWeekRecord({ ...player, allocationStatus: "allocated", rewardId: match, allocationTxHash: txHash }, "pending");
      confirmed++;
    }
  }
  if (confirmed === payable.length) {
    const totalAllocatedRaw = payable.reduce((sum, player) => sum + (player.allocatedAmountRaw ?? 0n), 0n);
    await kvAllocationStore.recordTreasuryLedgerEntryOnce("GAME", weekKey, totalAllocatedRaw);
    const finalized = await kvAllocationStore.upsertWeeklySettlement({ ...settlement, status: "finalized", updatedAt: new Date().toISOString() }, "allocating");
    return { status: finalized.status, reconciled: true, confirmed };
  }
  return { status: "allocating", reconciled: true, confirmed, expected: payable.length };
}

async function getUserRewardIds(user: Address): Promise<bigint[]> {
  // getUserRewardIds is a view; the admin ABI contains it and the admin client
  // is server-only. This indirection keeps reconciliation independent of the browser wallet client.
  const { createPublicClient, http } = await import("viem");
  const { base } = await import("viem/chains");
  const { REWARD_VAULT_ADMIN_ABI } = await import("./reward-vault-admin-abi");
  const { MPGR_REWARD_VAULT_CONFIG } = await import("@/lib/reward-vault/reward-vault-config");
  const rpc = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
  const client = createPublicClient({ chain: base, transport: http(rpc) });
  return client.readContract({ address: MPGR_REWARD_VAULT_CONFIG.address, abi: REWARD_VAULT_ADMIN_ABI, functionName: "getUserRewardIds", args: [user] }) as Promise<bigint[]>;
}
