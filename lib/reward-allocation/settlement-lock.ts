import { getRedis } from "@/lib/api/redis";
import { randomUUID } from "node:crypto";

const redis = () => getRedis();

// Settlement consumes one shared on-chain reward-vault balance and one shared
// GAME treasury budget. Therefore the mutex must be global, not week-scoped:
// two different weeks settling concurrently could otherwise both observe the
// same remaining budget/balance and submit overlapping allocations.
const LOCK_KEY = "mpgrhub:settlement:lock:global";
const LOCK_TTL_SECONDS = 300;

export async function withSettlementLock<T>(
  weekKey: string,
  fn: () => Promise<T>,
): Promise<T | { locked: true; weekKey: string }> {
  const value = randomUUID();
  const acquired = await redis().set(LOCK_KEY, value, { nx: true, ex: LOCK_TTL_SECONDS });
  if (acquired === null) return { locked: true, weekKey };

  try {
    return await fn();
  } finally {
    await redis().eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`,
      [LOCK_KEY],
      [value],
    );
  }
}
