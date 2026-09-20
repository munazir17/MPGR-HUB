// lib/referral/referral-store.ts
//
// SERVER-ONLY.
// Upstash Redis-backed store for persistent referral attribution and
// (Task 8) abuse-hardened referral rewards.
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
// --- Task 8: reward state machine (attribution stays, reward defers) ---
//
// Before this change, a successful registration paid the referrer
// REFERRAL_SUCCESS (+100 XP, the largest single grant in the ledger)
// INSTANTLY, with no cap of any kind. Rate limits key on the request
// sender — the REFERRED wallet — so a sybil farm of N throwaway wallets
// arriving through one ?ref= link minted N*100 XP for the referrer with
// zero genuine activity required from the referred side.
//
// Now:
//   mpgrhub:referral:reward-pending:{referredWallet} -> {"referrer","createdAt"}
//       Written in the SAME atomic script as the attribution (so an
//       attribution can never exist without its pending record, and a
//       replayed registration can never overwrite or duplicate it).
//       Durable; consumed exactly once by the settle claim below.
//
//   mpgrhub:referral:activity:{referredWallet} -> "1"
//       Set by the XP route whenever the referred wallet earns a genuine
//       server-awarded activity event (daily check-in). Rewards are only
//       settled after this marker exists: a referral pays when the
//       referred wallet is a real, acting user — not merely a wallet that
//       signed one SIWE message.
//
//   mpgrhub:referral:rewarded:{referrerWallet}:{UTC-day} -> count
//       Per-referrer cap on REFERRAL REWARDS per day, checked and
//       incremented inside the claim script (atomic; concurrent settles
//       cannot race past it). Operational counter -> has a 48 h TTL.
//       The cap never blocks ATTRIBUTION, so honest users always keep
//       their referral credit; it throttles payouts only.
//
//   mpgrhub:referral:abuse:{subjectWallet}:{UTC-day} -> count
//       Operator-visible abuse counter (cap hits, self-referrals,
//       attribution-steal attempts). Operational -> 48 h TTL. Structured
//       log lines accompany each event (lib/observability/log.ts).
//
// Ledger-identity gate: settlement pays only into a referrer that
// already has an XP ledger record (mpgrhub:xp:total:{referrer} exists),
// so a referral request can no longer credit arbitrary, fabricated or
// zero addresses.
//
// Compatibility / migration:
// - Attribution key names and value formats are UNCHANGED; records
//   written by the previous version keep working, are still counted, and
//   can never be re-rewarded through a different code path.
// - A referral rewarded by the OLD immediate-pay path already created the
//   permanent ledger event key `mpgrhub:xp:event:{referrer}:referral:{referred}`;
//   settlement reuses that EXACT event id, so the ledger itself dedupes
//   across the deploy boundary (at-most-once is additionally guaranteed by
//   the single pending record).
// - Old clients (components/ReferralCapture.tsx, hooks/useReferralCount.ts)
//   are untouched: the POST body, response shapes and status codes are
//   byte-compatible; only the timing of the referrer's XP changes.
//
// Same env vars as lib/reward-allocation/kv-allocation-store.ts.

import { getRedis } from "@/lib/api/redis";
import { awardServerXP, xpTotalKey } from "@/lib/rewards/xp-ledger";
import { logApi } from "@/lib/observability/log";
import type { Address } from "viem";

const kv = () => getRedis();

function referralsSetKey(referrer: string) {
  return `mpgrhub:referral:referrals:${referrer}`;
}

function referredByKey(referred: string) {
  return `mpgrhub:referral:referredby:${referred}`;
}

function pendingRewardKey(referred: string) {
  return `mpgrhub:referral:reward-pending:${referred}`;
}

function referredActivityKey(referred: string) {
  return `mpgrhub:referral:activity:${referred}`;
}

function rewardedDayKey(referrer: string, day: string) {
  return `mpgrhub:referral:rewarded:${referrer}:${day}`;
}

function abuseDayKey(subject: string, day: string) {
  return `mpgrhub:referral:abuse:${subject}:${day}`;
}

function normalize(wallet: string): string {
  return wallet.toLowerCase();
}

function utcDayId(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Same event id the pre-Task-8 immediate path used, so the permanent
 *  ledger event key remains the single cross-version dedupe anchor. */
function referralEventId(referred: string): string {
  return `referral:${referred}`;
}

// Operational counters are day-scoped; a 48 h TTL always outlives their
// UTC day without ever becoming a replay risk (the durable event key is
// what enforces once-only payment).
const DAY_COUNTER_TTL_SECONDS = 60 * 60 * 48;

/** Referrer rewards per UTC day. Fail-closed: missing/invalid env uses
 *  the safe default; an absurd value is clamped, never treated as ∞. */
export const REFERRAL_REWARDS_PER_REFERRER_PER_DAY_DEFAULT = 5;
const REFERRAL_REWARDS_PER_REFERRER_PER_DAY_MAX = 1000;

export function getReferralDailyRewardCap(): number {
  const raw = process.env.REFERRAL_REWARDS_PER_REFERRER_PER_DAY;
  const n = raw ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return REFERRAL_REWARDS_PER_REFERRER_PER_DAY_DEFAULT;
  return Math.min(REFERRAL_REWARDS_PER_REFERRER_PER_DAY_MAX, Math.floor(n));
}

export type RegisterReferralResult =
  | { status: "registered"; referrer: string }
  | { status: "already-attributed"; referrer: string }
  | { status: "self-referral" }
  | { status: "invalid" };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Atomic first-write attribution + durable pending-reward record.
// KEYS: referredby, referrals set, reward-pending.
// ARGV: referrer (normalized), referred (normalized), pending JSON.
// Returns 1 when this call created the attribution, 0 when it already existed.
const REGISTER_REFERRAL_SCRIPT = `
local created = redis.call("SET", KEYS[1], ARGV[1], "NX")
if not created then return 0 end
redis.call("SADD", KEYS[2], ARGV[2])
redis.call("SET", KEYS[3], ARGV[3])
return 1
`;

// Atomic reward claim (Task 8 settlement gate).
// KEYS: reward-pending, referred activity marker, referrer XP-total,
//       referrer day counter, referrer abuse counter.
// ARGV: cap, day-counter TTL, abuse TTL.
// Returns 1 claim consumed, 0 nothing pending, -2 referred side not yet
// active, -3 referrer has no ledger record, -1 daily cap reached
// (the abuse counter is incremented inside the same script).
// The claim consumes the pending record BEFORE the JS side calls the
// ledger, so two racing settles can never both credit — the second is
// either "none" (pending gone) or ledger-deduped to "duplicate".
const CLAIM_REFERRAL_REWARD_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
if redis.call("EXISTS", KEYS[2]) == 0 then return -2 end
if redis.call("EXISTS", KEYS[3]) == 0 then return -3 end
local cur = redis.call("GET", KEYS[4])
local used = 0
if cur then used = tonumber(cur) end
if used >= tonumber(ARGV[1]) then
  redis.call("INCR", KEYS[5])
  if redis.call("TTL", KEYS[5]) < 0 then redis.call("EXPIRE", KEYS[5], tonumber(ARGV[3])) end
  return -1
end
local c = redis.call("INCR", KEYS[4])
if c == 1 then redis.call("EXPIRE", KEYS[4], tonumber(ARGV[2])) end
redis.call("DEL", KEYS[1])
return 1
`;

// Atomic INCR + (first-write) EXPIRE for abuse counters.
const BUMP_ABUSE_SCRIPT = `
local c = redis.call("INCR", KEYS[1])
if redis.call("TTL", KEYS[1]) < 0 then redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1])) end
return c
`;

interface PendingRewardRecord {
  referrer: string;
  createdAt: string;
}

export type ReferralSettleStatus =
  | "awarded"
  | "duplicate"
  | "none"
  | "not-eligible"
  | "unverified-referrer"
  | "daily-cap"
  | "error";

export interface ReferralSettleResult {
  status: ReferralSettleStatus;
  referred: string;
  referrer?: string;
}

function parsePending(raw: unknown): PendingRewardRecord | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.referrer !== "string" || !ADDRESS_RE.test(candidate.referrer)) return null;
  return { referrer: normalize(candidate.referrer), createdAt: String(candidate.createdAt ?? "") };
}

export const referralStore = {
  // Permanently associates `referred` -> referred by `referrer`, the
  // FIRST time it happens for this wallet, and only that time — and
  // writes the durable pending-reward record for the Task 8 settlement
  // gate in the same atomic script.
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
    const pendingRecord: PendingRewardRecord = {
      referrer,
      createdAt: new Date().toISOString(),
    };
    const setResult = await kv().eval(
      REGISTER_REFERRAL_SCRIPT,
      [referredByKey(referred), referralsSetKey(referrer), pendingRewardKey(referred)],
      [referrer, referred, JSON.stringify(pendingRecord)],
    );

    if (Number(setResult) !== 1) {
      const existing = await kv().get<string>(referredByKey(referred));
      return {
        status: "already-attributed",
        referrer: existing ?? referrer,
      };
    }

    return { status: "registered", referrer };
  },

  // Marks genuine activity for a wallet (called after a server-awarded
  // daily check-in). Durable one-bit marker; only ever widens eligibility
  // for an already-owned referral. Never throws: the check-in flow must
  // stay healthy even if Redis is down.
  async markReferredActivity(walletInput: string): Promise<void> {
    try {
      if (typeof walletInput !== "string" || !ADDRESS_RE.test(walletInput)) return;
      await kv().set(referredActivityKey(normalize(walletInput)), "1");
    } catch (error) {
      logApi("warn", "referral.activity-marker-failed", {
        wallet: walletInput,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  },

  // Attempts to settle a pending referral reward for `referred` against
  // the server XP ledger. All gates (genuine activity, referrer ledger
  // existence, per-referrer daily cap) are evaluated and consumed in ONE
  // atomic script. Never rejects: callers may fire-and-forget; the
  // structured status is returned for abuse logging.
  async settleReferralReward(referredInput: string): Promise<ReferralSettleResult> {
    const referred = typeof referredInput === "string" ? normalize(referredInput) : "";
    if (!ADDRESS_RE.test(referred)) return { status: "none", referred };
    try {
      const rawPending = await kv().get<unknown>(pendingRewardKey(referred));
      if (!rawPending) return { status: "none", referred };
      const pending = parsePending(rawPending);
      if (!pending) {
        // Corrupt/unparseable record: clean it, credit nobody, alert ops.
        try {
          await kv().del(pendingRewardKey(referred));
        } catch {
          /* best-effort cleanup */
        }
        logApi("warn", "referral.settle.corrupt-pending", { referred });
        return { status: "error", referred };
      }

      const day = utcDayId();
      const referrerTotalKey = xpTotalKey(pending.referrer);
      const claim = Number(
        await kv().eval(
          CLAIM_REFERRAL_REWARD_SCRIPT,
          [
            pendingRewardKey(referred),
            referredActivityKey(referred),
            referrerTotalKey,
            rewardedDayKey(pending.referrer, day),
            abuseDayKey(pending.referrer, day),
          ],
          [String(getReferralDailyRewardCap()), String(DAY_COUNTER_TTL_SECONDS), String(DAY_COUNTER_TTL_SECONDS)],
        ),
      );

      if (claim === 0) return { status: "none", referred, referrer: pending.referrer };
      if (claim === -2) return { status: "not-eligible", referred, referrer: pending.referrer };
      if (claim === -3) {
        logApi("warn", "referral.settle.unverified-referrer", {
          wallet: pending.referrer,
          referred,
        });
        return { status: "unverified-referrer", referred, referrer: pending.referrer };
      }
      if (claim === -1) {
        logApi("warn", "referral.reward.daily-cap", {
          wallet: pending.referrer,
          referred,
          cap: getReferralDailyRewardCap(),
        });
        return { status: "daily-cap", referred, referrer: pending.referrer };
      }
      if (claim !== 1) {
        // An unexpected script reply must NOT fall through to the award
        // path: anything other than an explicit consume is fail-closed.
        logApi("warn", "referral.settle.unexpected-claim", { referred, claim });
        return { status: "error", referred, referrer: pending.referrer };
      }

      // Claim consumed — award through the authoritative ledger. The
      // permanent event key makes this exactly-once even across replays,
      // concurrent settles, and the pre-Task-8 immediate-award path.
      try {
        const award = await awardServerXP(
          pending.referrer as Address,
          "REFERRAL_SUCCESS",
          referralEventId(referred),
        );
        await kv().del(pendingRewardKey(referred));
        return { status: award.awarded ? "awarded" : "duplicate", referred, referrer: pending.referrer };
      } catch (error) {
        // The ledger write failed: put the pending record back (NX — never
        // overwrites anything newer) so the next activity event retries.
        try {
          await kv().set(
            pendingRewardKey(referred),
            JSON.stringify({ ...pending, restoredAt: new Date().toISOString() }),
            { nx: true },
          );
        } catch {
          /* Redis is likely down for this too; retry-on-next-event stays best-effort. */
        }
        logApi("warn", "referral.settle.award-failed", {
          wallet: pending.referrer,
          referred,
          error: String(error instanceof Error ? error.message : error),
        });
        return { status: "error", referred, referrer: pending.referrer };
      }
    } catch (error) {
      logApi("warn", "referral.settle.redis-unavailable", {
        referred,
        error: String(error instanceof Error ? error.message : error),
      });
      return { status: "error", referred };
    }
  },

  // Counts a registration-time abuse signal (self-referral, attribution
  // steal attempts) for operator review. Never throws.
  async recordReferralAbuse(walletInput: string): Promise<void> {
    try {
      if (typeof walletInput !== "string" || !ADDRESS_RE.test(walletInput)) return;
      await kv().eval(
        BUMP_ABUSE_SCRIPT,
        [abuseDayKey(normalize(walletInput), utcDayId())],
        [String(DAY_COUNTER_TTL_SECONDS)],
      );
    } catch (error) {
      logApi("warn", "referral.abuse-counter-failed", {
        wallet: walletInput,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  },

  async getReferralCount(walletInput: string): Promise<number> {
    const wallet = normalize(walletInput);
    return kv().scard(referralsSetKey(wallet));
  },

  async getReferrer(walletInput: string): Promise<string | null> {
    const wallet = normalize(walletInput);
    const referrer = await kv().get<string>(referredByKey(wallet));
    return referrer ?? null;
  },
};
