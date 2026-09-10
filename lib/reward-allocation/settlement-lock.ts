import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
if (!url || !token) throw new Error("Upstash Redis environment variables are missing.");
const redis = new Redis({ url, token });
export async function withSettlementLock<T>(weekKey: string, fn: () => Promise<T>): Promise<T | { locked: true; weekKey: string }> {
  const key = `mpgrhub:settlement:lock:${weekKey}`;
  const value = randomUUID();
  const acquired = await redis.set(key, value, { nx: true, ex: 120 });
  if (acquired === null) return { locked: true, weekKey };
  try { return await fn(); }
  finally { await redis.eval(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`, [key], [value]); }
}
