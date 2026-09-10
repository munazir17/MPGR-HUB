import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) return redis;

  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Upstash Redis environment variables are missing. Expected UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }

  redis = new Redis({ url, token });
  return redis;
}
