import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  throw new Error("Upstash Redis environment variables are missing.");
}

export const authRedis = new Redis({ url, token });

export async function consumeAuthNonce(nonce: string): Promise<boolean> {
  const result = await authRedis.eval(`local v = redis.call("GET", KEYS[1]); if v == "unused" then redis.call("DEL", KEYS[1]); return 1 else return 0 end`, [`mpgrhub:auth:nonce:${nonce}`], []);
  return Number(result) === 1;
}
