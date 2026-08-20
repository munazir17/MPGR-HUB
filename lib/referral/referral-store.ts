// lib/referral/referral-store.ts
//
// SERVER-ONLY.
// Upstash Redis-backed store for persistent referral attribution.
//
// Design (why a Redis SET, not a counter):
//   mpgrhub:referral:referrals:{referrerWallet} -> SET of referred wallets
//
// SADD is naturally idempotent — adding the same referred wallet twice
// is a no-op — so a referred user reconnecting their wallet (or the
// referral endpoint being called again) can NEVER inflate the
// referrer's count. The count is simply the set's cardinality
// (SCARD), always recomputed from the actual membership, never a
// separately-tracked number that could drift or double-count.
//
//   mpgrhub:referral:referredby:{referredWallet} -> referrer wallet
//
// Written with SETNX (set-if-absent) so a wallet is permanently
// attributed to the FIRST referrer it ever arrived through — later
// referral links (or a repeat visit with a different ?ref=) can never
// re-attribute or steal an already-attributed wallet.
//
// Same env vars as lib/reward-allocation/kv-allocation-store.ts.

import { Redis } from "@upstash/redis";

const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;

const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (!redisUrl || !redisToken) {
  throw new Error(
    "Upstash Redis environment variables are missing. Expected UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
  );
}

const kv = new Redis({
  url: redisUrl,
  token: redisToken,
});

function referralsSetKey(referrer: string) {
  return `mpgrhub:referral:referrals:${referrer}`;
}

function referredByKey(referred: string) {
  return `mpgrhub:referral:referredby:${referred}`;
}

function normalize(wallet: string): string {
  return wallet.toLowerCase();
}

export type RegisterReferralResult =
  | { status: "registered"; referrer: string }
  | { status: "already-attributed"; referrer: string }
  | { status: "self-referral" }
  | { status: "invalid" };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export const referralStore = {
  // Permanently associates `referred` -> referred by `referrer`, the
  // FIRST time it happens for this wallet, and only that time.
  async registerReferral(
    referrerInput: string,
    referredInput: string
  ): Promise<RegisterReferralResult> {
    if (
      typeof referrerInput !== "string" ||
      typeof referredInput !== "string" ||
      !ADDRESS_RE.test(referrerInput) ||
      !ADDRESS_RE.test(referredInput)
    ) {
      return { status: "invalid" };
    }

    const referrer = normalize(referrerInput);
    const referred = normalize(referredInput);

    if (referrer === referred) {
      return { status: "self-referral" };
    }

    // SETNX: only succeeds if this wallet has never been attributed
    // before. This is the operation that makes the whole flow
    // idempotent — reconnecting the same wallet, or re-visiting the
    // referral link, can never change or duplicate the attribution.
    const setResult = await kv.set(referredByKey(referred), referrer, {
      nx: true,
    });

    if (setResult === null) {
      // Already attributed (to this referrer or a different one).
      const existing = await kv.get<string>(referredByKey(referred));
      return {
        status: "already-attributed",
        referrer: existing ?? referrer,
      };
    }

    // SADD is idempotent by nature — safe even under a race with the
    // SETNX above, and safe if ever called twice for the same pair.
    await kv.sadd(referralsSetKey(referrer), referred);

    return { status: "registered", referrer };
  },

  async getReferralCount(walletInput: string): Promise<number> {
    const wallet = normalize(walletInput);
    return kv.scard(referralsSetKey(wallet));
  },

  async getReferrer(walletInput: string): Promise<string | null> {
    const wallet = normalize(walletInput);
    const referrer = await kv.get<string>(referredByKey(wallet));
    return referrer ?? null;
  },
};
