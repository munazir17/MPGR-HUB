import "server-only";

// lib/autonomy/delegated-redis-store.ts
//
// Production DelegatedAuthorizationStore over the EXISTING Redis seam
// (lib/api/redis.ts — the same instance as sessions / the autonomy store),
// in the collision-free `mpgrhub:autonomy:*` namespace. Follows the exact
// patterns of lib/autonomy/redis-store.ts:
//
//   * CAS via a tiny Lua script that compares SCALARS kept in a per-record
//     "meta" string (wallet|status) — no JSON parsing inside Lua. This is
//     what makes concurrent slot consumption safe: exactly ONE of N racers
//     can flip `active` to `consumed`.
//   * A per-wallet Permit2 nonce registry (`SET … NX`) rejects a reused
//     nonce across requests/processes atomically. Nonce keys carry a TTL
//     bounded by the slot deadline (a nonce cannot be replayed after its
//     authorization expired anyway).
//   * Fail-closed: Redis unavailability THROWS; callers treat that as
//     "cannot proceed" — never "proceed unguarded".
//
// No secret is ever written beyond what the record type itself holds (the
// user-signed authorization bytes REQUIRED to broadcast the user's own
// authorization — never logged, never returned by any API view).

import { getRedis } from "@/lib/api/redis";

import type { DelegatedAuthorizationSlot, DelegatedAuthorizationStore } from "./delegated-authorization";

const PREFIX = "mpgrhub:autonomy";

const KEY = {
  slot: (id: string) => `${PREFIX}:slot:${id}`,
  slotMeta: (id: string) => `${PREFIX}:slot-meta:${id}`,
  walletSlots: (wallet: string) => `${PREFIX}:${wallet}:slots`,
  /** permit2 nonce registry — value is the slot id; NX makes reuse impossible. */
  nonce: (wallet: string, nonce: string) => `${PREFIX}:slot-nonce:${wallet}:${nonce}`,
};

type SlotStatus = "active" | "consumed" | "revoked";
const statusOf = (s: DelegatedAuthorizationSlot): SlotStatus =>
  s.revokedAt ? "revoked" : s.consumedAt ? "consumed" : "active";

// Meta: "<wallet>|<status>" — both components are guaranteed "|" free
// (lowercase hex addresses / fixed status words).
const metaOf = (s: DelegatedAuthorizationSlot) => `${s.wallet.toLowerCase()}|${statusOf(s)}`;
const parseMeta = (meta: string) => {
  const [wallet = "", status = ""] = meta.split("|");
  return { wallet, status: status as SlotStatus };
};

/**
 * CAS slot consumption. Compares wallet + current status; only an ACTIVE
 * slot owned by the caller can flip to consumed. Returns nil on mismatch.
 * N concurrent racers → exactly one non-nil result.
 */
const CAS_CONSUME_SCRIPT = `
local meta = redis.call("GET", KEYS[2])
if not meta then return nil end
local wallet, status = string.match(meta, "^(.-)|(.+)$")
if wallet ~= ARGV[1] then return nil end
if status ~= "active" then return nil end
redis.call("SET", KEYS[1], ARGV[2])
redis.call("SET", KEYS[2], wallet .. "|consumed")
return ARGV[2]
`;

/** CAS slot revocation: wallet must match and the slot must not be revoked yet. */
const CAS_REVOKE_SCRIPT = `
local meta = redis.call("GET", KEYS[2])
if not meta then return nil end
local wallet, status = string.match(meta, "^(.-)|(.+)$")
if wallet ~= ARGV[1] then return nil end
if status == "revoked" then return nil end
redis.call("SET", KEYS[1], ARGV[2])
redis.call("SET", KEYS[2], wallet .. "|revoked")
return ARGV[2]
`;

const ZADD_MEMBER_SCRIPT = `redis.call("ZINCRBY", KEYS[1], 0, ARGV[1]) return 1`;
const ZRANGE_ALL = `return redis.call("ZRANGE", KEYS[1], 0, -1)`;

type Raw = string | Record<string, unknown> | null;

function parseRecord<T>(raw: Raw): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

/** Nonce-registry TTL: the longest a Permit2 deadline may legally run (policy TTL ceiling). */
const NONCE_TTL_SECONDS = 31 * 86_400;

export class RedisDelegatedAuthorizationStore implements DelegatedAuthorizationStore {
  private redis() {
    return getRedis();
  }

  async saveSlots(slots: DelegatedAuthorizationSlot[]): Promise<number> {
    const redis = this.redis();
    for (const slot of slots) {
      const nonceKey = KEY.nonce(slot.wallet.toLowerCase(), slot.permit.nonce);
      // NX claim FIRST: a reused nonce is refused atomically, before any
      // record is written (requirement: one Permit2 nonce, one slot, ever).
      const claimed = await redis.set(nonceKey, slot.id, { ex: NONCE_TTL_SECONDS, nx: true });
      if (claimed === null) throw new Error("duplicate permit nonce");
      try {
        await redis.set(KEY.slot(slot.id), JSON.stringify(slot));
        await redis.set(KEY.slotMeta(slot.id), metaOf(slot));
        await redis.eval(ZADD_MEMBER_SCRIPT, [KEY.walletSlots(slot.wallet.toLowerCase())], [slot.id]);
      } catch (error) {
        await redis.del(nonceKey).catch(() => {});
        throw error;
      }
    }
    return slots.length;
  }

  async listSlots(wallet: string, policyId?: string): Promise<DelegatedAuthorizationSlot[]> {
    const ids = await this.zmembers(KEY.walletSlots(wallet.toLowerCase()));
    const out: DelegatedAuthorizationSlot[] = [];
    for (const id of ids) {
      const slot = await this.getSlot(id, wallet);
      if (slot && (!policyId || slot.policyId === policyId)) out.push(slot);
    }
    return out.sort((a, b) => a.slotIndex - b.slotIndex);
  }

  async getSlot(id: string, wallet: string): Promise<DelegatedAuthorizationSlot | null> {
    if (!/^[a-zA-Z0-9_.-]{4,120}$/.test(id)) return null;
    const slot = parseRecord<DelegatedAuthorizationSlot>(await this.redis().get(KEY.slot(id)));
    if (!slot || slot.wallet.toLowerCase() !== wallet.toLowerCase()) return null;
    return slot;
  }

  async markConsumed(id: string, wallet: string, txHash: string, at: string): Promise<boolean> {
    const current = await this.getSlot(id, wallet);
    if (!current) return false;
    const consumed: DelegatedAuthorizationSlot = { ...current, consumedAt: at, consumedByTxHash: txHash };
    const result = await this.redis().eval(
      CAS_CONSUME_SCRIPT,
      [KEY.slot(id), KEY.slotMeta(id)],
      [wallet.toLowerCase(), JSON.stringify(consumed)],
    );
    return typeof result === "string";
  }

  async markRevoked(id: string, wallet: string, at: string): Promise<boolean> {
    const current = await this.getSlot(id, wallet);
    if (!current) return false;
    const revoked: DelegatedAuthorizationSlot = { ...current, revokedAt: at };
    const result = await this.redis().eval(
      CAS_REVOKE_SCRIPT,
      [KEY.slot(id), KEY.slotMeta(id)],
      [wallet.toLowerCase(), JSON.stringify(revoked)],
    );
    return typeof result === "string";
  }

  private async zmembers(key: string): Promise<string[]> {
    const members = await this.redis().eval(ZRANGE_ALL, [key], []);
    return Array.isArray(members) ? (members as string[]) : [];
  }
}
